import { uiMessage } from './messages.js';
import { createHmac } from 'node:crypto';
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import type { LookupFunction } from 'node:net';

export type WebhookPolicy = { allowHttp: boolean; allowPrivate: boolean };

export const WEBHOOK_TIMEOUT_MS = 5_000;
export const WEBHOOK_MAX_RETRIES = 2;

export class WebhookUrlError extends Error {}

// X-RDF-Signature: sha256=<hex>, an HMAC of "<X-RDF-Timestamp>.<raw body>" with the webhook secret.
export function signPayload(secret: string, timestamp: string, body: string): string {
  return 'sha256=' + createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

function ipv4Parts(ip: string): number[] | null {
  const parts = ip.split('.').map(Number);
  return parts.length === 4 && parts.every(n => Number.isInteger(n) && n >= 0 && n <= 255) ? parts : null;
}

function blockedV4(parts: number[]): boolean {
  const [a, b, c] = parts as [number, number, number, number];
  return a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 198 && (b === 18 || b === 19));
}

// Expands an IPv6 literal into eight 16-bit groups; returns null for invalid input.
function ipv6Groups(ip: string): number[] | null {
  let text = ip.split('%')[0]!.toLowerCase();
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (tail) {
    const v4 = ipv4Parts(tail[1]!);
    if (!v4) return null;
    text = text.slice(0, -tail[1]!.length) +
      ((v4[0]! << 8) | v4[1]!).toString(16) + ':' + ((v4[2]! << 8) | v4[3]!).toString(16);
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = 8 - head.length - rest.length;
  if (halves.length === 2 ? fill < 1 : fill !== 0) return null;
  const all = [...head, ...(halves.length === 2 ? Array(fill).fill('0') : []), ...rest];
  const groups = all.map(g => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
  return groups.length === 8 && groups.every(Number.isFinite) ? groups : null;
}

// True for loopback, private, link-local, CGNAT, multicast, reserved and unspecified addresses.
export function isBlockedAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) {
    const parts = ipv4Parts(ip);
    return !parts || blockedV4(parts);
  }
  if (family === 6) {
    const g = ipv6Groups(ip);
    if (!g) return true;
    const embedded = [g[6]! >> 8, g[6]! & 255, g[7]! >> 8, g[7]! & 255];
    if (g.slice(0, 5).every(x => x === 0) && (g[5] === 0xffff || g[5] === 0)) {
      // ::, ::1 and IPv4-mapped/compatible forms.
      return g[5] === 0 && g[6] === 0 && g[7]! <= 1 ? true : blockedV4(embedded);
    }
    if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every(x => x === 0)) return blockedV4(embedded); // NAT64
    if (g[0] === 0x2002) return blockedV4([g[1]! >> 8, g[1]! & 255, g[2]! >> 8, g[2]! & 255]); // 6to4
    return (g[0]! & 0xfe00) === 0xfc00 || (g[0]! & 0xffc0) === 0xfe80 || (g[0]! & 0xffc0) === 0xfec0 ||
      (g[0]! & 0xff00) === 0xff00 || (g[0] === 0x2001 && g[1] === 0x0db8);
  }
  return true;
}

// Static checks on the URL itself. Resolved addresses are checked again at connect time.
export function parseWebhookUrl(raw: unknown, policy: WebhookPolicy): URL {
  if (typeof raw !== 'string' || raw.length < 8 || raw.length > 2000) throw new WebhookUrlError(uiMessage('ui.c5c58d0d270e'));
  let url: URL;
  try { url = new URL(raw.trim()); } catch { throw new WebhookUrlError(uiMessage('ui.1775d5170e03')); }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && policy.allowHttp)) {
    throw new WebhookUrlError(uiMessage('ui.00c2222d53dd'));
  }
  if (url.username || url.password) throw new WebhookUrlError(uiMessage('ui.5fd2c345bde8'));
  if (url.port && (Number(url.port) < 1 || Number(url.port) > 65535)) throw new WebhookUrlError(uiMessage('ui.a1e428e69419'));
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!host) throw new WebhookUrlError(uiMessage('ui.1775d5170e03'));
  if (!policy.allowPrivate) {
    if (isIP(host) && isBlockedAddress(host)) throw new WebhookUrlError(uiMessage('ui.76128c9b753d'));
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) {
      throw new WebhookUrlError(uiMessage('ui.76128c9b753d'));
    }
  }
  return url;
}

type Lookup = (hostname: string, options: dns.LookupAllOptions, cb: (err: NodeJS.ErrnoException | null, addresses: dns.LookupAddress[]) => void) => void;

// A lookup that resolves DNS and rejects blocked addresses; the socket then connects to exactly that result.
export function safeLookup(policy: WebhookPolicy, resolver: Lookup = dns.lookup as unknown as Lookup): LookupFunction {
  return ((hostname: string, options: { all?: boolean }, callback: (...args: unknown[]) => void) => {
    resolver(hostname, { all: true } as dns.LookupAllOptions, (error, addresses) => {
      if (error) return callback(error);
      if (!addresses.length) return callback(new Error('DNS returned no addresses'));
      if (!policy.allowPrivate && addresses.some(item => isBlockedAddress(item.address))) {
        return callback(new Error('blocked_address'));
      }
      if (options?.all) return callback(null, addresses);
      callback(null, addresses[0]!.address, addresses[0]!.family);
    });
  }) as LookupFunction;
}

export type WebhookTarget = { id: string; url: string; secret: string };
export type WebhookEnvelope = { id: string; event: string; createdAt: string; text: string; data: Record<string, unknown> };
export type DeliveryResult = { ok: boolean; status: number | null; attempts: number; error?: string };
export type DeliveryOptions = {
  policy: WebhookPolicy;
  timeoutMs?: number;
  retries?: number;
  retryDelaysMs?: number[];
  lookup?: LookupFunction;
  now?: () => number;
};

function postOnce(url: URL, body: string, headers: Record<string, string>, options: DeliveryOptions): Promise<number> {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? https : http;
    const req = transport.request(url, {
      method: 'POST',
      headers: { ...headers, 'Content-Length': String(Buffer.byteLength(body)) },
      lookup: options.lookup ?? safeLookup(options.policy),
      timeout: options.timeoutMs ?? WEBHOOK_TIMEOUT_MS,
      agent: false,
    }, res => {
      res.resume(); // The response body is ignored.
      res.on('end', () => resolve(res.statusCode ?? 0));
      res.on('error', reject);
    });
    // Overall deadline, not just socket idleness.
    const deadline = setTimeout(() => req.destroy(new Error('timeout')), options.timeoutMs ?? WEBHOOK_TIMEOUT_MS);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', error => { clearTimeout(deadline); reject(error); });
    req.on('close', () => clearTimeout(deadline));
    req.end(body);
  });
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

// Redirects are never followed (a 3xx counts as failure). 5xx and network errors are retried; 4xx are not.
export async function deliverWebhook(target: WebhookTarget, envelope: WebhookEnvelope, options: DeliveryOptions): Promise<DeliveryResult> {
  let url: URL;
  try { url = parseWebhookUrl(target.url, options.policy); }
  catch (error) { return { ok: false, status: null, attempts: 0, error: (error as Error).message }; }
  const retries = Math.min(options.retries ?? WEBHOOK_MAX_RETRIES, WEBHOOK_MAX_RETRIES);
  const delays = options.retryDelaysMs ?? [1_000, 4_000];
  const body = JSON.stringify(envelope);
  let last: DeliveryResult = { ok: false, status: null, attempts: 0 };
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(delays[attempt - 1] ?? 4_000);
    const timestamp = String(Math.floor((options.now?.() ?? Date.now()) / 1000));
    const headers = {
      'Content-Type': 'application/json',
      'User-Agent': 'RemoteDeviceFarm-Webhook/1',
      'X-RDF-Event': envelope.event,
      'X-RDF-Timestamp': timestamp,
      'X-RDF-Signature': signPayload(target.secret, timestamp, body),
    };
    try {
      const status = await postOnce(url, body, headers, options);
      last = { ok: status >= 200 && status < 300, status, attempts: attempt + 1 };
      if (last.ok || (status >= 300 && status < 500)) return last;
    } catch (error) {
      const message = (error as Error).message;
      last = { ok: false, status: null, attempts: attempt + 1, error: message === 'blocked_address' ? uiMessage('ui.86b8555be8ea') : uiMessage('ui.b5cd0908e0f5') };
      if (message === 'blocked_address') return last;
    }
  }
  return last;
}
