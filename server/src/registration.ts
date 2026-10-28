import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { hashPassword } from './auth.js';
import { recordAuditEvent } from './audit.js';
import { transaction } from './db.js';
import { ApiError, isUuid } from './http-common.js';
import { uiMessage } from './messages.js';
import { assertStoredPermission } from './permissions.js';

export interface RegistrationSettings { enabled: boolean; roleId: string; available: boolean }
type Database = Pick<Pool | PoolClient, 'query'>;
async function settingsRow(db: Database, lock = false) {
  return (await db.query(
    `SELECT s.enabled,s.role_id,r.builtin FROM registration_settings s
     JOIN access_roles r ON r.id=s.role_id WHERE s.id=true${lock ? ' FOR SHARE OF s,r' : ''}`)).rows[0];
}
export async function registrationSettings(db: Database, available: boolean): Promise<RegistrationSettings> {
  const row = await settingsRow(db);
  return { enabled: available && row?.enabled === true && row.builtin !== 'admin', roleId: row?.role_id ?? '', available };
}
export async function updateRegistrationSettings(pool: Pool, body: unknown, actorId: string, available: boolean): Promise<RegistrationSettings> {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !['enabled', 'roleId'].includes(key)))
    throw new ApiError(400, 'invalid_registration_settings', uiMessage('registration.invalidSettings'));
  const { enabled, roleId } = body as Record<string, unknown>;
  if (typeof enabled !== 'boolean' || typeof roleId !== 'string' || !isUuid(roleId))
    throw new ApiError(400, 'invalid_registration_settings', uiMessage('registration.invalidSettings'));
  if (enabled && !available) throw new ApiError(409, 'registration_unavailable', uiMessage('registration.unavailable'));
  await transaction(pool, async client => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['access-roles']);
    await assertStoredPermission(client, actorId, 'roles.manage');
    const role = (await client.query('SELECT builtin FROM access_roles WHERE id=$1 FOR SHARE', [roleId])).rows[0];
    if (!role || role.builtin === 'admin') throw new ApiError(400, 'invalid_registration_role', uiMessage('registration.invalidRole'));
    await client.query('UPDATE registration_settings SET enabled=$1,role_id=$2 WHERE id=true', [enabled, roleId]);
  });
  return registrationSettings(pool, available);
}
export function registrationCredentials(body: unknown): { username: string; password: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !['username', 'password'].includes(key)))
    throw new ApiError(400, 'invalid_registration', uiMessage('registration.invalidCredentials'));
  const { username, password } = body as Record<string, unknown>;
  if (typeof username !== 'string' || !/^[A-Za-z0-9._@-]{3,150}$/.test(username) ||
      typeof password !== 'string' || password.length < 12 || password.length > 2048)
    throw new ApiError(400, 'invalid_registration', uiMessage('registration.invalidCredentials'));
  return { username, password };
}
export async function registerAccount(pool: Pool, credentials: { username: string; password: string }): Promise<string> {
  const passwordHash = await hashPassword(credentials.password);
  try {
    return await transaction(pool, async client => {
      // Settings may have changed while password hashing was in progress.
      const settings = await settingsRow(client, true);
      if (!settings?.enabled || settings.builtin === 'admin')
        throw new ApiError(403, 'registration_disabled', uiMessage('registration.disabled'));
      const id = randomUUID();
      // A reused login receives a new identity, never the deleted account's data.
      await client.query("UPDATE users SET subject='removed:' || id::text WHERE provider='local' AND subject=$1 AND removed_at IS NOT NULL", [credentials.username]);
      await client.query(
        `INSERT INTO users(id,provider,subject,username,display_name,password_hash,role,access_role_id)
         VALUES($1,'local',$2,$2,$2,$3,'user',$4)`, [id, credentials.username, passwordHash, settings.role_id]);
      await recordAuditEvent(client, { action: 'auth.register', actor: { id, username: credentials.username }, targetType: 'user', targetId: id });
      return id;
    });
  } catch (error) {
    if ((error as { code?: string }).code === '23505')
      throw new ApiError(409, 'registration_login_unavailable', uiMessage('registration.loginUnavailable'));
    throw error;
  }
}
/** Bounded attempts and concurrent password work, including failed requests. */
export class RegistrationLimiter {
  private readonly attempts = new Map<string, { count: number; until: number }>();
  private active = 0;
  enter(address: string, now = Date.now()): () => void {
    const previous = this.attempts.get(address);
    if (previous && previous.until > now && previous.count >= 10)
      throw new ApiError(429, 'registration_rate_limit', uiMessage('registration.rateLimit'));
    if (this.active >= 2) throw new ApiError(429, 'registration_busy', uiMessage('registration.busy'));
    this.attempts.delete(address);
    this.attempts.set(address, { count: previous && previous.until > now ? previous.count + 1 : 1,
      until: previous && previous.until > now ? previous.until : now + 15 * 60_000 });
    if (this.attempts.size > 10_000) this.attempts.delete(this.attempts.keys().next().value!);
    this.active++;
    return () => { this.active--; };
  }
}
