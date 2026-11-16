import { isIP } from 'node:net';
import { domainToASCII } from 'node:url';

export function normalizeNoProxy(value = '') {
  if (typeof value !== 'string' || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value)) throw new Error('invalid_outbound_proxy');
  const entries = value.split(',').map(host => host.trim().toLowerCase()).filter(Boolean);
  if (entries.length > 200) throw new Error('invalid_outbound_proxy');
  const hosts = entries.map(entry => {
    let host = entry.replace(/^\./, '').replace(/\.$/, '');
    if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
    if (isIP(host)) return isIP(host) === 6 ? new URL('http://[' + host + ']').hostname.slice(1, -1) : host;
    if (/[\s:/\\@?#%\[\]]/.test(host)) throw new Error('invalid_outbound_proxy');
    host = domainToASCII(host);
    if (host !== '*' && (!host || host.length > 253 || !host.split('.').every(part => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(part)))) throw new Error('invalid_outbound_proxy');
    return host;
  });
  const result = hosts.includes('*') ? '*' : [...new Set(hosts)].join(',');
  if (result.length > 4096) throw new Error('invalid_outbound_proxy');
  return result;
}
