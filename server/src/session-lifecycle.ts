import { diagnostic } from './diagnostics.js';
import { uiMessage } from './messages.js';
import type { Pool } from 'pg';
import type { Config } from './config.js';
import type { AgentHub } from './agent.js';
import { recordAuditEvent } from './audit.js';
import { notifyUser } from './notifications.js';
import type { Session } from './http-common.js';

export type LifecyclePolicy = { idleMinutes: number; maxHours: number };

export function lifecyclePolicy(config: Pick<Config, 'idleTimeoutMinutes' | 'maxSessionHours'>): LifecyclePolicy {
  return { idleMinutes: config.idleTimeoutMinutes, maxHours: config.maxSessionHours };
}

// When the session will be released if nobody touches it, and its hard limit. Both are null when the policy is off.
export function sessionDeadlines(
  session: Pick<Session, 'state' | 'lastActivityAt' | 'createdAt'>, policy: LifecyclePolicy,
): { idleExpiresAt: string | null; expiresAt: string | null } {
  if (!['starting', 'running'].includes(session.state)) return { idleExpiresAt: null, expiresAt: null };
  const idle = policy.idleMinutes > 0
    ? new Date(new Date(session.lastActivityAt).getTime() + policy.idleMinutes * 60_000).toISOString() : null;
  const hard = policy.maxHours > 0
    ? new Date(new Date(session.createdAt).getTime() + policy.maxHours * 3_600_000).toISOString() : null;
  return { idleExpiresAt: idle, expiresAt: hard };
}

export function withDeadlines(session: Session, policy: LifecyclePolicy): Session {
  return { ...session, ...sessionDeadlines(session, policy) };
}

// Writes "last activity" at most once per interval per session, so input storms stay cheap.
export class ActivityTracker {
  private readonly written = new Map<string, number>();
  constructor(private readonly pool: Pick<Pool, 'query'>, private readonly intervalMs = 30_000) {}

  touch(sessionId: string, now = Date.now()): void {
    const last = this.written.get(sessionId);
    if (last !== undefined && now - last < this.intervalMs) return;
    this.written.set(sessionId, now);
    if (this.written.size > 5_000) for (const [id, at] of this.written) if (now - at > 10 * 60_000) this.written.delete(id);
    void this.pool.query('UPDATE sessions SET last_activity_at=now() WHERE id=$1', [sessionId]).catch(() => {});
  }

  // A keep-alive from the user always reaches the database.
  async force(sessionId: string): Promise<void> {
    this.written.set(sessionId, Date.now());
    await this.pool.query('UPDATE sessions SET last_activity_at=now() WHERE id=$1', [sessionId]);
  }
}

export type ExpiredSession = { id: string; hostId: string; ownerId: string; reason: 'idle' | 'max_lifetime' | 'lease_expired' };

export async function findExpiredSessions(
  pool: Pick<Pool, 'query'>, policy: LifecyclePolicy, isBusy: (sessionId: string) => boolean,
): Promise<ExpiredSession[]> {
  const { rows } = await pool.query(
    `SELECT id,host_id,owner_user_id,created_at,last_activity_at,(lease_expires_at <= now()) AS lease_expired FROM sessions
     WHERE (state IN ('starting','running') AND lease_expires_at <= now()) OR
       (state='running' AND (
         ($1::integer > 0 AND last_activity_at < now() - make_interval(mins => $1::integer)) OR
         ($2::integer > 0 AND created_at < now() - make_interval(hours => $2::integer))))`,
    [policy.idleMinutes, policy.maxHours],
  );
  const expired: ExpiredSession[] = [];
  const now = Date.now();
  for (const row of rows) {
    const id = String(row.id);
    const overLifetime = policy.maxHours > 0 && new Date(String(row.created_at)).getTime() < now - policy.maxHours * 3_600_000;
    // ADB traffic prevents idle release; only an explicit heartbeat extends a client lease.
    if (!row.lease_expired && !overLifetime && isBusy(id)) continue;
    expired.push({ id, hostId: String(row.host_id), ownerId: String(row.owner_user_id),
      reason: row.lease_expired ? 'lease_expired' : overLifetime ? 'max_lifetime' : 'idle' });
  }
  return expired;
}

export async function releaseExpired(pool: Pool, hub: AgentHub, expired: ExpiredSession): Promise<boolean> {
  // Recheck the deadline under the UPDATE lock: a heartbeat may have renewed it after the scan.
  const marked = expired.reason === 'lease_expired'
    ? await pool.query(`UPDATE sessions SET state='stopping' WHERE id=$1 AND state IN ('starting','running')
        AND lease_expires_at <= now() RETURNING id`, [expired.id])
    : await pool.query(`UPDATE sessions SET state='stopping' WHERE id=$1 AND state='running' RETURNING id`, [expired.id]);
  if (!marked.rowCount) return false;
  try {
    if (expired.reason === 'lease_expired') await hub.command(expired.hostId, expired.id, 'kill', {}, 30_000);
    else {
      try { await hub.command(expired.hostId, expired.id, 'stop', {}, 30_000); }
      catch { await hub.command(expired.hostId, expired.id, 'kill', {}, 30_000); }
    }
    await hub.releaseSession(expired.id);
  } catch {
    // Offline or failed cleanup: keep the slot reserved for agent reconciliation.
    return false;
  }
  await recordAuditEvent(pool, {
    action: expired.reason === 'lease_expired' ? 'session.released_lease'
      : expired.reason === 'idle' ? 'session.released_idle' : 'session.released_expired',
    targetType: 'session', targetId: expired.id,
  }).catch(() => {});
  await notifyUser(pool, expired.ownerId, {
    kind: 'session.released', title: uiMessage('ui.9e0fc6a80c8f'),
    body: expired.reason === 'lease_expired' ? uiMessage('ui.971c9f65dca8')
      : expired.reason === 'idle' ? uiMessage('ui.6ea83344f1f4') : uiMessage('ui.e3a9a5793787'),
    sessionId: expired.id,
  });
  return true;
}

export function startSessionReaper(
  pool: Pool, hub: AgentHub, policy: LifecyclePolicy, isBusy: (sessionId: string) => boolean, everyMs = 15_000,
): () => Promise<void> {
  // Opt-in client leases still expire when the global idle/lifetime limits are disabled.
  let running: Promise<void> | null = null;
  let stopped = false;
  const timer = setInterval(() => {
    if (stopped || running) return;
    running = (async () => {
      for (const expired of await findExpiredSessions(pool, policy, isBusy)) {
        if (stopped) break;
        await releaseExpired(pool, hub, expired);
      }
    })().catch(() => console.error(diagnostic('session-lifecycle.0308002137'))).finally(() => { running = null; });
  }, everyMs);
  timer.unref();
  return () => {
    stopped = true;
    clearInterval(timer);
    return running ?? Promise.resolve();
  };
}
