import { randomUUID } from 'node:crypto';
import type { Express } from 'express';
import type { PoolClient } from 'pg';
import type { ServerContext } from '../server-context.js';
import { transaction } from '../db.js';
import { ApiError, boundedString, isUuid, route } from '../http-common.js';
import { uiMessage } from '../messages.js';
import { allPermissions, assertStoredPermission, parsePermissions, permissionCatalog } from '../permissions.js';
import { revokeAccessConnections } from '../access-connections.js';

export async function invalidateUserAccess(client: Pick<PoolClient, 'query'>, ids: string[]): Promise<void> {
 if (!ids.length) return;
 await client.query('DELETE FROM adb_access_tokens WHERE owner_user_id=ANY($1::uuid[])', [ids]);
 await client.query('DELETE FROM adb_port_access WHERE owner_user_id=ANY($1::uuid[])', [ids]);
 await client.query("UPDATE queue_entries SET state='cancelled',resolved_at=now() WHERE user_id=ANY($1::uuid[]) AND state='waiting'", [ids]);
}
function roleName(value: unknown): string {
 const name = boundedString(value, 80);
 if (!name || /[\x00-\x1f\x7f]/.test(name)) throw new ApiError(400, 'invalid_role', uiMessage('roles.invalid'));
 return name;
}
export function registerRoleRoutes(app: Express, context: ServerContext): void {
 const { pool, requireAuth, requireAdmin, current } = context;
 app.get('/api/admin/roles', requireAuth, requireAdmin, route(async (_req, res) => {
  const { rows } = await pool.query(`SELECT r.*,COUNT(u.id)::integer AS "userCount" FROM access_roles r
    LEFT JOIN users u ON u.access_role_id=r.id AND u.removed_at IS NULL AND u.provider!='system'
    GROUP BY r.id ORDER BY r.builtin NULLS LAST,lower(r.name),r.id`);
  res.json({ roles: rows.map(r => ({ id: r.id, name: r.name, builtin: r.builtin,
    permissions: r.builtin === 'admin' ? allPermissions : r.permissions.filter((p: string) => allPermissions.includes(p)), userCount: r.userCount })), catalog: permissionCatalog.groups });
 }));
 async function save(id: string | null, body: Record<string, unknown>, actorId: string) {
  const name = roleName(body?.name), permissions = parsePermissions(body?.permissions);
  let affected: string[] = [];
  const role = await transaction(pool, async client => {
   await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['access-roles']);
   await assertStoredPermission(client, actorId, 'roles.manage');
   if (!id) return (await client.query('INSERT INTO access_roles(id,name,permissions) VALUES($1,$2,$3) RETURNING *', [randomUUID(), name, permissions])).rows[0];
   if (!isUuid(id)) throw new ApiError(400, 'invalid_role', uiMessage('roles.invalid'));
   const previous = (await client.query('SELECT * FROM access_roles WHERE id=$1 FOR UPDATE', [id])).rows[0];
   if (!previous) throw new ApiError(404, 'not_found', uiMessage('roles.notFound'));
   if (previous.builtin === 'admin' || previous.builtin && name !== previous.name) throw new ApiError(409, 'protected_role', uiMessage('roles.protected'));
   const changed = permissions.length !== previous.permissions.length || permissions.some(p => !previous.permissions.includes(p));
   if (changed) affected = (await client.query('SELECT id FROM users WHERE access_role_id=$1 AND removed_at IS NULL', [id])).rows.map(row => String(row.id));
   const updated = (await client.query('UPDATE access_roles SET name=$2,permissions=$3,updated_at=now() WHERE id=$1 RETURNING *', [id, name, permissions])).rows[0];
   await invalidateUserAccess(client, affected);
   return updated;
  });
  revokeAccessConnections(affected);
  return role;
 }
 function conflict(error: unknown): never {
  if ((error as { code?: string }).code === '23505') throw new ApiError(409, 'role_exists', uiMessage('roles.exists'));
  throw error;
 }
 app.post('/api/admin/roles', requireAuth, requireAdmin, route(async (req, res) => {
  try {
   const role = await save(null, req.body, current(res).user.id);
   res.locals.auditTargetId = role.id;
   res.status(201).json({ role });
  } catch (error) { conflict(error); }
 }));
 app.patch('/api/admin/roles/:id', requireAuth, requireAdmin, route(async (req, res) => {
  try {
   const role = await save(req.params.id!, req.body, current(res).user.id);
   res.json({ role });
  } catch (error) { conflict(error); }
 }));
 app.delete('/api/admin/roles/:id', requireAuth, requireAdmin, route(async (req, res) => {
  const id = req.params.id!;
  if (!isUuid(id)) throw new ApiError(400, 'invalid_role', uiMessage('roles.invalid'));
  await transaction(pool, async client => {
   await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['access-roles']);
   await assertStoredPermission(client, current(res).user.id, 'roles.manage');
   const previous = (await client.query('SELECT * FROM access_roles WHERE id=$1 FOR UPDATE', [id])).rows[0];
   if (!previous) throw new ApiError(404, 'not_found', uiMessage('roles.notFound'));
   if (previous.builtin) throw new ApiError(409, 'protected_role', uiMessage('roles.protected'));
   if ((await client.query('SELECT 1 FROM registration_settings WHERE role_id=$1', [id])).rows.length)
    throw new ApiError(409, 'registration_role_in_use', uiMessage('registration.roleInUse'));
   await client.query("UPDATE users SET access_role_id='00000000-0000-4000-8000-000000000002' WHERE access_role_id=$1 AND removed_at IS NOT NULL", [id]);
   if ((await client.query('SELECT 1 FROM users WHERE access_role_id=$1 LIMIT 1', [id])).rows.length)
    throw new ApiError(409, 'role_in_use', uiMessage('roles.inUse'));
   await client.query('DELETE FROM access_roles WHERE id=$1', [id]);
  });
  res.json({ ok: true });
 }));
 app.put('/api/admin/users/:id/role', requireAuth, requireAdmin, route(async (req, res) => {
  const userId = req.params.id!, roleId = String(req.body?.roleId ?? '').toLowerCase();
  let changed = false;
  if (!isUuid(userId) || !isUuid(roleId)) throw new ApiError(400, 'invalid_role', uiMessage('roles.invalid'));
  await transaction(pool, async client => {
   await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['user-removal']);
   await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['access-roles']);
   await assertStoredPermission(client, current(res).user.id, 'roles.manage');
   const target = (await client.query('SELECT * FROM users WHERE id=$1 AND removed_at IS NULL FOR UPDATE', [userId])).rows[0];
   if (!target || target.provider === 'system') throw new ApiError(404, 'not_found', uiMessage('ui.8ef54e373b98'));
   const role = (await client.query('SELECT builtin FROM access_roles WHERE id=$1 FOR SHARE', [roleId])).rows[0];
   if (!role) throw new ApiError(404, 'not_found', uiMessage('roles.notFound'));
   if (target.role === 'admin' && role.builtin !== 'admin') {
    const other = await client.query("SELECT 1 FROM users WHERE id!=$1 AND role='admin' AND provider!='system' AND removed_at IS NULL LIMIT 1", [userId]);
    if (!other.rows.length) throw new ApiError(409, 'last_admin', uiMessage('roles.lastAdmin'));
   }
   if (target.access_role_id === roleId) return;
   changed = true;
   await client.query('UPDATE users SET access_role_id=$2 WHERE id=$1', [userId, roleId]);
   await invalidateUserAccess(client, [userId]);
  });
  if (changed) revokeAccessConnections([userId]);
  res.json({ ok: true });
 }));
}
