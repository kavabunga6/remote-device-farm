import { uiMessage } from './messages.js';
import { mergeLaunchStorage, type LaunchOptions } from './launch-options.js';
import type { Pool } from 'pg';
import type { AgentHub } from './agent.js';
import type { Config } from './config.js';
import { recordAuditEvent } from './audit.js';
import { ApiError } from './http-common.js';
import { notifyUser, pruneNotifications } from './notifications.js';
import { createSession } from './session-create.js';
import type { GpuMode } from './gpu-modes.js';
import type { LifecyclePolicy } from './session-lifecycle.js';

export const MAX_QUEUE_ENTRIES_PER_USER = 3;
export const EXPIRING_WARNING_MINUTES = 5;
const MAX_SCAN = 200;

export type DispatcherDeps = {
  pool: Pool;
  hub: Pick<AgentHub, 'hasAgent' | 'onSessionClosed'> & Partial<AgentHub>;
  config: Pick<Config, 'queueTtlMinutes' | 'maxSessionsPerUser'> & Partial<Config>;
  policy: LifecyclePolicy;
  // Injected in tests.
  create?: (user: { id: string; role: string }, input: { hostId: string; profileId: string; launchOptions?: LaunchOptions; gpuMode?: GpuMode; adbKeyId?: string | null; leaseTtlSeconds?: number; label?: string | null; sessionId: string }) => Promise<string>;
};

type WaitingEntry = { id: string; userId: string; role: string; username: string; profileId: string; launchOptions?: LaunchOptions; gpuMode?: GpuMode; adbKeyId?: string | null; leaseTtlSeconds?: number; hostId: string | null; label: string | null };

// Number of earlier waiting entries that compete for the same slots, plus one.
// Slots belong to hosts, so entries compete when either accepts any host or both name the same host.
export function queuePosition(
  waiting: Array<{ id: string; hostId: string | null }>, entryId: string,
): number {
  const index = waiting.findIndex(entry => entry.id === entryId);
  if (index < 0) return 0;
  const mine = waiting[index]!;
  let position = 1;
  for (let i = 0; i < index; i++) {
    const other = waiting[i]!;
    if (other.hostId === null || mine.hostId === null || other.hostId === mine.hostId) position++;
  }
  return position;
}

type AssignDecision = { kind: 'assigned'; sessionId: string; hostId: string } | { kind: 'skipped' } | { kind: 'cancel'; code: string };

// One pass over the waiting list in FIFO order. A host that an older entry could not get a slot on stays
// reserved for that entry, so a younger entry never overtakes it on that host.
export async function assignWaiting(
  entries: WaitingEntry[], hosts: string[],
  tryCreate: (entry: WaitingEntry, hostId: string) => Promise<string>,
  onResult: (entry: WaitingEntry, decision: AssignDecision) => Promise<void>,
): Promise<void> {
  const starved = new Set<string>();
  const overLimit = new Set<string>();
  for (const entry of entries) {
    if (overLimit.has(entry.userId)) continue;
    const candidates = (entry.hostId ? [entry.hostId] : hosts).filter(host => hosts.includes(host) && !starved.has(host));
    let decision: AssignDecision = { kind: 'skipped' };
    for (const hostId of candidates) {
      try {
        decision = { kind: 'assigned', sessionId: await tryCreate(entry, hostId), hostId };
        break;
      } catch (error) {
        const code = error instanceof ApiError ? error.code : '';
        if (code === 'no_free_slots') starved.add(hostId);
        else if (code === 'session_limit') { overLimit.add(entry.userId); break; }
        else if (code === 'storage_out_of_range' || code === 'resources_out_of_range' || code === 'invalid_launch_options' || code === 'profile_not_found' || code === 'profile_image_not_ready' || code === 'adb_key_not_found' || code === 'unsupported_profile_image' || (error instanceof ApiError && error.status === 403)) { decision = { kind: 'cancel', code: code || 'queue_not_allowed' }; break; }
        // agent_offline, host_unavailable, profile_too_large, gpu_unavailable: try the next host.
      }
    }
    if (decision.kind !== 'skipped') await onResult(entry, decision);
  }
}

async function onlineHosts(pool: Pool, hub: DispatcherDeps['hub']): Promise<string[]> {
  const { rows } = await pool.query(
    `SELECT h.id, h.slots - (SELECT count(*) FROM host_slots s WHERE s.host_id=h.id AND s.session_id IS NOT NULL) AS free
     FROM hosts h
     WHERE h.status='online' AND NOT h.disabled AND h.removed_at IS NULL AND h.last_seen_at > now() - interval '45 seconds'
     ORDER BY free DESC, h.id`,
  );
  return rows.map(row => String(row.id)).filter(id => hub.hasAgent(id));
}

// A claim records the future session id before creation. After a crash, an existing session wins;
// a missing session can be retried with that same id, so overlapping attempts cannot launch twice.
async function recoverAssigned(pool: Pool): Promise<void> {
  await pool.query(
    `UPDATE queue_entries q SET
       state=CASE WHEN q.expires_at<=now() THEN 'expired' ELSE 'waiting' END,
       session_id=NULL,claimed_at=NULL,
       resolved_at=CASE WHEN q.expires_at<=now() THEN now() ELSE NULL END
     WHERE q.state='assigned' AND q.resolved_at IS NULL AND COALESCE(q.claimed_at,q.created_at)<now()-interval '2 minutes'
       AND NOT EXISTS (SELECT 1 FROM sessions s WHERE s.id=q.session_id)
       AND NOT EXISTS (SELECT 1 FROM rental_history r WHERE r.session_id=q.session_id)`,
  );
  await pool.query(
    `UPDATE queue_entries q SET resolved_at=COALESCE(q.resolved_at,now())
     WHERE q.state='assigned' AND q.resolved_at IS NULL
       AND (EXISTS (SELECT 1 FROM sessions s WHERE s.id=q.session_id)
         OR EXISTS (SELECT 1 FROM rental_history r WHERE r.session_id=q.session_id))`,
  );
}

async function notifyAssigned(pool: Pool): Promise<void> {
  const pending = await pool.query(
    `SELECT q.user_id,q.session_id,p.name
     FROM queue_entries q JOIN sessions s ON s.id=q.session_id
     JOIN profiles p ON p.id=q.profile_id
     WHERE q.state='assigned' AND NOT EXISTS (
       SELECT 1 FROM notifications n WHERE n.session_id=q.session_id AND n.kind='queue.assigned')
     ORDER BY q.created_at,q.id LIMIT ${MAX_SCAN}`,
  );
  for (const row of pending.rows) {
    await notifyUser(pool, String(row.user_id), {
      kind: 'queue.assigned', title: uiMessage('ui.b1f8d0f9fa2e'),
      body: uiMessage('ui.bc5fd0c83e94', { p0: row.name }).trim(), sessionId: String(row.session_id),
    });
  }
}

export async function runQueuePass(deps: DispatcherDeps): Promise<void> {
  const { pool } = deps;
  await recoverAssigned(pool);
  await pool.query(
    "UPDATE queue_entries SET state='expired',resolved_at=now() WHERE state='waiting' AND expires_at <= now()",
  );
  const waiting = await pool.query(
    `SELECT q.id,q.user_id,q.profile_id,q.host_id,q.label,q.gpu_mode,q.adb_key_id,q.lease_ttl_seconds,q.launch_options,q.disk_gb,q.sdcard_gb,u.role,u.username
     FROM queue_entries q JOIN users u ON u.id=q.user_id
     WHERE q.state='waiting' AND u.removed_at IS NULL ORDER BY q.created_at,q.id LIMIT ${MAX_SCAN}`,
  );
  if (!waiting.rowCount) { await notifyAssigned(pool); return; }
  const hosts = await onlineHosts(pool, deps.hub);
  if (!hosts.length) { await notifyAssigned(pool); return; }
  const create = deps.create ?? ((user, input) => createSession(
    { pool, hub: deps.hub as AgentHub, config: deps.config as Config }, user, input));
  const entries: WaitingEntry[] = waiting.rows.map(row => ({
    id: String(row.id), userId: String(row.user_id), role: String(row.role), username: String(row.username),
    profileId: String(row.profile_id), hostId: row.host_id ? String(row.host_id) : null,
    label: row.label ? String(row.label) : null,
    launchOptions: mergeLaunchStorage(row.launch_options ?? {}, { diskGb: row.disk_gb == null ? undefined : Number(row.disk_gb), sdcardGb: row.sdcard_gb == null ? undefined : Number(row.sdcard_gb) }),
    adbKeyId: row.adb_key_id == null ? null : String(row.adb_key_id),
    leaseTtlSeconds: row.lease_ttl_seconds == null ? undefined : Number(row.lease_ttl_seconds),
    gpuMode: row.gpu_mode === 'nvidia' ? 'nvidia' : row.gpu_mode === 'software' ? 'software' : undefined,
  }));
  // Conditional claim prevents two dispatchers from assigning the same entry.
  await assignWaiting(entries, hosts, async (entry, hostId) => {
    const claim = await pool.query(
      "UPDATE queue_entries SET state='assigned',session_id=id,claimed_at=now() WHERE id=$1 AND state='waiting' RETURNING id",
      [entry.id],
    );
    if (!claim.rowCount) throw new ApiError(409, 'queue_entry_gone', uiMessage('ui.a575eeaa6cc5', {}, 'en'));
    try {
      return await create({ id: entry.userId, role: entry.role },
        { hostId, profileId: entry.profileId, launchOptions: entry.launchOptions, gpuMode: entry.gpuMode, adbKeyId: entry.adbKeyId, leaseTtlSeconds: entry.leaseTtlSeconds, label: entry.label, sessionId: entry.id });
    } catch (error) {
      // A synchronous error after the session transaction committed must not free this claim.
      const existing = await pool.query('SELECT id FROM sessions WHERE id=$1 UNION ALL SELECT session_id AS id FROM rental_history WHERE session_id=$1', [entry.id]);
      if (existing.rowCount) return entry.id;
      await pool.query(
        "UPDATE queue_entries SET state='waiting',session_id=NULL,claimed_at=NULL WHERE id=$1 AND state='assigned' AND session_id=$1",
        [entry.id],
      );
      throw error;
    }
  }, async (entry, decision) => {
    if (decision.kind === 'assigned') {
      await pool.query(
        "UPDATE queue_entries SET session_id=$2,resolved_at=now() WHERE id=$1 AND state='assigned'",
        [entry.id, decision.sessionId],
      );
      await recordAuditEvent(pool, {
        action: 'queue.assigned', actor: { id: entry.userId, username: entry.username }, targetType: 'queue', targetId: entry.id,
      }).catch(() => {});
    } else if (decision.kind === 'cancel') {
      await pool.query("UPDATE queue_entries SET state='cancelled',resolved_at=now(),error_code=$2 WHERE id=$1 AND state='waiting'", [entry.id, decision.code]);
      await recordAuditEvent(pool, {
        action: 'queue.cancelled', actor: { id: entry.userId, username: entry.username }, targetType: 'queue', targetId: entry.id, outcome: 'failed',
      }).catch(() => {});
    }
  });
  await notifyAssigned(pool);
}

// Notifications derived from session state: ready and about to be released. Deduplicated through the notifications table.
export async function runNotificationPass(pool: Pool, policy: LifecyclePolicy): Promise<void> {
  const ready = await pool.query(
    `SELECT s.id,s.owner_user_id,p.name FROM sessions s JOIN profiles p ON p.id=s.profile_id
     WHERE s.state='running' AND s.started_at > now() - interval '15 minutes'
       AND NOT EXISTS (SELECT 1 FROM notifications n WHERE n.session_id=s.id AND n.kind='session.ready')`,
  );
  for (const row of ready.rows) {
    await notifyUser(pool, String(row.owner_user_id), {
      kind: 'session.ready', title: uiMessage('ui.ad0b444760b8'), body: String(row.name), sessionId: String(row.id),
    });
  }
  if (policy.idleMinutes <= 0 && policy.maxHours <= 0) return;
  const soon = await pool.query(
    `SELECT s.id,s.owner_user_id,p.name,
       ($1::integer > 0 AND s.last_activity_at + make_interval(mins => $1::integer) BETWEEN now() AND now() + make_interval(mins => $3::integer)) AS idle_soon
     FROM sessions s JOIN profiles p ON p.id=s.profile_id
     WHERE s.state='running' AND (
       ($1::integer > 0 AND s.last_activity_at + make_interval(mins => $1::integer) BETWEEN now() AND now() + make_interval(mins => $3::integer)
         AND NOT EXISTS (SELECT 1 FROM notifications n WHERE n.session_id=s.id AND n.kind='session.expiring' AND n.created_at > s.last_activity_at))
       OR
       ($2::integer > 0 AND s.created_at + make_interval(hours => $2::integer) BETWEEN now() AND now() + make_interval(mins => $3::integer)
         AND NOT EXISTS (SELECT 1 FROM notifications n WHERE n.session_id=s.id AND n.kind='session.expiring' AND n.created_at > now() - interval '15 minutes')))`,
    [policy.idleMinutes, policy.maxHours, EXPIRING_WARNING_MINUTES],
  );
  for (const row of soon.rows) {
    await notifyUser(pool, String(row.owner_user_id), {
      kind: 'session.expiring', title: uiMessage('ui.925c51d7aa64'),
      body: row.idle_soon
        ? uiMessage('ui.497169219a42', { p0: row.name })
        : uiMessage('ui.c5d0305a1a5e', { p0: row.name }),
      sessionId: String(row.id),
    });
  }
}

export type QueueDispatcher = { trigger: () => void; stop: () => Promise<void>; runOnce: () => Promise<void> };

export function startQueueDispatcher(deps: DispatcherDeps, everyMs = 5_000): QueueDispatcher {
  let running: Promise<void> | null = null;
  let stopped = false;
  let again = false;
  let pruned = 0;
  const runOnce = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (running) { again = true; return running; }
    running = (async () => {
      do {
        again = false;
        await runQueuePass(deps).catch(() => console.error('Queue pass failed'));
        if (stopped) break;
        await runNotificationPass(deps.pool, deps.policy).catch(() => console.error('Notification pass failed'));
        if (Date.now() - pruned > 3_600_000) {
          pruned = Date.now();
          await pruneNotifications(deps.pool).catch(() => {});
        }
      } while (again && !stopped);
    })().finally(() => { running = null; });
    return running;
  };
  let debounce: NodeJS.Timeout | null = null;
  const trigger = () => {
    if (stopped || debounce) return;
    debounce = setTimeout(() => { debounce = null; void runOnce(); }, 300);
    debounce.unref();
  };
  const timer = setInterval(() => void runOnce(), everyMs);
  timer.unref();
  const unsubscribe = deps.hub.onSessionClosed(trigger);
  return { trigger, runOnce, stop: () => {
    stopped = true;
    again = false;
    clearInterval(timer);
    if (debounce) clearTimeout(debounce);
    debounce = null;
    unsubscribe?.();
    return running ?? Promise.resolve();
  } };
}
