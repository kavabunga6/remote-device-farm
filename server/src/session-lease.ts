import { uiMessage } from './messages.js';
import type { Pool } from 'pg';
import { ApiError } from './http-common.js';

// Explicit leases are opt-in for automation; interactive sessions keep the normal lifecycle policy.
export function parseLeaseTtlSeconds(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 30 || value > 3600) {
    throw new ApiError(400, 'invalid_lease_ttl', uiMessage('ui.c2ef20278721', {}, 'en'));
  }
  return value;
}

export async function initializeSessionLease(pool: Pick<Pool, 'query'>, sessionId: string, ttl: number | undefined): Promise<void> {
  if (ttl === undefined) return;
  await pool.query(`UPDATE sessions SET lease_ttl_seconds=$2,lease_expires_at=now()+make_interval(secs => $2::integer) WHERE id=$1`, [sessionId, ttl]);
}

export async function renewSessionLease(pool: Pick<Pool, 'query'>, sessionId: string): Promise<void> {
  const result = await pool.query(
    `UPDATE sessions SET lease_expires_at=now()+make_interval(secs => lease_ttl_seconds),last_activity_at=now()
     WHERE id=$1 AND state IN ('starting','running') AND lease_expires_at > now() RETURNING id`, [sessionId],
  );
  if (!result.rowCount) throw new ApiError(409, 'session_lease_expired', uiMessage('ui.612767b028f1', {}, 'en'));
}
