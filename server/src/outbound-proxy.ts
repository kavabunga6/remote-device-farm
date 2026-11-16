import type { Pool, PoolClient } from 'pg';
import { transaction } from './db.js';
import { ApiError } from './http-common.js';
import { uiMessage } from './messages.js';
import { getSecretBox, type SecretBox } from './secrets.js';
import { normalizeNoProxy } from '../../agent/src/no-proxy.mjs';

export interface OutboundProxy { url: string; username: string; password: string; noProxy: string }
type Reader = Pick<Pool | PoolClient, 'query'>;
type ProxyRow = { enabled: boolean; url: string; username: string; password: string | null; noProxy: string };
const fields = ['enabled', 'url', 'username', 'password', 'noProxy'];
const invalid = () => new ApiError(400, 'invalid_outbound_proxy', uiMessage('proxy.invalid'));
const view = (row: ProxyRow) => ({ enabled: row.enabled, url: row.url, username: row.username, passwordSet: Boolean(row.password), noProxy: row.noProxy });

async function row(reader: Reader): Promise<ProxyRow> {
  return (await reader.query('SELECT enabled,url,username,password,no_proxy AS "noProxy" FROM outbound_proxy_settings WHERE id')).rows[0];
}

export async function readOutboundProxy(reader: Reader) { return view(await row(reader)); }

export async function outboundProxyFor(pool: Pool, key?: string): Promise<OutboundProxy | null> {
  const saved = await row(pool);
  if (!saved.enabled) return null;
  return { url: saved.url, username: saved.username, password: saved.password ? (await getSecretBox(pool, key)).open(saved.password) : '', noProxy: saved.noProxy };
}

export async function updateOutboundProxy(pool: Pool, box: SecretBox, input: unknown) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !fields.includes(key))) throw invalid();
  const patch = { ...input } as Record<string, unknown>;
  if (patch.enabled !== undefined && typeof patch.enabled !== 'boolean') throw invalid();
  for (const key of ['url', 'username', 'password']) {
    const value = patch[key];
    if (value !== undefined && (typeof value !== 'string' || value.length > (key === 'username' ? 256 : 1000) || /[\x00-\x1f\x7f]/.test(value))) throw invalid();
  }
  if (typeof patch.url === 'string' && patch.url) {
    let url: URL;
    try { url = new URL(patch.url); } catch { throw invalid(); }
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash || url.pathname !== '/' || patch.url.trim() !== patch.url) throw invalid();
    patch.url = url.origin;
  }
  if (typeof patch.username === 'string' && patch.username.includes(':')) throw invalid();
  if (patch.noProxy !== undefined) {
    try { patch.noProxy = normalizeNoProxy(patch.noProxy); } catch { throw invalid(); }
  }
  return transaction(pool, async client => {
    await client.query('SELECT id FROM outbound_proxy_settings WHERE id FOR UPDATE');
    const current = await row(client);
    const next = { ...current, ...patch } as ProxyRow;
    if (next.enabled && !next.url || next.password && !next.username && patch.password !== '') throw invalid();
    const password = patch.password === undefined ? current.password : patch.password ? box.seal(String(patch.password)) : null;
    await client.query('UPDATE outbound_proxy_settings SET enabled=$1,url=$2,username=$3,password=$4,no_proxy=$5,updated_at=now() WHERE id',
      [next.enabled, next.url, next.username, password, next.noProxy]);
    return view({ ...next, password });
  });
}
