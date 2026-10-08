import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import type { Pool } from 'pg';
import { ApplicationLog, redactLog, logSecrets } from '../src/application-log.js';
import { applicationRequestLog } from '../src/application-request-log.js';
import { connectServiceLog, emitServiceLog, recordServiceLog } from '../src/service-log.js';
import { registerApplicationLogRoutes } from '../src/routes/application-log-routes.js';
import { createServerContext } from '../src/server-context.js';
import { AuthService, newToken, tokenHash } from '../src/auth.js';
import { ApiError } from '../src/http-common.js';
import type { Config } from '../src/config.js';
import type { AgentHub } from '../src/agent.js';

test('runtime log captures console, redacts secrets, bounds records and replays cursors', () => {
  const logs = new ApplicationLog(3, ['known-secret']);
  const original = console.warn;
  let stdoutCalls = 0;
  console.warn = () => { stdoutCalls++; };
  const old = console.warn;
  const restore = logs.captureConsole();
  try { console.warn('Operation failed:', new Error('password=hidden-value Bearer supertoken known-secret')); }
  finally { restore(); assert.equal(console.warn, old); console.warn = original; }
  assert.equal(stdoutCalls, 1);
  assert.equal(logs.tail().records[0]!.level, 'warning');
  assert.match(logs.tail().records[0]!.message, /Operation failed/);
  assert.doesNotMatch(logs.tail().records[0]!.message, /hidden-value|supertoken|known-secret/);
  const cursor = logs.tail().records[0]!.id;
  let notifications = 0;
  const off = logs.subscribe(() => notifications++);
  for (let i = 0; i < 4; i++) logs.append('info', 'entry ' + i + 'x'.repeat(5000));
  off(); logs.append('info', 'last');
  assert.equal(notifications, 4);
  assert.equal(logs.tail().records.length, 3);
  assert.equal(logs.tail(cursor).gap, true);
  assert.ok(logs.tail().records.every(record => record.message.length <= 4096));
  assert.equal(logs.tail(logs.tail().records.at(-1)!.id).records.length, 0);
  assert.equal(logs.tail(new ApplicationLog().epoch + ':1').reset, true);
  const safe = redactLog('postgres://user:db-pass@host/database {"clientSecret":"hidden", "token": "also-hidden"} \x1b[31mred\x1b[0m\n-----BEGIN PRIVATE KEY-----\nprivate-data\n-----END PRIVATE KEY-----');
  assert.doesNotMatch(safe, /db-pass|hidden|also-hidden|private-data|\x1b/);
  assert.match(safe, /red/);
  assert.deepEqual(logSecrets({ APP_TOKEN: 'private', PATH: '/bin', DATABASE_URL: 'db' }), ['private', 'db']);
});

test('application log SSE requires administrator, replays only missed lines and closes on revoked login', { timeout: 15_000 }, async () => {
  const db = new PGlite();
  const app = express();
  const server = createServer(app);
  let stop = () => {};
  const abort = new AbortController();
  try {
    for (const file of ['001_init.sql', '005_host_settings.sql', '006_adb_port_access.sql', '008_user_adb_keys.sql', '009_uploaded_adb_public_keys.sql', '010_user_settings_audit.sql', '019_user_company.sql', '048_user_removal.sql', '049_access_roles.sql']) await db.exec(await readFile(new URL('../migrations/' + file, import.meta.url), 'utf8'));
    const pool = { query: db.query.bind(db) } as unknown as Pool;
    const config = { authMode: 'local', localAdminUsername: 'admin', localAdminPassword: 'initial-password', adminSubjects: new Set(), secureCookies: false } as Config;
    const auth = new AuthService(pool, config); await auth.bootstrap();
    const user = await auth.upsertExternalUser('ldap', 'guest', 'guest', 'Guest');
    const admin = (await db.query<{ id: string }>("SELECT id FROM users WHERE role='admin'")).rows[0]!.id;
    const cookieFor = async (id: string) => {
      const value = newToken();
      await db.query('INSERT INTO browser_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,now()+interval \'1 hour\')', [crypto.randomUUID(), id, tokenHash(value)]);
      return 'rdf_session=' + value;
    };
    const adminCookie = await cookieFor(admin); const guestCookie = await cookieFor(user.id);
    const logs = new ApplicationLog(4);
    logs.append('info', 'first'); const first = logs.tail().records[0]!.id;
    logs.append('error', 'second');
    stop = registerApplicationLogRoutes(app, createServerContext(pool, config, auth, undefined, {} as AgentHub), logs, 50);
    app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(error instanceof ApiError ? error.status : 500).json({ error: 'denied' }));
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const url = 'http://127.0.0.1:' + address.port + '/api/admin/application-log/stream';
    assert.equal((await fetch(url)).status, 401);
    assert.equal((await fetch(url, { headers: { Cookie: guestCookie } })).status, 403);
    assert.equal((await fetch(url + '?after=invalid', { headers: { Cookie: adminCookie } })).status, 400);
    const response = await fetch(url, { headers: { Cookie: adminCookie, 'Last-Event-ID': first }, signal: abort.signal });
    assert.equal(response.status, 200); assert.match(response.headers.get('content-type')!, /text\/event-stream/);
    assert.equal(response.headers.get('x-accel-buffering'), 'no');
    const reader = response.body!.getReader(); let text = '';
    const readUntil = async (value: string) => { while (!text.includes(value)) { const chunk = await reader.read(); assert.equal(chunk.done, false); text += new TextDecoder().decode(chunk.value); } };
    await readUntil('second'); assert.ok(!text.includes('"message":"first"'));
    logs.append('warning', 'third live line'); await readUntil('third live line');
    assert.match(text, /event: entry/);
    await db.query('DELETE FROM browser_sessions WHERE user_id=$1', [admin]);
    await readUntil('event: unauthorized');
    let finished = false; while (!finished) finished = (await reader.read()).done;
    assert.equal(finished, true);
    const newCookie = await cookieFor(admin);
    const active: Response[] = [];
    for (let i = 0; i < 4; i++) active.push(await fetch(url, { headers: { Cookie: newCookie }, signal: abort.signal }));
    assert.equal((await fetch(url, { headers: { Cookie: newCookie } })).status, 429);
    stop();
    for (const connection of active) await connection.body!.cancel();
  } finally { abort.abort(); stop(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await db.close(); }
});

test('service diagnostics reach runtime logs before persistence and isolate failed subscribers', async () => {
  const writes: unknown[][] = [];
  const pool = { query: async (_sql: string, values: unknown[]) => { writes.push(values); return { rows: [] }; } } as unknown as Pool;
  const logs = new ApplicationLog(10, ['configured-private-value']);
  const off = connectServiceLog(pool, logs);
  let delivered = 0;
  logs.subscribe(() => { throw new Error('broken client'); });
  logs.subscribe(() => delivered++);
  const event = { service: 'agent' as const, severity: 'warning' as const, code: 'session.boot_probe' as const, hostId: 'node-one',
    sessionId: '11111111-1111-4111-8111-111111111111', message: 'ADB not ready; token=private-token configured-private-value' };
  await recordServiceLog(pool, event);
  assert.equal(writes.length, 1);
  const line = logs.tail().records[0]!;
  assert.equal(line.source, 'agent');
  assert.equal(line.level, 'warning');
  assert.match(line.message, /session.boot_probe host=node-one session=11111111/);
  assert.doesNotMatch(line.message, /private-token|configured-private-value/);
  assert.equal(delivered, 1);
  const failing = { query: async () => { throw new Error('storage unavailable'); } } as unknown as Pool;
  const offFailing = connectServiceLog(failing, logs);
  await assert.rejects(recordServiceLog(failing, { ...event, code: 'session.start_failed', severity: 'error' }), /storage unavailable/);
  assert.equal(logs.tail().records.at(-1)!.level, 'error');
  assert.equal(delivered, 2);
  offFailing(); off();
  emitServiceLog(pool, event);
  assert.equal(delivered, 2);
});

test('ordinary API operations and service events appear live in SSE without leaking request secrets or polling noise', { timeout: 12_000 }, async () => {
  const logs = new ApplicationLog(30);
  const pool = { query: async () => ({ rows: [] }) } as unknown as Pool;
  const off = connectServiceLog(pool, logs);
  const user = { id: '11111111-1111-4111-8111-111111111111', username: 'admin', role: 'admin' };
  const auth = { authenticate: async () => ({ user, via: 'cookie' }) } as unknown as AuthService;
  const app = express();
  app.use(applicationRequestLog(logs, 50));
  app.use(express.json());
  const context = createServerContext(pool, { authMode: 'local' } as Config, auth, undefined, {} as AgentHub);
  const stop = registerApplicationLogRoutes(app, context, logs);
  app.post('/api/sessions', context.requireAuth, async (_req, res) => {
    await recordServiceLog(pool, { service: 'server', severity: 'info', code: 'session.launch_requested', hostId: 'node-one', sessionId: user.id });
    res.status(202).json({ ok: true });
  });
  app.post('/api/operations/:privateValue', (_req, res) => res.status(204).end());
  app.get('/api/quiet', (_req, res) => res.json({ ok: true }));
  app.get('/api/failure', (_req, res) => { res.locals.applicationError = 'permission_denied'; res.status(403).end(); });
  app.get('/api/slow', (_req, res) => setTimeout(() => res.json({ ok: true }), 75));
  const server = createServer(app);
  const abort = new AbortController();
  const deadline = setTimeout(() => abort.abort(), 10_000);
  try {
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const base = 'http://127.0.0.1:' + address.port;
    const response = await fetch(base + '/api/admin/application-log/stream', { signal: abort.signal });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder(); let text = '';
    const readUntil = async (value: string) => {
      while (!text.includes(value)) { const chunk = await reader.read(); assert.equal(chunk.done, false); text += decoder.decode(chunk.value, { stream: true }); }
    };
    await readUntil('event: ready');
    assert.equal((await fetch(base + '/api/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'body-private-value' }) })).status, 202);
    await readUntil('http.completed POST /api/sessions status=202');
    assert.match(text, /session.launch_requested host=node-one session=11111111/);
    await recordServiceLog(pool, { service: 'emulator', severity: 'error', code: 'container.state', hostId: 'node-one', sessionId: user.id, message: 'exited; exitCode=64' });
    await readUntil('exitCode=64');
    assert.match(text, /"source":"emulator"/);
    const before = logs.tail().records.length;
    await fetch(base + '/api/quiet?token=query-private-value');
    assert.equal(logs.tail().records.length, before);
    await fetch(base + '/api/operations/url-private-value?token=query-private-value', {
      method: 'POST', headers: { 'content-type': 'application/json', Authorization: 'Bearer header-private-value' }, body: JSON.stringify({ password: 'body-private-value' }),
    });
    await readUntil('http.completed POST /api/operations/:privateValue status=204');
    await fetch(base + '/api/failure'); await readUntil('code=permission_denied');
    await fetch(base + '/api/slow'); await readUntil('http.completed GET /api/slow status=200');
    const entries = logs.tail().records;
    assert.equal(entries.filter(record => record.message.includes('http.completed POST /api/sessions')).length, 1);
    assert.equal(entries.find(record => record.message.includes('status=403'))!.level, 'warning');
    assert.equal(entries.find(record => record.message.includes('/api/slow'))!.level, 'warning');
    assert.doesNotMatch(text, /body-private-value|url-private-value|query-private-value|header-private-value/);
    stop(); await reader.cancel();
  } finally {
    clearTimeout(deadline); abort.abort(); stop(); off(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
