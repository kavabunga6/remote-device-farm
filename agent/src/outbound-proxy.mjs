import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { normalizeNoProxy } from './no-proxy.mjs';

export function validateOutboundProxy(proxy) {
  if (proxy == null) return null;
  if (typeof proxy !== 'object' || Array.isArray(proxy) || Object.keys(proxy).some(key => !['url', 'username', 'password', 'noProxy'].includes(key))) throw new Error('invalid_outbound_proxy');
  for (const key of ['url', 'username', 'password']) {
    if (typeof proxy[key] !== 'string' || proxy[key].length > (key === 'username' ? 256 : 1000) || /[\x00-\x1f\x7f]/.test(proxy[key])) throw new Error('invalid_outbound_proxy');
  }
  let url;
  try { url = new URL(proxy.url); } catch { throw new Error('invalid_outbound_proxy'); }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.pathname !== '/' || url.search || url.hash || proxy.url.trim() !== proxy.url || proxy.username.includes(':') || proxy.password && !proxy.username) throw new Error('invalid_outbound_proxy');
  const noProxy = normalizeNoProxy(proxy.noProxy);
  return { url: url.origin, username: proxy.username, password: proxy.password, ...(noProxy ? { noProxy } : {}) };
}

export function proxyAddress(proxy) {
  const value = validateOutboundProxy(proxy);
  if (!value) return null;
  const url = new URL(value.url);
  url.username = encodeURIComponent(value.username); url.password = encodeURIComponent(value.password);
  return url.href;
}

export function proxyEnvironment(proxy) {
  const address = proxyAddress(proxy);
  const noProxy = normalizeNoProxy(proxy?.noProxy);
  return address ? ['HTTP_PROXY=' + address, 'HTTPS_PROXY=' + address, 'http_proxy=' + address, 'https_proxy=' + address, ...(noProxy ? ['NO_PROXY=' + noProxy, 'no_proxy=' + noProxy] : [])] : [];
}

export function proxySecrets(proxy) {
  if (!proxy?.password) return [];
  return [proxy.password, encodeURIComponent(proxy.password), Buffer.from(proxy.username + ':' + proxy.password).toString('base64'), proxyAddress(proxy)];
}

export const proxyFingerprint = proxy => createHash('sha256').update(JSON.stringify(validateOutboundProxy(proxy))).digest('hex');


/** Match the node's trust for HTTPS proxies, including minimal build stages without a CA package yet. */
export async function readProxyTrust(proxy) {
  if (!proxy || new URL(proxy.url).protocol !== 'https:') return null;
  const trust = await readFile('/etc/ssl/certs/ca-certificates.crt');
  if (!trust.length || trust.length > 4 * 1024 * 1024) throw new Error('proxy_trust_unavailable');
  return trust;
}
