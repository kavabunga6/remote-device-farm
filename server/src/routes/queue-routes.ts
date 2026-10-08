import { uiMessage } from '../messages.js';
import { assertUserActive } from '../user-removal.js';
import { hostGpuBackend } from '../gpu-modes.js';
import { assertLaunchOverridesAllowed } from '../launch-permissions.js';
import { assertHostLaunchOptions, assertLaunchOptionsAccess, mergeLaunchStorage, resolveLaunchOptions } from '../launch-options.js';
import { assertProfileHostArchitecture } from '../profile-host.js';
import { parseStorageRequest } from '../storage.js';
import { parseRequestedGpuMode, resolveProfileLaunch } from '../profile-launch.js';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Express } from 'express';
import { recordAuditEvent } from '../audit.js';
import { transaction } from '../db.js';
import { ApiError, boundedString, isUuid, route } from '../http-common.js';
import { configureNotifications, currentWebhookPolicy, markNotificationsRead, NOTIFICATION_KINDS, unreadNotifications, type NotificationKind } from '../notifications.js';
import { MAX_QUEUE_ENTRIES_PER_USER, queuePosition, startQueueDispatcher, type QueueDispatcher } from '../queue-dispatcher.js';
import type { ServerContext } from '../server-context.js';
import { assertProfileAllowed } from '../session-policy.js';
import { parseSessionAdbKeyId, selectedAdbKey } from '../user-adb-keys.js';
import { parseLeaseTtlSeconds } from '../session-lease.js';
import { parseProfileSelector, selectProfileId } from '../profile-selector.js';
import { deliverWebhook, parseWebhookUrl, WebhookUrlError } from '../webhooks.js';

const MAX_WEBHOOKS_PER_USER = 5;
const testedAt = new Map<string, number>();

function parseEvents(value: unknown): NotificationKind[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > NOTIFICATION_KINDS.length ||
      !value.every(item => typeof item === 'string' && (NOTIFICATION_KINDS as readonly string[]).includes(item))) {
    throw new ApiError(400, 'invalid_events', uiMessage('ui.cee821559c45', {}, 'en'));
  }
  return [...new Set(value as NotificationKind[])];
}

function webhookUrl(value: unknown): string {
  try { return parseWebhookUrl(value, currentWebhookPolicy()).toString(); }
  catch (error) {
    if (error instanceof WebhookUrlError) throw new ApiError(400, 'invalid_webhook_url', error.message);
    throw error;
  }
}

function hookJson(row: Record<string, unknown>) {
  return {
    id: String(row.id), url: String(row.url), events: row.events as string[], enabled: row.enabled === true,
    lastStatus: row.last_status ? String(row.last_status) : null,
    lastAttemptAt: row.last_attempt_at ? new Date(String(row.last_attempt_at)).toISOString() : null,
    createdAt: new Date(String(row.created_at)).toISOString(),
  };
}

// A claimed queue entry has a stable future session id, even before its session row commits.
function queueEntryJson(row: Record<string, unknown>, position = 0) {
  const state = row.state === 'assigned' && !row.resolved_at && !row.session_state ? 'assigning' : row.state;
  return {
    id: String(row.id), state,
    profileId: String(row.profile_id), profileName: row.profile_name == null ? null : String(row.profile_name),
    hostId: row.host_id == null ? null : String(row.host_id), hostName: row.host_name == null ? null : String(row.host_name),
    label: row.label == null ? null : String(row.label),
    launchOptions: row.launch_options ?? {},
    diskGb: row.disk_gb == null ? null : Number(row.disk_gb),
    sdcardGb: row.sdcard_gb == null ? null : Number(row.sdcard_gb),
    gpuMode: row.gpu_mode === 'nvidia' ? 'nvidia' : row.gpu_mode === 'software' ? 'software' : null,
    adbKeyId: row.adb_key_id == null ? null : String(row.adb_key_id),
    leaseTtlSeconds: row.lease_ttl_seconds == null ? null : Number(row.lease_ttl_seconds),
    sessionId: row.session_id == null ? null : String(row.session_id),
    sessionState: row.session_state ?? (row.state === 'assigned' && row.resolved_at ? 'released' : null),
    createdAt: new Date(String(row.created_at)).toISOString(), expiresAt: new Date(String(row.expires_at)).toISOString(),
    resolvedAt: row.resolved_at == null ? null : new Date(String(row.resolved_at)).toISOString(),
    position: state === 'waiting' ? position : 0,
    error: row.error_code == null ? null : { code: String(row.error_code) },
  };
}

const QUEUE_ENTRY_SELECT = `SELECT q.*,p.name AS profile_name,COALESCE(h.display_name,h.name) AS host_name,s.state AS session_state
  FROM queue_entries q JOIN profiles p ON p.id=q.profile_id LEFT JOIN hosts h ON h.id=q.host_id
  LEFT JOIN sessions s ON s.id=q.session_id`;

// Waiting list, notifications and webhooks. The dispatcher starts here unless disabled (tests).
export function registerQueueRoutes(app: Express, context: ServerContext, options: { startDispatcher?: boolean } = {}): QueueDispatcher | null {
  const { pool, requireAuth, current, config } = context;
  configureNotifications(config);
  const dispatcher = options.startDispatcher === false ? null : startQueueDispatcher({
    pool, hub: context.hub, config, policy: context.policy,
  });

  const readEntry = async (id: string, userId: string) => {
    const found = await pool.query(`${QUEUE_ENTRY_SELECT} WHERE q.id=$1 AND q.user_id=$2`, [id, userId]);
    if (!found.rows[0]) throw new ApiError(404, 'not_found', uiMessage('ui.b378679dce8d', {}, 'en'));
    const waiting = found.rows[0].state === 'waiting'
      ? await pool.query("SELECT id,host_id FROM queue_entries WHERE state='waiting' ORDER BY created_at,id") : { rows: [] };
    return queueEntryJson(found.rows[0], queuePosition(waiting.rows.map(row => ({ id: String(row.id), hostId: row.host_id ? String(row.host_id) : null })), id));
  };

  app.get('/api/queue', requireAuth, route(async (_req, res) => {
    const user = current(res).user;
    const all = await pool.query(`${QUEUE_ENTRY_SELECT} WHERE q.state='waiting' ORDER BY q.created_at,q.id`);
    const waiting = all.rows.map(row => ({ id: String(row.id), hostId: row.host_id ? String(row.host_id) : null }));
    res.json({ entries: all.rows.filter(row => String(row.user_id) === user.id)
      .map(row => queueEntryJson(row, queuePosition(waiting, String(row.id)))), maxEntries: MAX_QUEUE_ENTRIES_PER_USER });
  }));

  app.get('/api/queue/:id', requireAuth, route(async (req, res) => {
    const id = String(req.params.id);
    if (!isUuid(id)) throw new ApiError(404, 'not_found', uiMessage('ui.b378679dce8d', {}, 'en'));
    res.json(await readEntry(id, current(res).user.id));
  }));

  app.post('/api/queue', requireAuth, route(async (req, res) => {
    const user = current(res).user;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const profileId = body.profileId === undefined && body.profile !== undefined
      ? await selectProfileId(pool, user, parseProfileSelector(body.profile))
      : boundedString(body.profileId, 100);
    const requestedGpuMode = parseRequestedGpuMode(body.gpuMode);
    const launchOptions = mergeLaunchStorage(body.launchOptions, parseStorageRequest(body));
    assertLaunchOptionsAccess(launchOptions, user);
    const requestedAdbKeyId = body.adbKeyId === undefined ? undefined : parseSessionAdbKeyId(body.adbKeyId);
    const leaseTtlSeconds = parseLeaseTtlSeconds(body.leaseTtlSeconds);
    const requestKey = req.get('Idempotency-Key');
    if (requestKey !== undefined && !/^[A-Za-z0-9._:-]{1,128}$/.test(requestKey)) {
      throw new ApiError(400, 'invalid_idempotency_key', uiMessage('ui.23b8aa473fe1', {}, 'en'));
    }
    const hostId = body.hostId === undefined || body.hostId === null || body.hostId === '' ? null : boundedString(body.hostId, 100);
    if (!profileId || (body.hostId !== undefined && body.hostId !== null && body.hostId !== '' && !hostId)) {
      throw new ApiError(400, 'invalid_queue_entry', uiMessage('ui.e5e582bcdf15', {}, 'en'));
    }
    if (body.label !== undefined && body.label !== null && (typeof body.label !== 'string' || body.label.length > 60 || /[\x00-\x1f\x7f]/.test(body.label))) {
      throw new ApiError(400, 'invalid_queue_entry', uiMessage('ui.9d56f9147f6e', {}, 'en'));
    }
    const label = typeof body.label === 'string' && body.label.trim() ? body.label.trim() : null;
    const id = randomUUID();
    const fingerprint = createHash('sha256').update(JSON.stringify({ profileId, hostId, label,
      gpuMode: requestedGpuMode ?? 'default', adbKeyId: requestedAdbKeyId === undefined ? 'default' : requestedAdbKeyId,
      leaseTtlSeconds: leaseTtlSeconds ?? null, ...(Object.keys(launchOptions).length ? { launchOptions } : {}) })).digest('hex');
    const queued = await transaction(pool, async client => {
      await assertUserActive(client, user.id);
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['queue:' + user.id]);
      if (requestKey !== undefined) {
        const prior = await client.query('SELECT id,request_fingerprint FROM queue_entries WHERE user_id=$1 AND request_key=$2', [user.id, requestKey]);
        if (prior.rows[0]) {
          if (prior.rows[0].request_fingerprint !== fingerprint) throw new ApiError(409, 'idempotency_conflict', uiMessage('ui.56a9d3126681', {}, 'en'));
          return { id: String(prior.rows[0].id), created: false };
        }
      }
      const preferred = requestedAdbKeyId === undefined
        ? await client.query('SELECT default_adb_key_id FROM user_preferences WHERE user_id=$1', [user.id]) : null;
      const adbKeyId = requestedAdbKeyId === undefined ? (preferred?.rows[0]?.default_adb_key_id as string | undefined) ?? null : requestedAdbKeyId;
      await selectedAdbKey(client, user.id, adbKeyId);
      await assertProfileAllowed(client, user, profileId);
      const profile = await client.query('SELECT * FROM profiles WHERE id=$1 AND enabled=true FOR SHARE', [profileId]);
      if (!profile.rowCount) throw new ApiError(404, 'profile_not_found', uiMessage('ui.999930725d06', {}, 'en'));
      await assertLaunchOverridesAllowed(client, user, profile.rows[0]!, launchOptions);
      const resolvedOptions = resolveLaunchOptions(profile.rows[0]!, launchOptions, user);
      const launch = resolveProfileLaunch({ ...profile.rows[0]!, memory_mb: resolvedOptions.memoryMb }, requestedGpuMode);
      if (hostId) {
        const host = await client.query('SELECT id,metrics,slot_cpu,slot_memory_mb FROM hosts WHERE id=$1 AND removed_at IS NULL', [hostId]);
        if (!host.rowCount) throw new ApiError(404, 'host_not_found', uiMessage('ui.b7a0091f953e', {}, 'en'));
        assertProfileHostArchitecture(profile.rows[0]!, host.rows[0].metrics ?? {});
        assertHostLaunchOptions(launchOptions, host.rows[0].metrics ?? {});
        if (launch.gpuMode === 'nvidia' && !hostGpuBackend(host.rows[0]?.metrics)) {
          throw new ApiError(409, 'gpu_unavailable', uiMessage('ui.f6db63e49d3b', {}, 'en'));
        }
        if (resolvedOptions.cpu > Number(host.rows[0].slot_cpu) || launch.memoryMb > Number(host.rows[0].slot_memory_mb)) {
          throw new ApiError(409, 'profile_too_large', uiMessage('ui.5ae180683b19', {}, 'en'));
        }
      }
      const count = await client.query("SELECT count(*)::integer AS total FROM queue_entries WHERE user_id=$1 AND (state='waiting' OR (state='assigned' AND resolved_at IS NULL))", [user.id]);
      if (Number(count.rows[0]?.total || 0) >= MAX_QUEUE_ENTRIES_PER_USER) {
        throw new ApiError(409, 'queue_full', uiMessage('ui.6c148d99dd3d', { p0: MAX_QUEUE_ENTRIES_PER_USER }, 'en'));
      }
      await client.query(
        `INSERT INTO queue_entries(id,user_id,profile_id,host_id,label,expires_at,gpu_mode,adb_key_id,request_key,request_fingerprint,lease_ttl_seconds,launch_options,disk_gb,sdcard_gb)
         VALUES($1,$2,$3,$4,$5,now() + make_interval(mins => $6::integer),$7,$8,$9,$10,$11,$12,$13,$14)`,
        [id, user.id, profileId, hostId, label, config.queueTtlMinutes, launch.gpuMode, adbKeyId, requestKey ?? null, fingerprint, leaseTtlSeconds ?? null, resolvedOptions, resolvedOptions.diskGb, resolvedOptions.sdCardMb / 1024],
      );
      return { id, created: true };
    });
    if (queued.created) await recordAuditEvent(pool, { action: 'queue.joined', actor: user, targetType: 'queue', targetId: queued.id }).catch(() => {});
    dispatcher?.trigger();
    res.status(queued.created ? 201 : 200).json(await readEntry(queued.id, user.id));
  }));

  app.delete('/api/queue/:id', requireAuth, route(async (req, res) => {
    const user = current(res).user;
    const id = String(req.params.id);
    if (!isUuid(id)) throw new ApiError(404, 'not_found', uiMessage('ui.b378679dce8d', {}, 'en'));
    // This update races atomically with the dispatcher's conditional claim. If assignment won,
    // return the stable request and session id so clients can release the device instead.
    const result = await pool.query(
      "UPDATE queue_entries SET state='cancelled',resolved_at=now() WHERE id=$1 AND user_id=$2 AND state='waiting' RETURNING id", [id, user.id],
    );
    const entry = await readEntry(id, user.id);
    if (result.rowCount) await recordAuditEvent(pool, { action: 'queue.cancelled', actor: user, targetType: 'queue', targetId: id }).catch(() => {});
    if (entry.state === 'assigning' || entry.state === 'assigned') {
      res.status(409).json({ error: { code: 'queue_already_assigned', message: 'Assignment has started; release the session identified by this queue entry' }, entry });
      return;
    }
    res.json(entry);
  }));

  app.get('/api/me/notifications', requireAuth, route(async (_req, res) => {
    res.json({ notifications: await unreadNotifications(pool, current(res).user.id) });
  }));

  app.post('/api/me/notifications/read', requireAuth, route(async (req, res) => {
    const ids = (req.body ?? {}).ids as unknown;
    if (ids !== undefined && (!Array.isArray(ids) || ids.length > 100 || !ids.every(item => typeof item === 'string' && isUuid(item)))) {
      throw new ApiError(400, 'invalid_ids', uiMessage('ui.a86dbe3b05e7', {}, 'en'));
    }
    res.json({ marked: await markNotificationsRead(pool, current(res).user.id, ids as string[] | undefined) });
  }));

  app.get('/api/me/webhooks', requireAuth, route(async (_req, res) => {
    const { rows } = await pool.query('SELECT id,url,events,enabled,last_status,last_attempt_at,created_at FROM webhooks WHERE user_id=$1 ORDER BY created_at', [current(res).user.id]);
    res.json({ webhooks: rows.map(hookJson), events: NOTIFICATION_KINDS });
  }));

  app.post('/api/me/webhooks', requireAuth, route(async (req, res) => {
    const user = current(res).user;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const url = webhookUrl(body.url);
    const events = parseEvents(body.events);
    if (body.secret !== undefined && body.secret !== null && body.secret !== '' &&
        (typeof body.secret !== 'string' || body.secret.length < 8 || body.secret.length > 200)) {
      throw new ApiError(400, 'invalid_secret', uiMessage('ui.25ed55816a7d', {}, 'en'));
    }
    // A secret is always set, so every payload is signed. It is shown only in this response.
    const secret = typeof body.secret === 'string' && body.secret ? body.secret : randomBytes(24).toString('hex');
    const id = randomUUID();
    const created = await transaction(pool, async client => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['webhooks:' + user.id]);
      const count = await client.query('SELECT count(*)::integer AS total FROM webhooks WHERE user_id=$1', [user.id]);
      if (Number(count.rows[0]?.total || 0) >= MAX_WEBHOOKS_PER_USER) {
        throw new ApiError(409, 'webhook_limit', uiMessage('ui.821db2f18c13', { p0: MAX_WEBHOOKS_PER_USER }, 'en'));
      }
      return client.query(
        'INSERT INTO webhooks(id,user_id,url,secret,events) VALUES($1,$2,$3,$4,$5) RETURNING id,url,events,enabled,last_status,last_attempt_at,created_at',
        [id, user.id, url, secret, events],
      );
    });
    await recordAuditEvent(pool, { action: 'webhook.created', actor: user, targetType: 'webhook', targetId: id }).catch(() => {});
    res.status(201).json({ ...hookJson(created.rows[0]!), secret });
  }));

  app.patch('/api/me/webhooks/:id', requireAuth, route(async (req, res) => {
    const user = current(res).user;
    const id = String(req.params.id);
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (!isUuid(id)) throw new ApiError(404, 'not_found', uiMessage('ui.b15fd2789336', {}, 'en'));
    if (body.enabled !== undefined && typeof body.enabled !== 'boolean') throw new ApiError(400, 'invalid_webhook', uiMessage('ui.1fa0375b158e', {}, 'en'));
    const events = body.events === undefined ? null : parseEvents(body.events);
    const result = await pool.query(
      `UPDATE webhooks SET enabled=COALESCE($3,enabled),events=COALESCE($4,events) WHERE id=$1 AND user_id=$2
       RETURNING id,url,events,enabled,last_status,last_attempt_at,created_at`,
      [id, user.id, body.enabled ?? null, events],
    );
    if (!result.rowCount) throw new ApiError(404, 'not_found', uiMessage('ui.b15fd2789336', {}, 'en'));
    res.json(hookJson(result.rows[0]!));
  }));

  app.delete('/api/me/webhooks/:id', requireAuth, route(async (req, res) => {
    const user = current(res).user;
    const id = String(req.params.id);
    if (!isUuid(id)) throw new ApiError(404, 'not_found', uiMessage('ui.b15fd2789336', {}, 'en'));
    const result = await pool.query('DELETE FROM webhooks WHERE id=$1 AND user_id=$2 RETURNING id', [id, user.id]);
    if (!result.rowCount) throw new ApiError(404, 'not_found', uiMessage('ui.b15fd2789336', {}, 'en'));
    await recordAuditEvent(pool, { action: 'webhook.deleted', actor: user, targetType: 'webhook', targetId: id }).catch(() => {});
    res.status(204).end();
  }));

  app.post('/api/me/webhooks/:id/test', requireAuth, route(async (req, res) => {
    const user = current(res).user;
    const id = String(req.params.id);
    if (!isUuid(id)) throw new ApiError(404, 'not_found', uiMessage('ui.b15fd2789336', {}, 'en'));
    const last = testedAt.get(user.id) ?? 0;
    if (Date.now() - last < 3_000) throw new ApiError(429, 'too_many_attempts', uiMessage('ui.d11666d7593b', {}, 'en'));
    testedAt.set(user.id, Date.now());
    if (testedAt.size > 1000) for (const [key, at] of testedAt) if (Date.now() - at > 60_000) testedAt.delete(key);
    const { rows } = await pool.query('SELECT id,url,secret FROM webhooks WHERE id=$1 AND user_id=$2', [id, user.id]);
    if (!rows[0]) throw new ApiError(404, 'not_found', uiMessage('ui.b15fd2789336', {}, 'en'));
    const result = await deliverWebhook(
      { id, url: String(rows[0].url), secret: String(rows[0].secret) },
      { id: randomUUID(), event: 'webhook.test', createdAt: new Date().toISOString(), text: uiMessage('ui.ed860bb4d295'), data: {} },
      { policy: currentWebhookPolicy(), retries: 0 },
    );
    await pool.query('UPDATE webhooks SET last_status=$2,last_attempt_at=now() WHERE id=$1',
      [id, result.ok ? 'ok' : result.status ? `http_${result.status}` : 'error']).catch(() => {});
    res.json({ ok: result.ok, status: result.status, error: result.error ?? null });
  }));

  return dispatcher;
}
