import { hasPermission } from './permissions.js';
import { uiMessage } from './messages.js';
import type { Pool, PoolClient } from 'pg';
import { ApiError } from './http-common.js';
import { resolveLaunchOptions, type LaunchOptions } from './launch-options.js';

type Database = Pick<Pool | PoolClient, 'query'>;

/** Profile policy applies to ordinary launch overrides; advanced access may bypass it. */
export function launchOverridesAllowed(user: { role: string }, profile: Record<string, unknown>, farmDefault: boolean): boolean {
  return hasPermission(user, 'sessions.configure') || (hasPermission(user, 'sessions.launchOptions') && (typeof profile.allow_launch_overrides === 'boolean' ? profile.allow_launch_overrides : farmDefault));
}

export async function assertLaunchOverridesAllowed(database: Database, user: { role: string }, profile: Record<string, unknown>, requested: LaunchOptions): Promise<void> {
  if (hasPermission(user, 'sessions.configure') || !Object.keys(requested).length) return;
  // Queue/session snapshots include defaults. Reusing identical defaults is
  // allowed; any changed value requires the current permission.
  const defaults = resolveLaunchOptions(profile, {}, { role: 'admin' });
  const changed = Object.entries(requested).some(([key, value]) => value !== (defaults as Record<string, unknown>)[key] && !(key === 'privileged' && value === false));
  if (!changed) return;
  const { rows } = await database.query('SELECT allow_launch_overrides FROM launch_settings WHERE id=true FOR SHARE');
  if (!launchOverridesAllowed(user, profile, rows[0]?.allow_launch_overrides === true)) {
    throw new ApiError(403, 'launch_overrides_forbidden', uiMessage('ui.0c63273ade48'));
  }
}
