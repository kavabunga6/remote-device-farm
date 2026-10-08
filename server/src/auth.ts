import { roleForUser } from './permissions.js';
import { uiMessage } from './messages.js';
import { ApiError } from './http-common.js';
import { createHash, randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Request, Response } from 'express';
import { Client as LdapClient } from 'ldapts';
import type { Pool } from 'pg';
import type { Config } from './config.js';

function scrypt(password: string, salt: Buffer, length: number): Promise<Buffer> {
  return new Promise((resolve, reject) => scryptCallback(password, salt, length, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, key) => {
    if (error) reject(error);
    else resolve(key as Buffer);
  }));
}
export const COOKIE_NAME = 'rdf_session';
const DAY = 24 * 60 * 60 * 1000;
const DUMMY_HASH = `scrypt$${Buffer.alloc(16).toString('base64url')}$${Buffer.alloc(64).toString('base64url')}`;

export type User = { id: string; username: string; displayName: string; role: 'user' | 'admin'; provider: string;
  firstName?: string | null; lastName?: string | null; jobTitle?: string | null; company?: string | null;
  roleId?: string; roleName?: string; roleBuiltin?: 'admin' | 'user' | null; permissions?: string[] };
export type AuthContext = { user: User; via: 'cookie' | 'token' | 'admin-token' };

export function tokenHash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

export function secureEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, saltText, expectedText] = stored.split('$');
  if (scheme !== 'scrypt' || !saltText || !expectedText) return false;
  const salt = Buffer.from(saltText, 'base64url');
  const expected = Buffer.from(expectedText, 'base64url');
  if (salt.length !== 16 || expected.length !== 64) return false;
  const key = await scrypt(password, salt, expected.length);
  return timingSafeEqual(key, expected);
}

function externalText(value: unknown, max: number): string | null {
  const text = Array.isArray(value) ? value[0] : value;
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  return trimmed && trimmed.length <= max && !/[\x00-\x1f\x7f]/.test(trimmed) ? trimmed : null;
}

function userFromRow(row: Record<string, unknown>): User {
  return {
    id: String(row.id), username: String(row.username), displayName: String(row.display_name),
    role: row.role === 'admin' ? 'admin' : 'user', provider: String(row.provider),
    firstName: row.first_name == null ? null : String(row.first_name),
    lastName: row.last_name == null ? null : String(row.last_name),
    jobTitle: row.job_title == null ? null : String(row.job_title),
    company: row.company == null ? null : String(row.company),
  };
}

function cookieValue(req: IncomingMessage): string | undefined {
  const cookies = req.headers.cookie?.split(';') || [];
  const found = cookies.find(part => part.trim().startsWith(`${COOKIE_NAME}=`));
  return found?.trim().slice(COOKIE_NAME.length + 1);
}

export function clearSessionCookie(res: Response, config: Config): void {
  res.clearCookie(COOKIE_NAME, { path: '/', httpOnly: true, sameSite: 'lax', secure: config.secureCookies });
}

export class AuthService {
  constructor(private readonly pool: Pool, private readonly config: Config) {}

  async userById(userId: string): Promise<User | null> {
    const { rows } = await this.pool.query('SELECT * FROM users WHERE id=$1 AND removed_at IS NULL', [userId]);
    return rows[0] ? this.resolveUser(rows[0]) : null;
  }
  private async resolveUser(row: Record<string, unknown>): Promise<User> {
    const role = await roleForUser(this.pool, String(row.id));
    if (!role) throw new ApiError(401, 'unauthorized', uiMessage('roles.permissionDenied'));
    return { ...userFromRow(row), ...role };
  }

  async bootstrap(): Promise<void> {
    await this.pool.query(
      `INSERT INTO users (id,provider,subject,username,display_name,role)
       VALUES ($1,'system','system','system','System administrator','admin')
       ON CONFLICT (provider,subject) DO UPDATE SET role='admin' WHERE users.removed_at IS NULL`,
      [randomUUID()],
    );
    if (this.config.authMode === 'local') {
      const username = this.config.localAdminUsername!;
      const passwordHash = await hashPassword(this.config.localAdminPassword!);
      await this.pool.query(
        `INSERT INTO users (id,provider,subject,username,display_name,password_hash,role)
         VALUES ($1,'local',$2,$2,$2,$3,'admin')
         ON CONFLICT (provider,subject) DO UPDATE SET password_hash=COALESCE(users.password_hash,EXCLUDED.password_hash) WHERE users.removed_at IS NULL`,
        [randomUUID(), username, passwordHash],
      );
    }
  }

  async authenticate(req: IncomingMessage, res?: Response, createAnonymous = false): Promise<AuthContext | null> {
    const header = req.headers.authorization;
    if (header?.startsWith('Bearer ')) {
      const raw = header.slice(7);
      if (this.config.adminToken && secureEqual(raw, this.config.adminToken)) {
        const { rows } = await this.pool.query(`SELECT * FROM users WHERE provider='system' AND subject='system'`);
        return rows[0] ? { user: await this.resolveUser(rows[0]), via: 'admin-token' } : null;
      }
      const { rows } = await this.pool.query(
        `SELECT t.id AS token_id,t.kind,u.* FROM api_tokens t
         LEFT JOIN users u ON u.id=t.owner_user_id
         WHERE t.token_hash=$1 AND (u.removed_at IS NULL) AND (t.expires_at IS NULL OR t.expires_at > now())`,
        [tokenHash(raw)],
      );
      const item = rows[0];
      if (!item) return null;
      await this.pool.query('UPDATE api_tokens SET last_used_at=now() WHERE id=$1', [item.token_id]);
      if (item.kind === 'system') {
        const system = await this.pool.query(`SELECT * FROM users WHERE provider='system' AND subject='system'`);
        return system.rows[0] ? { user: await this.resolveUser(system.rows[0]), via: 'token' } : null;
      }
      return item.id ? { user: await this.resolveUser(item), via: 'token' } : null;
    }

    const rawCookie = cookieValue(req);
    if (rawCookie) {
      const { rows } = await this.pool.query(
        `SELECT u.* FROM browser_sessions s JOIN users u ON u.id=s.user_id
         WHERE s.token_hash=$1 AND s.expires_at>now() AND u.removed_at IS NULL`,
        [tokenHash(rawCookie)],
      );
      if (rows[0]) return { user: await this.resolveUser(rows[0]), via: 'cookie' };
    }
    if (createAnonymous && res && this.config.authMode === 'none') {
      const id = randomUUID();
      await this.pool.query(
        `INSERT INTO users(id,provider,subject,username,display_name) VALUES($1,'anonymous',$1,$2,'Guest')`,
        [id, `guest-${id.slice(0, 8)}`],
      );
      return { user: await this.createSession(id, res), via: 'cookie' };
    }
    return null;
  }

  async createSession(userId: string, res: Response): Promise<User> {
    const raw = newToken();
    const expires = new Date(Date.now() + 7 * DAY);
    await this.pool.query(
      `INSERT INTO browser_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,$4)`,
      [randomUUID(), userId, tokenHash(raw), expires],
    );
    res.cookie(COOKIE_NAME, raw, { httpOnly: true, secure: this.config.secureCookies, sameSite: 'lax', path: '/', expires });
    const { rows } = await this.pool.query('SELECT * FROM users WHERE id=$1 AND removed_at IS NULL', [userId]);
    if (!rows[0]) {
      await this.pool.query('DELETE FROM browser_sessions WHERE user_id=$1', [userId]);
      clearSessionCookie(res, this.config);
      throw new ApiError(401, 'user_removed', uiMessage('ui.4bf44dca589b'));
    }
    return this.resolveUser(rows[0]);
  }

  async logout(req: Request, res: Response): Promise<void> {
    const raw = cookieValue(req);
    if (raw) await this.pool.query('DELETE FROM browser_sessions WHERE token_hash=$1', [tokenHash(raw)]);
    clearSessionCookie(res, this.config);
  }

  async loginLocal(username: string, password: string): Promise<User | null> {
    const { rows } = await this.pool.query(`SELECT * FROM users WHERE provider='local' AND subject=$1 AND removed_at IS NULL`, [username]);
    const row = rows[0];
    // Match a nonexistent account with the same expensive password check.
    const hash = row?.password_hash || DUMMY_HASH;
    const valid = await verifyPassword(password, hash);
    return row && valid ? this.resolveUser(row) : null;
  }

  async loginLdap(username: string, password: string): Promise<User | null> {
    const settings = this.config.ldap;
    if (!settings || !username || !password) return null;
    const safeUsername = username.replace(/[\\*()\x00]/g, char => `\\${char.charCodeAt(0).toString(16).padStart(2, '0')}`);
    const service = new LdapClient({ url: settings.url, timeout: 5000, connectTimeout: 5000 });
    let dn: string | undefined;
    let displayName = username;
    let firstName: string | null = null;
    let lastName: string | null = null;
    let jobTitle: string | null = null;
    let company: string | null = null;
    try {
      await service.bind(settings.bindDn, settings.bindPassword);
      const result = await service.search(settings.baseDn, {
        scope: 'sub', filter: settings.userFilter.replace('{{username}}', safeUsername),
        attributes: ['cn', 'displayName', 'givenName', 'sn', 'title', 'company', 'o'], sizeLimit: 2,
      });
      if (result.searchEntries.length !== 1) return null;
      dn = String(result.searchEntries[0]?.dn || '');
      const entry = result.searchEntries[0];
      displayName = String(entry?.displayName || entry?.cn || username).slice(0, 150);
      firstName = externalText(entry?.givenName, 100);
      lastName = externalText(entry?.sn, 100);
      jobTitle = externalText(entry?.title, 150);
      company = externalText(entry?.company, 150) || externalText(entry?.o, 150);
    } finally {
      await service.unbind();
    }
    if (!dn) return null;
    const userClient = new LdapClient({ url: settings.url, timeout: 5000, connectTimeout: 5000 });
    try {
      await userClient.bind(dn, password);
    } catch {
      return null;
    } finally {
      await userClient.unbind();
    }
    return this.upsertExternalUser('ldap', dn, username, displayName, { firstName, lastName, jobTitle, company });
  }

  async upsertExternalUser(provider: string, subject: string, username: string, displayName: string,
                           attributes: { firstName?: string | null; lastName?: string | null; jobTitle?: string | null; company?: string | null } = {}): Promise<User> {
    const role = this.config.adminSubjects.has(subject) || this.config.adminSubjects.has(username) ? 'admin' : 'user';
    const { rows } = await this.pool.query(
      `INSERT INTO users(id,provider,subject,username,display_name,role,first_name,last_name,job_title,company)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (provider,subject) DO UPDATE SET username=EXCLUDED.username,display_name=EXCLUDED.display_name,
         first_name=EXCLUDED.first_name,last_name=EXCLUDED.last_name,job_title=EXCLUDED.job_title,company=EXCLUDED.company
       WHERE users.removed_at IS NULL RETURNING *`,
      [randomUUID(), provider, subject, username, displayName, role,
        externalText(attributes.firstName, 100), externalText(attributes.lastName, 100),
        externalText(attributes.jobTitle, 150), externalText(attributes.company, 150)],
    );
    if (!rows[0]) throw new ApiError(401, 'user_removed', uiMessage('ui.4bf44dca589b'));
    return this.resolveUser(rows[0]);
  }
}
