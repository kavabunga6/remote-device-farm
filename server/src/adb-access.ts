import { uiMessage } from './messages.js';
import type { PoolClient } from 'pg';
import type { Config } from './config.js';
import { ApiError } from './http-common.js';

export type AdbKeyRecord = { public_key: string; fingerprint: string };
export type AdbPortLease = { port: number; expiresAt: Date | null; changed: boolean };

export async function allocateAdbPortAccess(
  client: Pick<PoolClient, 'query'>, config: Config, sessionId: string, userId: string,
  key: AdbKeyRecord, expiresAt: Date | null,
): Promise<AdbPortLease> {
  if (!config.adbPorts) throw new ApiError(503, 'adb_port_disabled', uiMessage('ui.c617b1f2321a', {}, 'en'));
  await client.query('SELECT pg_advisory_xact_lock(1820481225)');
  await client.query('DELETE FROM adb_port_access WHERE expires_at<=now()');
  const existing = await client.query(
    'SELECT port,owner_user_id,fingerprint,public_key,expires_at FROM adb_port_access WHERE session_id=$1',
    [sessionId],
  );
  const current = existing.rows[0];
  if (current && current.owner_user_id === userId &&
      current.fingerprint === key.fingerprint && current.public_key === key.public_key &&
      (expiresAt === null ? current.expires_at === null : false)) {
    return { port: Number(current.port), expiresAt: null, changed: false };
  }
  let port = current ? Number(current.port) : 0;
  if (!port) {
    const occupied = await client.query('SELECT port FROM adb_port_access');
    const used = new Set<number>(occupied.rows.map(row => Number(row.port)));
    for (let candidate = config.adbPorts.start;
         candidate < config.adbPorts.start + config.adbPorts.count; candidate++) {
      if (!used.has(candidate)) { port = candidate; break; }
    }
  }
  if (!port) throw new ApiError(409, 'adb_ports_full', uiMessage('ui.846f00780ddc', {}, 'en'));
  await client.query(
    'INSERT INTO adb_port_access(session_id,owner_user_id,port,public_key,fingerprint,expires_at) ' +
    'VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(session_id) DO UPDATE SET ' +
    'owner_user_id=EXCLUDED.owner_user_id,public_key=EXCLUDED.public_key,' +
    'fingerprint=EXCLUDED.fingerprint,expires_at=EXCLUDED.expires_at',
    [sessionId, userId, port, key.public_key, key.fingerprint, expiresAt],
  );
  return { port, expiresAt, changed: true };
}