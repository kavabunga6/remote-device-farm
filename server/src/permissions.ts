import { readFileSync } from 'node:fs';
import type { Pool, PoolClient } from 'pg';
import { ApiError } from './http-common.js';
import { uiMessage } from './messages.js';
export type PermissionCatalog = { groups: Array<{ id: string; labelKey: string; actions: Array<{ id: string; labelKey: string; requires: string[] }> }>; user: string[] };
export const permissionCatalog: PermissionCatalog = JSON.parse(readFileSync(new URL('../../shared/permissions.json', import.meta.url), 'utf8'));
export const allPermissions = permissionCatalog.groups.flatMap(group => group.actions.map(action => action.id));
const known = new Set(allPermissions);
export type PermissionUser = { role: string; permissions?: readonly string[]; roleId?: string };
export function hasPermission(user: PermissionUser, permission: string): boolean {
  if (user.permissions) return user.permissions.includes(permission);
  if (user.roleId && !['00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002'].includes(user.roleId)) return false;
  return user.role === 'admin' ? known.has(permission) : permissionCatalog.user.includes(permission);
}
export function assertPermission(user: PermissionUser, permission: string): void {
  if (!hasPermission(user, permission)) throw new ApiError(403, 'permission_denied', uiMessage('roles.permissionDenied'));
}
export async function roleForUser(db: Pick<Pool | PoolClient, 'query'>, userId: string) {
  const { rows } = await db.query('SELECT r.id,r.name,r.builtin,r.permissions FROM access_roles r JOIN users u ON u.access_role_id=r.id WHERE u.id=$1 AND u.removed_at IS NULL FOR SHARE OF r', [userId]);
  const role = rows[0];
  return role ? { roleId: String(role.id), roleName: String(role.name), roleBuiltin: role.builtin as 'admin' | 'user' | null,
    permissions: role.builtin === 'admin' ? [...allPermissions] : Array.isArray(role.permissions) ? (role.permissions as unknown[]).filter((p): p is string => typeof p === 'string' && known.has(p)) : [] } : null;
}
export async function assertStoredPermission(db: Pick<Pool | PoolClient, 'query'>, userId: string, permission: string): Promise<void> {
  const role = await roleForUser(db, userId);
  if (!role) throw new ApiError(401, 'unauthorized', uiMessage('roles.permissionDenied'));
  assertPermission({ role: role.roleBuiltin === 'admin' ? 'admin' : 'user', ...role }, permission);
}
export function parsePermissions(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > allPermissions.length || value.some(p => typeof p !== 'string' || !known.has(p)))
    throw new ApiError(400, 'invalid_role', uiMessage('roles.invalid'));
  const selected = new Set<string>(value);
  for (const group of permissionCatalog.groups) for (const action of group.actions)
    if (selected.has(action.id) && action.requires.some(p => !selected.has(p))) throw new ApiError(400, 'invalid_role', uiMessage('roles.invalid'));
  return allPermissions.filter(p => selected.has(p));
}
