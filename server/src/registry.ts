import { diagnostic } from './diagnostics.js';
import { uiMessage } from './messages.js';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Pool } from 'pg';
import { ApiError } from './http-common.js';
import { transaction } from './db.js';
import type { SecretBox } from './secrets.js';

/** Repository name of farm emulator images inside any registry. */
export const IMAGE_REPOSITORY = 'rdf-emulator';
const PULL_TTL_SECONDS = 60 * 60;
const PUSH_TTL_SECONDS = 6 * 60 * 60;
const USERNAME = 'rdf';

export interface RegistrySettings {
  mode: 'builtin' | 'external';
  builtinAddress: string | null;
  externalAddress: string | null;
  externalUsername: string | null;
  externalPasswordSet: boolean;
}

/** Docker credentials the agent passes as X-Registry-Auth; never stored by the agent. */
export interface RegistryAuth { username: string; password: string; serveraddress: string }

const HOST = /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?(:[0-9]{1,5})?$/i;
const HOST_PATH = /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?(:[0-9]{1,5})?(\/[a-z0-9._-]+){0,4}$/i;

const hash = (token: string) => createHash('sha256').update(token).digest('hex');
const registryHost = (address: string) => address.split('/')[0]!;

export async function readRegistrySettings(pool: Pick<Pool, 'query'>): Promise<RegistrySettings> {
  const { rows } = await pool.query('SELECT * FROM registry_settings WHERE id');
  const row = rows[0] ?? {};
  return {
    mode: row.mode === 'external' ? 'external' : 'builtin',
    builtinAddress: row.builtin_address ?? null,
    externalAddress: row.external_address ?? null,
    externalUsername: row.external_username ?? null,
    externalPasswordSet: Boolean(row.external_password),
  };
}

/** Seed a fresh installation only; existing administrator settings always take precedence. */
export async function initializeRegistry(pool: Pool, address?: string): Promise<void> {
  if (!address) return;
  const normalized = address.trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  if (!HOST.test(normalized)) throw new Error(diagnostic('registry.41ffc0a2fa'));
  await pool.query('UPDATE registry_settings SET builtin_address=$1, updated_at=now() WHERE id AND builtin_address IS NULL', [normalized]);
}

/** Partial update from the admin UI. The external password is write-only: null keeps it, '' clears it. */
export async function updateRegistrySettings(pool: Pool, box: SecretBox, input: Record<string, unknown>): Promise<RegistrySettings> {
  const text = (value: unknown, pattern: RegExp, name: string) => {
    if (value === undefined) return undefined;
    if (value === null || value === '') return null;
    const trimmed = String(value).trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
    if (!pattern.test(trimmed)) throw new ApiError(400, 'invalid_registry', uiMessage('ui.d9b3108fd7f5', { p0: name }, 'en'));
    return trimmed;
  };
  const mode = input.mode === undefined ? undefined : input.mode;
  if (mode !== undefined && mode !== 'builtin' && mode !== 'external') throw new ApiError(400, 'invalid_registry', uiMessage('ui.a8f214a1cc93', {}, 'en'));
  const builtin = text(input.builtinAddress, HOST, 'builtinAddress');
  const external = text(input.externalAddress, HOST_PATH, 'externalAddress');
  const username = input.externalUsername === undefined ? undefined : input.externalUsername === null || input.externalUsername === '' ? null : String(input.externalUsername);
  if (username && (username.length > 200 || /[\x00-\x1f\x7f]/.test(username))) throw new ApiError(400, 'invalid_registry', uiMessage('ui.e4a5540377b7', {}, 'en'));
  const password = input.externalPassword;
  if (password !== undefined && password !== null && (typeof password !== 'string' || password.length > 1000)) throw new ApiError(400, 'invalid_registry', uiMessage('ui.ae251ee78b69', {}, 'en'));
  return transaction(pool, async client => {
    const current = (await client.query('SELECT mode,external_address FROM registry_settings WHERE id FOR UPDATE')).rows[0];
    if (!current) throw new ApiError(409, 'registry_not_initialized', uiMessage('ui.0d354c0a9c8b', {}, 'en'));
    if ((mode ?? current.mode) === 'external' && !(external === undefined ? current.external_address : external)) {
      throw new ApiError(400, 'invalid_registry', uiMessage('ui.706ceba1e909', {}, 'en'));
    }
    await client.query(
      `UPDATE registry_settings SET
         mode=COALESCE($1, mode),
         builtin_address=CASE WHEN $2::boolean THEN $3 ELSE builtin_address END,
         external_address=CASE WHEN $4::boolean THEN $5 ELSE external_address END,
         external_username=CASE WHEN $6::boolean THEN $7 ELSE external_username END,
         external_password=CASE WHEN $8::boolean THEN $9 ELSE external_password END,
         updated_at=now()
       WHERE id`,
      [mode ?? null, builtin !== undefined, builtin ?? null, external !== undefined, external ?? null, username !== undefined, username ?? null,
        password !== undefined && password !== null, password ? box.seal(password) : null]);
    return readRegistrySettings(client);
  });
}

/** host[:port][/path] images are pushed to and pulled from, or null when the registry is not configured yet. */
export function activeAddress(settings: RegistrySettings): string | null {
  return settings.mode === 'external' ? settings.externalAddress : settings.builtinAddress;
}

export async function issueRegistryToken(pool: Pool, scope: 'pull' | 'push', hostId: string | null): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  await pool.query('DELETE FROM registry_tokens WHERE expires_at < now()');
  await pool.query(`INSERT INTO registry_tokens(token_hash,scope,host_id,expires_at) VALUES($1,$2,$3,now() + make_interval(secs => $4))`,
    [hash(token), scope, hostId, scope === 'push' ? PUSH_TTL_SECONDS : PULL_TTL_SECONDS]);
  return token;
}

/** Credentials for one registry operation on a node: a short-lived farm token, or the stored company credentials. */
export async function registryAuthFor(pool: Pool, box: SecretBox, image: string, scope: 'pull' | 'push', hostId: string | null): Promise<RegistryAuth | null> {
  const { rows } = await pool.query('SELECT * FROM registry_settings WHERE id');
  const row = rows[0];
  if (!row) return null;
  const under = (address: string | null) => Boolean(address) && (image === address || image.startsWith(address + '/') || image.startsWith(address + ':'));
  if (row.builtin_address && under(row.builtin_address)) {
    return { username: USERNAME, password: await issueRegistryToken(pool, scope, hostId), serveraddress: registryHost(row.builtin_address) };
  }
  if (row.external_address && under(row.external_address) && row.external_username && row.external_password) {
    return { username: row.external_username, password: box.open(row.external_password), serveraddress: registryHost(row.external_address) };
  }
  return null;
}

/**
 * nginx auth_request for /v2/ of the built-in registry. Reads anything with a pull or push token; writes need push.
 * Returns 401 without valid credentials so Docker sends them, 403 for a pull token that tries to push.
 */
export async function authorizeRegistryRequest(pool: Pool, authorization: string | undefined, method: string): Promise<200 | 401 | 403> {
  const match = /^Basic ([A-Za-z0-9+/=]{1,512})$/.exec(authorization ?? '');
  if (!match) return 401;
  const decoded = Buffer.from(match[1]!, 'base64').toString('utf8');
  const separator = decoded.indexOf(':');
  if (separator < 0) return 401;
  const user = Buffer.from(decoded.slice(0, separator));
  if (user.length !== USERNAME.length || !timingSafeEqual(user, Buffer.from(USERNAME))) return 401;
  const { rows } = await pool.query('SELECT scope FROM registry_tokens WHERE token_hash=$1 AND expires_at > now()', [hash(decoded.slice(separator + 1))]);
  if (!rows[0]) return 401;
  const read = method === 'GET' || method === 'HEAD';
  if (!read && (await pool.query("SELECT 1 FROM image_cleanup_jobs WHERE scope='registry' AND state IN ('queued','running') LIMIT 1")).rowCount) return 403;
  return read || rows[0].scope === 'push' ? 200 : 403;
}
