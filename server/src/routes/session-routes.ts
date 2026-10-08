import { hasPermission } from '../permissions.js';
import { uiMessage } from '../messages.js';
import { mergeLaunchStorage } from '../launch-options.js';
import { parseLeaseTtlSeconds, renewSessionLease } from '../session-lease.js';
import type { Express, Request, Response, RequestHandler } from 'express';
import { parseStorageRequest } from '../storage.js';
import multer from 'multer';
import { newToken, tokenHash } from '../auth.js';
import { parseSessionAdbKeyId } from '../user-adb-keys.js';
import type { ServerContext } from '../server-context.js';
import { ApiError, boundedString, inputParams, route, safeUploadName, sessionJson,
         type Session } from '../http-common.js';
import { withDeadlines } from '../session-lifecycle.js';
import { parseRequestedGpuMode } from '../profile-launch.js';
import { createSession } from '../session-create.js';
import { createDeviceSession, parseDeviceKind } from '../device-session.js';
import { accessibleSession } from '../session-access.js';
import { parseProfileSelector, selectProfileId } from '../profile-selector.js';

export function registerSessionRoutes(app: Express, context: ServerContext): void {
  const { pool, hub, requireAuth, current, ownedSession, sessionQuery, activity, policy } = context;
  app.get('/api/sessions', requireAuth, route(async (_req, res) => {
    const context = current(res);
    const values: unknown[] = [];
    let sql = sessionQuery + " WHERE s.state IN ('starting','running','stopping')";
    if (!hasPermission(context.user, 'sessions.viewAll')) { sql += ' AND s.owner_user_id=$1'; values.push(context.user.id); }
    sql += ' ORDER BY s.created_at DESC LIMIT 500';
    const { rows } = await pool.query(sql, values);
    res.json({ sessions: rows.map(row => withDeadlines(sessionJson(row), policy)) });
  }));
  app.get('/api/sessions/:id', requireAuth, route(async (req, res) => {
    const { session, access } = await accessibleSession(context, req.params.id!, current(res), 'view');
    if (access === 'view' || access === 'control') { res.json({ session: { ...session, adminAccess: null, access } }); return; }
    // The owner is told when an administrator has looked at the session.
    let adminAccess: { username: string; at: string } | null = null;
    if (session.ownerId === current(res).user.id) {
      const { rows } = await pool.query(
        `SELECT actor_username,occurred_at FROM audit_events
         WHERE action='session.admin_access' AND target_type='session' AND target_id=$1
         ORDER BY id DESC LIMIT 1`, [session.id],
      );
      if (rows[0]) adminAccess = { username: String(rows[0].actor_username || ''), at: new Date(String(rows[0].occurred_at)).toISOString() };
    }
    res.json({ session: { ...session, adminAccess, access } });
  }));
  app.post('/api/sessions', requireAuth, route(async (req, res) => {
    const deviceKind = parseDeviceKind(req.body?.deviceKind);
    const launchOptions = mergeLaunchStorage(req.body?.launchOptions, parseStorageRequest(req.body));
    const leaseTtlSeconds = parseLeaseTtlSeconds(req.body?.leaseTtlSeconds);
    if (deviceKind) {
      if (Object.keys(launchOptions).length) throw new ApiError(400, 'invalid_launch_options', uiMessage('ui.cf17c28908df', {}, 'en'));
      const hostId = boundedString(req.body?.hostId, 100);
      const deviceId = boundedString(req.body?.deviceId, 100);
      if (!hostId || !deviceId) throw new ApiError(400, 'invalid_request', uiMessage('ui.861a97f361fd', {}, 'en'));
      const rawLabel = req.body?.label;
      const label = typeof rawLabel === 'string' ? rawLabel.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 60) || null : null;
      const id = await createDeviceSession(context, current(res).user, { hostId, kind: deviceKind, deviceId, label, leaseTtlSeconds });
      res.status(202).json({ session: await ownedSession(id, current(res)) });
      return;
    }
    const hostId = boundedString(req.body?.hostId, 100);
    // Automation may ask for a kind of device instead of a profile id: {"profile": {"android": "14", "deviceType": "tv"}}.
    const profileId = req.body?.profileId === undefined && req.body?.profile !== undefined
      ? await selectProfileId(pool, current(res).user, parseProfileSelector(req.body.profile))
      : boundedString(req.body?.profileId, 80);
    if (!hostId || !profileId) throw new ApiError(400, 'invalid_request', uiMessage('ui.097371ad9891', {}, 'en'));
    const gpuMode = parseRequestedGpuMode(req.body?.gpuMode);
    const requestedAdbKeyId = req.body?.adbKeyId === undefined ? undefined : parseSessionAdbKeyId(req.body.adbKeyId);
    const rawLabel = req.body?.label;
    const label = typeof rawLabel === 'string' ? rawLabel.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 60) || null : null;
    const id = await createSession(context, current(res).user, { hostId, profileId, gpuMode, launchOptions, adbKeyId: requestedAdbKeyId, label, leaseTtlSeconds });
    res.status(202).json({ session: await ownedSession(id, current(res)) });
  }));

  async function stopSession(req: Request, res: Response, force: boolean): Promise<void> {
    const context = current(res);
    if (force && !hasPermission(context.user, 'sessions.manageAll')) throw new ApiError(403, 'forbidden', uiMessage('ui.031cc7a3ec82', {}, 'en'));
    const session = await ownedSession(req.params.id!, context);
    if (['stopped', 'failed'].includes(session.state)) {
      await hub.releaseSession(session.id);
      res.json({ ok: true, id: session.id, released: true });
      return;
    }
    // Persist acceptance before responding. A process restart or disconnected
    // agent can recover this request from the stopping row on hello/heartbeat.
    await pool.query(`UPDATE sessions SET state='stopping' WHERE id=$1 AND state IN ('starting','running')`, [session.id]);
    hub.stopSession(session.hostId, session.id, force || session.state === 'starting');
    res.status(202).json({ ok: true, id: session.id, accepted: true, released: false });
  }
  app.delete('/api/sessions/:id', requireAuth, route(async (req, res) => {
    await stopSession(req, res, false);
  }));
  app.post('/api/sessions/:id/kill', requireAuth, route(async (req, res) => {
    await stopSession(req, res, true);
  }));

  const upload = multer({
    storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024, files: 1, fields: 4, parts: 5, fieldNameSize: 100, fieldSize: 4096, fieldArrayIndexLimit: 0 },
  });
  const requireOwnedActiveSession: RequestHandler = (req, res, next) => {
    void ownedSession(req.params.id!, current(res), true).then(session => {
      res.locals.activeSession = session;
      next();
    }).catch(next);
  };
  const uploadHosts = new Set<string>();
  let activeUploads = 0;
  const limitUploads: RequestHandler = (_req, res, next) => {
    const session = res.locals.activeSession as Session;
    if (activeUploads >= 2 || uploadHosts.has(session.hostId)) {
      next(new ApiError(429, 'upload_busy', uiMessage('ui.d081883cd46f', {}, 'en'))); return;
    }
    activeUploads++;
    uploadHosts.add(session.hostId);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      activeUploads--;
      uploadHosts.delete(session.hostId);
    };
    res.once('finish', release);
    res.once('close', release);
    next();
  };
  app.post('/api/sessions/:id/files', requireAuth, requireOwnedActiveSession, limitUploads, upload.single('file'), route(async (req, res) => {
    const session = res.locals.activeSession as Session;
    activity.touch(session.id);
    if (!req.file) throw new ApiError(400, 'file_required', uiMessage('ui.b9f25ab3c2fe', {}, 'en'));
    const name = safeUploadName(req.file.originalname);
    const install = req.body?.install == null ? name.toLowerCase().endsWith('.apk') : req.body.install === 'true';
    const result = await hub.command(session.hostId, session.id, 'file', {
      name, contentBase64: req.file.buffer.toString('base64'), install,
    }, 180_000);
    res.json({ ok: true, result });
  }));
  app.post('/api/sessions/:id/rotate', requireAuth, route(async (req, res) => {
    const session = await ownedSession(req.params.id!, current(res), true);
    activity.touch(session.id);
    const orientation = req.body?.orientation;
    if (orientation !== 'portrait' && orientation !== 'landscape') throw new ApiError(400, 'invalid_orientation', uiMessage('ui.cc9cb8dfb9ec', {}, 'en'));
    await hub.command(session.hostId, session.id, 'rotate', { orientation });
    await pool.query('UPDATE sessions SET orientation=$2 WHERE id=$1', [session.id, orientation]);
    res.json({ session: await ownedSession(session.id, current(res)) });
  }));
  app.post('/api/sessions/:id/audio', requireAuth, route(async (req, res) => {
    const session = await ownedSession(req.params.id!, current(res), true);
    activity.touch(session.id);
    if (typeof req.body?.enabled !== 'boolean') throw new ApiError(400, 'invalid_audio', uiMessage('ui.1fa0375b158e', {}, 'en'));
    await hub.command(session.hostId, session.id, 'audio', { enabled: req.body.enabled });
    await pool.query('UPDATE sessions SET audio_enabled=$2 WHERE id=$1', [session.id, req.body.enabled]);
    res.json({ session: await ownedSession(session.id, current(res)) });
  }));
  app.post('/api/sessions/:id/network', requireAuth, route(async (req, res) => {
    const session = await ownedSession(req.params.id!, current(res), true);
    activity.touch(session.id);
    if (typeof req.body?.enabled !== 'boolean') throw new ApiError(400, 'invalid_network', uiMessage('ui.1fa0375b158e', {}, 'en'));
    await hub.command(session.hostId, session.id, 'network', { enabled: req.body.enabled }, 30_000);
    await pool.query('UPDATE sessions SET network_enabled=$2 WHERE id=$1', [session.id, req.body.enabled]);
    res.json({ session: await ownedSession(session.id, current(res)) });
  }));
  app.post('/api/sessions/:id/adb', requireAuth, route(async (req, res) => {
    const session = await ownedSession(req.params.id!, current(res), true);
    activity.touch(session.id);
    const argv = req.body?.argv;
    if (!Array.isArray(argv) || argv.length < 1 || argv.length > 30 ||
        argv.some(value => typeof value !== 'string' || value.length > 1000) || JSON.stringify(argv).length > 5000) {
      throw new ApiError(400, 'invalid_adb', uiMessage('ui.7c8ef6918fbc', {}, 'en'));
    }
    const result = await hub.command(session.hostId, session.id, 'adb', { argv }, 120_000);
    res.json({ stdout: String(result.stdout || ''), stderr: String(result.stderr || ''), exitCode: Number(result.exitCode || 0) });
  }));
  app.post('/api/sessions/:id/keepalive', requireAuth, route(async (req, res) => {
    const session = await ownedSession(req.params.id!, current(res), true);
    if (session.ownerId !== current(res).user.id) throw new ApiError(403, 'forbidden', uiMessage('ui.ada61e7efdd5', {}, 'en'));
    if (session.leaseTtlSeconds != null) await renewSessionLease(pool, session.id);
    else await activity.force(session.id);
    res.json({ session: await ownedSession(session.id, current(res)) });
  }));
  app.patch('/api/sessions/:id', requireAuth, route(async (req, res) => {
    const session = await ownedSession(req.params.id!, current(res));
    if (session.ownerId !== current(res).user.id) throw new ApiError(403, 'forbidden', uiMessage('ui.8e8b3cda07d4', {}, 'en'));
    const raw = req.body?.label;
    if (raw !== null && typeof raw !== 'string') throw new ApiError(400, 'invalid_label', uiMessage('ui.b68482ff3466', {}, 'en'));
    const label = raw === null ? null : raw.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 60) || null;
    await pool.query('UPDATE sessions SET label=$2 WHERE id=$1', [session.id, label]);
    res.json({ session: await ownedSession(session.id, current(res)) });
  }));
  const LOGCAT_LEVELS = ['V', 'D', 'I', 'W', 'E', 'F'];
  const LOGCAT_BUFFERS = ['main', 'system', 'crash', 'radio'];
  function logcatParams(query: Request['query']): Record<string, unknown> {
    const params: Record<string, unknown> = {};
    const text = (value: unknown): string | undefined => typeof value === 'string' && value ? value : undefined;
    if (query.packageName !== undefined) {
      const name = query.packageName;
      if (typeof name !== 'string' || name.length > 255 || !/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+$/.test(name)) {
        throw new ApiError(400, 'invalid_logcat', uiMessage('ui.c0e311d59da6', {}, 'en'));
      }
      params.packageName = name;
    }
    const lines = text(query.lines);
    if (lines !== undefined) {
      const n = Number(lines);
      if (!Number.isInteger(n) || n < 1 || n > 5000) throw new ApiError(400, 'invalid_logcat', uiMessage('ui.f18715c272f5', {}, 'en'));
      params.lines = n;
    }
    const level = text(query.level);
    if (level !== undefined) {
      if (!LOGCAT_LEVELS.includes(level)) throw new ApiError(400, 'invalid_logcat', uiMessage('ui.daad948814d2', {}, 'en'));
      params.minLevel = level;
    }
    const buffers = text(query.buffers);
    if (buffers !== undefined) {
      const names = buffers.split(',');
      if (names.length > LOGCAT_BUFFERS.length || new Set(names).size !== names.length ||
          !names.every(name => LOGCAT_BUFFERS.includes(name))) {
        throw new ApiError(400, 'invalid_logcat', uiMessage('ui.d8ba6c1faaed', {}, 'en'));
      }
      params.buffers = names;
    }
    const since = text(query.since);
    if (since !== undefined) {
      if (!/^\d\d-\d\d \d\d:\d\d:\d\d\.\d{3}$/.test(since)) throw new ApiError(400, 'invalid_logcat', uiMessage('ui.e93ffc0dcf38', {}, 'en'));
      params.since = since;
      const skip = Number(text(query.skip) ?? 0);
      if (!Number.isInteger(skip) || skip < 0 || skip > 50_000) throw new ApiError(400, 'invalid_logcat', uiMessage('ui.c5941033b4be', {}, 'en'));
      params.skip = skip;
    }
    return params;
  }
  app.get('/api/sessions/:id/logcat/apps', requireAuth, route(async (req, res) => {
    const session = await ownedSession(req.params.id!, current(res), true);
    const result = await hub.command(session.hostId, session.id, 'logcat-apps', {}, 30_000);
    res.json({ apps: Array.isArray(result.apps) ? result.apps : [] });
  }));
  app.get('/api/sessions/:id/logcat', requireAuth, route(async (req, res) => {
    const session = await ownedSession(req.params.id!, current(res), true);
    const result = await hub.command(session.hostId, session.id, 'logcat', logcatParams(req.query), 30_000);
    res.json({ entries: Array.isArray(result.entries) ? result.entries : [], cursor: result.cursor ?? null, app: result.app ?? null });
  }));
  app.post('/api/sessions/:id/logcat/clear', requireAuth, route(async (req, res) => {
    const session = await ownedSession(req.params.id!, current(res), true);
    await hub.command(session.hostId, session.id, 'logcat-clear', {}, 30_000);
    res.json({ ok: true });
  }));
  app.get('/api/sessions/:id/device-info', requireAuth, route(async (req, res) => {
    const session = await ownedSession(req.params.id!, current(res), true);
    const [info, profile] = await Promise.all([
      hub.command(session.hostId, session.id, 'device-info', {}, 45_000),
      pool.query(
        `SELECT id,name,image,android_version,cpu,memory_mb,guest_memory_mb,guest_cores,disk_gb,sdcard_gb,emulator_params
         FROM profiles WHERE id=$1`, [session.profileId],
      ),
    ]);
    const row = profile.rows[0] as Record<string, unknown> | undefined;
    res.json({
      ...info,
      session: {
        id: session.id, hostName: session.hostName ?? null, createdAt: session.createdAt, startedAt: session.startedAt,
        orientation: session.orientation, networkEnabled: session.networkEnabled, audioEnabled: session.audioEnabled,
      },
      profile: row ? {
        id: row.id, name: row.name, image: session.launchImage ?? row.image, androidVersion: row.android_version, cpu: session.launchOptions?.cpu ?? row.cpu,
        memoryMb: session.launchOptions?.memoryMb ?? session.launchMemoryMb ?? row.memory_mb,
        guestMemoryMb: session.launchOptions?.guestMemoryMb !== undefined ? session.launchOptions.guestMemoryMb : row.guest_memory_mb ?? null,
        guestCores: session.launchOptions?.guestCores !== undefined ? session.launchOptions.guestCores : row.guest_cores ?? null,
        diskGb: session.launchOptions?.diskGb ?? row.disk_gb, sdCardMb: session.launchOptions?.sdCardMb ?? (row.sdcard_gb == null ? 0 : Number(row.sdcard_gb) * 1024), sdcardGb: session.launchOptions?.sdCardMb === undefined ? row.sdcard_gb ?? null : session.launchOptions.sdCardMb / 1024, privileged: session.launchOptions?.privileged === true,
        gpuMode: session.gpuMode ?? 'software', emulatorParams: session.launchOptions?.emulatorParams ?? row.emulator_params ?? '',
      } : null,
    });
  }));
  app.post('/api/sessions/:id/input', requireAuth, route(async (req, res) => {
    const { session, hostId } = await accessibleSession(context, req.params.id!, current(res), 'control', true);
    activity.touch(session.id);
    await hub.command(hostId, session.id, 'input', inputParams(req.body));
    res.json({ ok: true });
  }));
  app.post('/api/sessions/:id/adb-access', requireAuth, route(async (req, res) => {
    const session = await ownedSession(req.params.id!, current(res), true);
    const raw = `rdfa_${newToken()}`;
    const expiresAt = new Date(Date.now() + 5 * 60_000);
    await pool.query(
      `INSERT INTO adb_access_tokens(token_hash,session_id,owner_user_id,expires_at) VALUES($1,$2,$3,$4)`,
      [tokenHash(raw), session.id, session.ownerId, expiresAt],
    );
    res.status(201).json({ token: raw, expiresAt: expiresAt.toISOString(), sessionId: session.id });
  }));

}
