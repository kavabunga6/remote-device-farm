import { createContext, useContext, type ReactNode } from 'react';
import catalog from '../../shared/permissions.json';
import type { User } from './api';
import { t, type MessageKey } from './i18n';
export const permissionCatalog = catalog.groups;
export const allPermissions = permissionCatalog.flatMap(group => group.actions.map(action => action.id));
export function can(user: Pick<User, 'role' | 'permissions' | 'roleId'> | null | undefined, permission: string): boolean {
 if (!user) return false;
 if (user.permissions) return user.permissions.includes(permission);
 if (user.roleId && !['00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002'].includes(user.roleId)) return false;
 return user.role === 'admin' ? allPermissions.includes(permission) : catalog.user.includes(permission);
}
const AccessContext = createContext<User | null>(null);
export function AccessProvider({ user, children }: { user: User; children: ReactNode }) { return <AccessContext.Provider value={user}>{children}</AccessContext.Provider>; }
export function useAccess() { const user = useContext(AccessContext); return (permission: string) => can(user, permission); }
export type AccessRole = { id: string; name: string; builtin: 'admin' | 'user' | null; permissions: string[]; userCount: number };
export function roleLabel(role: { name?: string; roleName?: string; builtin?: string | null; roleBuiltin?: string | null; role?: string }): string {
 const builtin = role.builtin ?? role.roleBuiltin ?? (!role.roleName ? role.role : undefined);
 return builtin === 'admin' ? t('roles.admin') : builtin === 'user' ? t('roles.user') : role.name ?? role.roleName ?? t('roles.user');
}
export const permissionLabel = (key: string) => t(key as MessageKey);
export function togglePermission(values: string[], id: string, checked: boolean): string[] {
 const selected = new Set(values);
 const actions = permissionCatalog.flatMap(group => group.actions);
 const add = (permission: string) => { selected.add(permission); for (const dependency of actions.find(action => action.id === permission)?.requires ?? []) add(dependency); };
 if (checked) add(id);
 else {
  selected.delete(id);
  let changed = true;
  while (changed) { changed = false; for (const action of actions) if (selected.has(action.id) && action.requires.some(p => !selected.has(p))) { selected.delete(action.id); changed = true; } }
 }
 return allPermissions.filter(p => selected.has(p));
}
