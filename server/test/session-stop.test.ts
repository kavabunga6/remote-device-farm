import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import express from 'express';
import { PGlite } from '@electric-sql/pglite';
import type { Pool } from 'pg';
import type WebSocket from 'ws';
import type { AuthService } from '../src/auth.js';
import type { Config } from '../src/config.js';
import { AgentHub } from '../src/agent.js';
import { ApiError } from '../src/http-common.js';
import { createServerContext } from '../src/server-context.js';
import { registerSessionRoutes } from '../src/routes/session-routes.js';

const ID = '55555555-5555-4555-8555-555555555555';
const OWNER = '44444444-4444-4444-8444-444444444444';
const OTHER = '33333333-3333-4333-8333-333333333333';
const HOST = 'host-1';
const active = { sessionId: ID, containerId: 'container-1', preparing: false, bootReady: true };
const tick = () => new Promise(resolve => setImmediate(resolve));
function gate() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { resolve, promise }; }
async function until(check: () => Promise<boolean> | boolean) {
  const deadline = Date.now() + 1500;
  while (!await check()) { if (Date.now() > deadline) assert.fail('Expected stop state did not arrive'); await new Promise(resolve => setTimeout(resolve, 5)); }
}
async function fixture(t: { after(fn: () => Promise<void>): void }, state = 'running', online = true) {
  const db = new PGlite();
  for (const name of ['001_init', '005_host_settings', '006_adb_port_access', '008_user_adb_keys', '009_uploaded_adb_public_keys', '010_user_settings_audit', '011_node_management', '012_session_lifecycle', '046_session_diagnostics']) {
    await db.exec(await readFile(new URL('../migrations/' + name + '.sql', import.meta.url), 'utf8'));
  }
  await db.exec('ALTER TABLE sessions ADD COLUMN startup_progress jsonb; ALTER TABLE sessions ADD COLUMN startup_deadline_at timestamptz');
  const query = async (sql: string, values?: unknown[]) => {
    const result = values === undefined ? (await db.exec(sql)).at(-1) : await db.query(sql, values);
    return { ...result, rowCount: result?.rows?.length || result?.affectedRows || 0 };
  };
  const pool = { query, connect: async () => ({ query, release() {} }) } as unknown as Pool;
  for (const id of [OWNER, OTHER]) await db.query("INSERT INTO users(id,provider,subject,username,display_name) VALUES($1,'local',$2,$2,$2)", [id, id]);
  await db.query("INSERT INTO hosts(id,name,slots,status) VALUES($1,'Host',1,'online')", [HOST]);
  await db.query("INSERT INTO sessions(id,owner_user_id,host_id,profile_id,state,container_id) VALUES($1,$2,$3,'android-30',$4,'container-1')", [ID, OWNER, HOST, state]);
  await db.query('INSERT INTO host_slots(host_id,slot_index,session_id) VALUES($1,0,$2)', [HOST, ID]);
  const hub = new AgentHub(pool);
  const commands: Array<{ id: string; sessionId: string; action: string }> = [];
  const socket = { readyState: 1, send: (value: string) => {
    const event = JSON.parse(value); if (event.type === 'command') commands.push(event);
  }, close() {}, terminate() {} } as unknown as WebSocket;
  const receive = (target: AgentHub, message: Record<string, unknown>) => (target as unknown as {
    onAgentMessage(ws: WebSocket, host: string, message: Record<string, unknown>, setLink: () => void): Promise<void>;
  }).onAgentMessage(socket, HOST, message, () => {});
  const announce = (target: AgentHub, type: 'hello' | 'heartbeat', activeSessions: unknown[] = [active]) => receive(target, {
    type, hostId: HOST, name: 'Host', slots: 1, metrics: {}, activeSessions,
  });
  if (online) await announce(hub, 'hello', state === 'starting' ? [{ ...active, preparing: true }] : [active]);
  const auth = { authenticate: async (req: express.Request) => {
    if (req.headers['x-user'] === 'none') return null;
    const id = req.headers['x-user'] === 'other' ? OTHER : OWNER;
    return { user: { id, username: id, displayName: id, provider: 'local', role: req.headers['x-role'] === 'admin' ? 'admin' : 'user' }, via: 'cookie' };
  } } as unknown as AuthService;
  const context = createServerContext(pool, { authMode: 'local', idleTimeoutMinutes: 0, maxSessionHours: 0 } as Config, auth, undefined, hub);
  const app = express();
  app.use(express.json());
  registerSessionRoutes(app, context);
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (error instanceof ApiError) res.status(error.status).json({ error: { code: error.code } });
    else { console.error(error); res.status(500).json({ error: { code: 'internal_error' } }); }
  });
  const server = createServer(app);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const send = (method = 'DELETE', headers: Record<string, string> = {}, id = ID) => fetch(
    'http://127.0.0.1:' + address.port + '/api/sessions/' + id + (method === 'POST' ? '/kill' : ''),
    { method, headers, signal: AbortSignal.timeout(2000) });
  const row = async () => (await db.query<{ state: string }>('SELECT state FROM sessions WHERE id=$1', [ID])).rows[0];
  const slot = async () => (await db.query<{ session_id: string | null }>('SELECT session_id FROM host_slots WHERE host_id=$1', [HOST])).rows[0]!.session_id;
  const reply = (command: { id: string }, ok = true, target = hub) => receive(target, { type: 'result', id: command.id, ok, data: {}, error: 'cleanup failed' });
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); await hub.dispose(); await db.close(); });
  return { db, pool, hub, commands, send, row, slot, reply, announce, receive, socket };
}

test('DELETE accepts before cleanup, closes channels, retains the slot, and deduplicates HTTP and heartbeat retries', async t => {
  const f = await fixture(t);
  const closed: string[] = [];
  f.hub.onSessionClosed(id => closed.push(id));
  const response = await f.send();
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { ok: true, id: ID, accepted: true, released: false });
  assert.equal((await f.row()).state, 'stopping'); assert.equal(await f.slot(), ID);
  await until(() => f.commands.length === 1);
  assert.deepEqual(closed, [ID]); assert.deepEqual(f.commands.map(c => c.action), ['stop']);
  assert.equal((await f.send()).status, 202);
  assert.equal((await f.send('POST', { 'x-role': 'admin' })).status, 202);
  await f.announce(f.hub, 'heartbeat', []);
  assert.deepEqual(f.commands.map(c => c.action), ['stop'], 'reconciliation must not race an in-flight stop');
  assert.equal(await f.slot(), ID, 'missing inventory is not teardown confirmation');
  await f.reply(f.commands[0]!);
  await until(async () => !await f.row());
  assert.equal(await f.slot(), null);
});

for (const [state, method, role] of [['running', 'POST', 'admin'], ['starting', 'DELETE', 'user']] as const) {
  test(state + ' ' + method + ' sends background kill without releasing the slot early', async t => {
    const f = await fixture(t, state);
    const response = await f.send(method, { 'x-role': role });
    assert.equal(response.status, 202); assert.equal((await response.json()).released, false);
    await until(() => f.commands.length === 1);
    assert.deepEqual(f.commands.map(c => c.action), ['kill']); assert.equal(await f.slot(), ID);
    await f.reply(f.commands[0]!);
    await until(async () => !await f.row()); assert.equal(await f.slot(), null);
  });
}

test('failed graceful stop escalates once; failed kill retains the lease until a later heartbeat confirms cleanup', async t => {
  const f = await fixture(t);
  assert.equal((await f.send()).status, 202);
  await until(() => f.commands.length === 1);
  await f.reply(f.commands[0]!, false);
  await until(() => f.commands.length === 2);
  assert.deepEqual(f.commands.map(c => c.action), ['stop', 'kill']);
  await f.reply(f.commands[1]!, false);
  await until(() => !(f.hub as unknown as { cancellationInFlight: Set<string> }).cancellationInFlight.has(ID));
  assert.equal((await f.row()).state, 'stopping'); assert.equal(await f.slot(), ID);
  await f.announce(f.hub, 'heartbeat', []);
  await until(() => f.commands.length === 3);
  assert.deepEqual(f.commands.map(c => c.action), ['stop', 'kill', 'kill']);
  assert.equal(await f.slot(), ID);
  await f.reply(f.commands[2]!); await until(async () => !await f.row());
  assert.equal(await f.slot(), null);
});

test('offline acceptance survives broker restart and retries when the agent reconnects', async t => {
  const f = await fixture(t, 'running', false);
  const response = await f.send(); assert.equal(response.status, 202);
  await tick(); assert.equal((await f.row()).state, 'stopping'); assert.equal(await f.slot(), ID);
  await f.hub.dispose();
  const restarted = new AgentHub(f.pool);
  try {
    await f.announce(restarted, 'hello', []);
    await until(() => f.commands.length === 1);
    assert.deepEqual(f.commands.map(c => c.action), ['kill']); assert.equal(await f.slot(), ID);
    await f.reply(f.commands[0]!, true, restarted);
    await until(async () => !await f.row()); assert.equal(await f.slot(), null);
  } finally { await restarted.dispose(); }
});

test('a stale running heartbeat cannot release a lease after durable stop acceptance', async t => {
  const f = await fixture(t);
  await f.send();
  await f.hub.releaseSession(ID, 'running');
  assert.equal((await f.row()).state, 'stopping'); assert.equal(await f.slot(), ID);
  await until(() => f.commands.length === 1);
  await f.reply(f.commands[0]!); await until(async () => !await f.row());
});

test('background release is tracked until its database work finishes during server shutdown', async t => {
  const f = await fixture(t);
  const entered = gate(), finish = gate();
  const release = f.hub.releaseSession.bind(f.hub);
  f.hub.releaseSession = async id => { entered.resolve(); await finish.promise; await release(id); };
  await f.send(); await until(() => f.commands.length === 1); await f.reply(f.commands[0]!); await entered.promise;
  let disposed = false;
  const shutdown = f.hub.dispose().then(() => { disposed = true; });
  await tick(); assert.equal(disposed, false); assert.equal(await f.slot(), ID);
  finish.resolve(); await shutdown;
  assert.equal(await f.slot(), null);
});

test('owner and administrator authorization remain enforced before any state transition', async t => {
  const f = await fixture(t);
  assert.equal((await f.send('DELETE', { 'x-user': 'none' })).status, 401);
  assert.equal((await f.send('DELETE', { 'x-user': 'other' })).status, 404);
  assert.equal((await f.send('POST')).status, 403);
  assert.equal((await f.send('DELETE', {}, 'not-a-session')).status, 404);
  assert.equal((await f.row()).state, 'running'); assert.equal(await f.slot(), ID);
  assert.deepEqual(f.commands, []);
});


test('a received heartbeat keeps its connection alive while diagnostics storage is blocked', async t => {
  const f = await fixture(t);
  const storage = gate();
  const internal = f.hub as unknown as {
    agents: Map<string, { lastHeartbeat: number }>;
    flushMaintenanceLogs(hostId: string): Promise<void>;
    closeStaleAgents(): void;
  };
  internal.agents.get(HOST)!.lastHeartbeat = Date.now() - 60_000;
  internal.flushMaintenanceLogs = () => storage.promise;
  let closed = false;
  f.socket.close = () => { closed = true; };
  const heartbeat = f.announce(f.hub, 'heartbeat');
  try {
    await tick();
    internal.closeStaleAgents();
    assert.equal(closed, false, 'slow log writes are not a lost heartbeat');
  } finally { storage.resolve(); await heartbeat; }
});

test('background cleanup remains pending after thirty seconds without a duplicate kill or early slot release', async t => {
  const f = await fixture(t);
  await f.db.query("UPDATE sessions SET state='stopping' WHERE id=$1", [ID]);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  f.hub.stopSession(HOST, ID);
  for (let i = 0; i < 100 && !f.commands.length; i++) await tick();
  assert.deepEqual(f.commands.map(command => command.action), ['stop']);
  t.mock.timers.tick(31_000); await tick();
  assert.deepEqual(f.commands.map(command => command.action), ['stop']);
  assert.equal(await f.slot(), ID);
  t.mock.timers.reset();
  await f.reply(f.commands[0]!);
  await until(async () => !await f.row());
  assert.equal(await f.slot(), null);
});
