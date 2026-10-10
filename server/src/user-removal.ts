import type { AgentHub } from './agent.js';
import { revokeAccessConnections } from './access-connections.js';
import { assertStoredPermission } from './permissions.js';
import { uiMessage } from './messages.js';
import type { Pool, PoolClient } from 'pg';
import { transaction } from './db.js';
import { ApiError } from './http-common.js';
import { closeGrantSockets } from './session-access.js';

/** Hold this lock through allocation so removal and a new launch cannot pass each other. */
export async function assertUserActive(client: Pick<PoolClient, 'query'>, userId: string): Promise<void> {
  const { rows } = await client.query('SELECT removed_at FROM users WHERE id=$1 FOR SHARE', [userId]);
  if (!rows[0] || rows[0].removed_at) throw new ApiError(401, 'user_removed', uiMessage('ui.4bf44dca589b'));
}

export async function removeUser(pool: Pool, userId: string, actorId: string, hub: Pick<AgentHub, 'stopSession'>): Promise<void> {
  if (userId === actorId) throw new ApiError(409, 'self_removal', uiMessage('ui.f5a40bde642c'));
  const removed = await transaction(pool, async client => {
    // Serialize removals so two administrators cannot delete each other concurrently.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['user-removal']);
    const { rows } = await client.query('SELECT * FROM users WHERE id=$1 FOR UPDATE', [userId]);
    const person = rows[0];
    if (!person || person.provider === 'system' || person.removed_at) {
      throw new ApiError(404, 'not_found', uiMessage('ui.8ef54e373b98'));
    }
    const actor = await client.query('SELECT role,removed_at FROM users WHERE id=$1', [actorId]);
    if (!actor.rows[0] || actor.rows[0].removed_at) {
      throw new ApiError(403, 'forbidden', uiMessage('ui.f256f7a7b1e1'));
    }
    await assertStoredPermission(client, actorId, 'users.delete');
    if (person.role === 'admin') {
      const other = await client.query("SELECT 1 FROM users WHERE id!=$1 AND role='admin' AND provider!='system' AND removed_at IS NULL LIMIT 1", [userId]);
      if (!other.rows.length) throw new ApiError(409, 'last_admin', uiMessage('ui.b9e4f9b16564'));
    }
    // Allocation holds a shared lock on this user; every accepted launch is now
    // visible. Persist cleanup before revoking access or sending any agent RPC.
    const active = await client.query(
      "SELECT id,host_id,state FROM sessions WHERE owner_user_id=$1 AND state IN ('starting','running','stopping') FOR UPDATE", [userId]);
    await client.query("UPDATE sessions SET state='stopping' WHERE owner_user_id=$1 AND state IN ('starting','running')", [userId]);
    await client.query('UPDATE users SET removed_at=now(),password_hash=NULL WHERE id=$1', [userId]);
    await client.query('DELETE FROM browser_sessions WHERE user_id=$1', [userId]);
    await client.query('DELETE FROM api_tokens WHERE owner_user_id=$1', [userId]);
    await client.query('DELETE FROM adb_access_tokens WHERE owner_user_id=$1', [userId]);
    await client.query('DELETE FROM adb_port_access WHERE owner_user_id=$1', [userId]);
    await client.query('DELETE FROM user_adb_keys WHERE user_id=$1', [userId]);
    // Leases remain until teardown, but must no longer retain a usable key.
    await client.query('UPDATE sessions SET adb_key_id=NULL WHERE owner_user_id=$1', [userId]);
    await client.query('DELETE FROM user_adb_public_keys WHERE owner_user_id=$1', [userId]);
    await client.query("UPDATE queue_entries SET state='cancelled',resolved_at=now() WHERE user_id=$1 AND (state='waiting' OR (state='assigned' AND resolved_at IS NULL))", [userId]);
    await client.query('UPDATE webhooks SET enabled=false WHERE user_id=$1', [userId]);
    await client.query('DELETE FROM team_members WHERE user_id=$1', [userId]);
    await client.query('UPDATE session_shares SET revoked_at=now() WHERE created_by=$1 AND revoked_at IS NULL', [userId]);
    const revoked = await client.query(
      `UPDATE session_share_grants SET revoked_at=now() WHERE revoked_at IS NULL AND
       (user_id=$1 OR share_id IN (SELECT id FROM session_shares WHERE created_by=$1)) RETURNING id,session_id`, [userId]);
    return { grants: revoked.rows, sessions: active.rows };
  });
  revokeAccessConnections([userId]);
  for (const grant of removed.grants) closeGrantSockets(String(grant.session_id), new Set([String(grant.id)]));
  for (const session of removed.sessions) hub.stopSession(String(session.host_id), String(session.id), session.state !== 'running');
}
