import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage } from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import type { Pool } from 'pg';
import { configureNotifications, markNotificationsRead, notifyUser, unreadNotifications } from '../src/notifications.js';
import { deliverWebhook, isBlockedAddress, parseWebhookUrl, safeLookup, signPayload, WebhookUrlError } from '../src/webhooks.js';

const STRICT = { allowHttp: false, allowPrivate: false };

test('signature is an HMAC-SHA256 over timestamp and body', () => {
  const sig = signPayload('secret', '1700000000', '{"a":1}');
  assert.match(sig, /^sha256=[0-9a-f]{64}$/);
  assert.equal(sig, signPayload('secret', '1700000000', '{"a":1}'));
  assert.notEqual(sig, signPayload('secret2', '1700000000', '{"a":1}'));
  assert.notEqual(sig, signPayload('secret', '1700000001', '{"a":1}'));
  assert.notEqual(sig, signPayload('secret', '1700000000', '{"a":2}'));
});

test('private, loopback, link-local and reserved addresses are blocked', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '0.0.0.0',
    '100.64.0.1', '224.0.0.1', '255.255.255.255', '::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', 'ff02::1',
    '::ffff:127.0.0.1', '::ffff:10.0.0.1', '::ffff:a00:1', '64:ff9b::7f00:1', '2002:7f00:1::1', 'not-an-ip']) {
    assert.equal(isBlockedAddress(ip), true, ip);
  }
  for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '172.15.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8', '192.169.0.1']) {
    assert.equal(isBlockedAddress(ip), false, ip);
  }
});

test('URL rules: https only, no credentials, no internal literals unless allowed', () => {
  assert.equal(parseWebhookUrl('https://hooks.example.com/x?y=1', STRICT).hostname, 'hooks.example.com');
  const bad = ['http://hooks.example.com/x', 'ftp://example.com', 'https://user:pw@example.com', 'https://127.0.0.1/x',
    'https://[::1]/x', 'https://localhost/x', 'https://169.254.169.254/latest', 'https://foo.localhost', 'javascript:alert(1)', '', 'x'.repeat(2500)];
  for (const url of bad) assert.throws(() => parseWebhookUrl(url, STRICT), WebhookUrlError, url);
  assert.throws(() => parseWebhookUrl(5, STRICT), WebhookUrlError);
  assert.equal(parseWebhookUrl('http://hooks.example.com/x', { allowHttp: true, allowPrivate: false }).protocol, 'http:');
  assert.equal(parseWebhookUrl('https://127.0.0.1/x', { allowHttp: false, allowPrivate: true }).hostname, '127.0.0.1');
});

test('the DNS lookup rejects names that resolve to internal addresses', async () => {
  const resolver = (addresses: string[]) => (_h: string, _o: unknown, cb: (e: null, a: Array<{ address: string; family: number }>) => void) =>
    cb(null, addresses.map(address => ({ address, family: address.includes(':') ? 6 : 4 })));
  const lookup = (policy: typeof STRICT, addresses: string[]) => new Promise<unknown>((resolve) =>
    (safeLookup(policy, resolver(addresses) as never) as unknown as (h: string, o: object, cb: (e: Error | null, a?: unknown) => void) => void)('x.test', {}, (error, address) => resolve(error ? error.message : address)));
  assert.equal(await lookup(STRICT, ['10.0.0.5']), 'blocked_address');
  assert.equal(await lookup(STRICT, ['8.8.8.8', '192.168.0.1']), 'blocked_address', 'one bad answer is enough');
  assert.equal(await lookup(STRICT, ['8.8.8.8']), '8.8.8.8');
  assert.equal(await lookup({ allowHttp: false, allowPrivate: true }, ['10.0.0.5']), '10.0.0.5');
});

async function receiver(statuses: number[]) {
  const seen: Array<{ headers: IncomingMessage['headers']; body: string }> = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      seen.push({ headers: req.headers, body });
      const status = statuses[Math.min(seen.length - 1, statuses.length - 1)]!;
      if (status === 302) res.writeHead(302, { Location: 'http://127.0.0.1:1/evil' });
      else if (status === 0) return; // hang
      else res.writeHead(status);
      res.end('ok');
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return { seen, url: `http://127.0.0.1:${address.port}/hook`, close: () => { server.closeAllConnections(); return new Promise<void>(r => server.close(() => r())); } };
}

const LOCAL = { policy: { allowHttp: true, allowPrivate: true }, retryDelaysMs: [5, 5] };
const envelope = { id: 'n1', event: 'session.ready', createdAt: '2026-10-03T00:00:00.000Z', text: 'Готово', data: { sessionId: 's1' } };

test('delivery is signed and carries a text field', async () => {
  const target = await receiver([200]);
  try {
    const result = await deliverWebhook({ id: 'w', url: target.url, secret: 'topsecret' }, envelope, { ...LOCAL, now: () => 1_700_000_000_000 });
    assert.deepEqual(result, { ok: true, status: 200, attempts: 1 });
    const { headers, body } = target.seen[0]!;
    assert.equal(headers['x-rdf-signature'], signPayload('topsecret', '1700000000', body));
    assert.equal(headers['x-rdf-timestamp'], '1700000000');
    assert.equal(headers['x-rdf-event'], 'session.ready');
    assert.equal((JSON.parse(body) as { text: string }).text, 'Готово');
  } finally { await target.close(); }
});

test('5xx is retried at most twice, 4xx and redirects are not', async () => {
  const flaky = await receiver([500, 500, 200]);
  try {
    assert.deepEqual(await deliverWebhook({ id: 'w', url: flaky.url, secret: 's' }, envelope, LOCAL), { ok: true, status: 200, attempts: 3 });
  } finally { await flaky.close(); }
  const down = await receiver([503]);
  try {
    const result = await deliverWebhook({ id: 'w', url: down.url, secret: 's' }, envelope, LOCAL);
    assert.equal(result.ok, false);
    assert.equal(result.attempts, 3);
    assert.equal(down.seen.length, 3);
  } finally { await down.close(); }
  const rejected = await receiver([400]);
  try {
    assert.equal((await deliverWebhook({ id: 'w', url: rejected.url, secret: 's' }, envelope, LOCAL)).attempts, 1);
  } finally { await rejected.close(); }
  const redirect = await receiver([302]);
  try {
    const result = await deliverWebhook({ id: 'w', url: redirect.url, secret: 's' }, envelope, LOCAL);
    assert.deepEqual([result.ok, result.status, result.attempts], [false, 302, 1]);
  } finally { await redirect.close(); }
});

test('a hanging receiver times out and a blocked target is never contacted', async () => {
  const hang = await receiver([0]);
  try {
    const result = await deliverWebhook({ id: 'w', url: hang.url, secret: 's' }, envelope, { ...LOCAL, timeoutMs: 100, retries: 0 });
    assert.equal(result.ok, false);
    assert.equal(result.status, null);
  } finally { await hang.close(); }
  const local = await receiver([200]);
  try {
    const result = await deliverWebhook({ id: 'w', url: local.url, secret: 's' }, envelope, { policy: { allowHttp: true, allowPrivate: false } });
    assert.equal(result.ok, false);
    assert.equal(local.seen.length, 0);
  } finally { await local.close(); }
});

test('notifications are stored, delivered to subscribed webhooks, listed as unread and marked read', async () => {
  const db = new PGlite();
  const target = await receiver([200]);
  try {
    for (const file of ['001_init', '002_gpu_mode', '003_default_profile_resources', '004_guest_resources', '005_host_settings', '006_adb_port_access', '008_user_adb_keys', '009_uploaded_adb_public_keys', '010_user_settings_audit', '011_node_management', '012_session_lifecycle', '013_queue_notifications']) {
      await db.exec(await readFile(new URL(`../migrations/${file}.sql`, import.meta.url), 'utf8'));
    }
    const user = '11111111-1111-4111-8111-111111111111';
    const other = '22222222-2222-4222-8222-222222222222';
    for (const id of [user, other]) await db.query("INSERT INTO users(id,provider,subject,username,display_name) VALUES($1,'local',$2,$2,$2)", [id, id.slice(0, 8)]);
    await db.query("INSERT INTO webhooks(id,user_id,url,secret,events) VALUES($1,$2,$3,'sek',ARRAY['session.ready'])",
      ['b0000000-0000-4000-8000-000000000001', user, target.url]);
    await db.query("INSERT INTO webhooks(id,user_id,url,secret,events) VALUES($1,$2,$3,'sek',ARRAY['session.released'])",
      ['b0000000-0000-4000-8000-000000000002', user, target.url]);
    configureNotifications({ webhookAllowHttp: true, webhookAllowPrivate: true });
    const pool = { query: db.query.bind(db) } as unknown as Pool;
    await notifyUser(pool, user, { kind: 'session.ready', title: 'Устройство готово', body: 'Pixel', sessionId: 'a0000000-0000-4000-8000-000000000001' }, { awaitWebhooks: true });
    await notifyUser(pool, other, { kind: 'session.released', title: 'Освобождена' });
    assert.equal(target.seen.length, 1, 'only the matching webhook of the right user fired');
    assert.match((JSON.parse(target.seen[0]!.body) as { text: string }).text, /Устройство готово/);
    const hook = (await db.query("SELECT last_status FROM webhooks WHERE id='b0000000-0000-4000-8000-000000000001'")).rows[0] as { last_status: string };
    assert.equal(hook.last_status, 'ok');
    const unread = await unreadNotifications(pool, user);
    assert.equal(unread.length, 1);
    assert.equal(unread[0]!.kind, 'session.ready');
    assert.equal((await unreadNotifications(pool, other)).length, 1);
    assert.equal(await markNotificationsRead(pool, other, [unread[0]!.id]), 0, 'cannot mark foreign notifications');
    assert.equal(await markNotificationsRead(pool, user, [unread[0]!.id]), 1);
    assert.equal((await unreadNotifications(pool, user)).length, 0);
  } finally {
    configureNotifications({ webhookAllowHttp: false, webhookAllowPrivate: false });
    await target.close();
    await db.close();
  }
});
