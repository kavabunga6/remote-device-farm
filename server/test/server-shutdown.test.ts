import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { createServer, get } from 'node:http';
import test from 'node:test';
import type { Pool } from 'pg';
import WebSocket from 'ws';
import express from 'express';
import { AgentHub } from '../src/agent.js';
import { createServerShutdown } from '../src/index.js';
import { startQueueDispatcher, type DispatcherDeps } from '../src/queue-dispatcher.js';
import { startSessionReaper } from '../src/session-lifecycle.js';
import { startSampler } from '../src/ops-samples.js';
import { registerAuthRoutes } from '../src/routes/auth-routes.js';
import { registerOpsRoutes } from '../src/routes/ops-routes.js';
import type { ServerContext } from '../src/server-context.js';
import { attachWebSocket } from '../src/websocket.js';

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const empty = { rows: [], rowCount: 0 };
function dispatcherDeps(pool: Pool, listeners: Set<(id: string) => void>): DispatcherDeps {
  return { pool, hub: {
    hasAgent: () => false,
    onSessionClosed: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  }, config: { queueTtlMinutes: 30, maxSessionsPerUser: 3 }, policy: { idleMinutes: 0, maxHours: 0 } };
}

test('stopping a dispatcher cancels debounce and unsubscribes permanently', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const listeners = new Set<(id: string) => void>();
  let queries = 0;
  const pool = { query: async () => { queries++; return empty; } } as unknown as Pool;
  const dispatcher = startQueueDispatcher(dispatcherDeps(pool, listeners), 1000);
  const callback = [...listeners][0]!;
  callback('session');
  await dispatcher.stop();
  assert.equal(listeners.size, 0);
  callback('session');
  dispatcher.trigger();
  await dispatcher.runOnce();
  t.mock.timers.tick(10_000);
  assert.equal(queries, 0);
  await dispatcher.stop();
});

test('dispatcher stop drains its current pass and suppresses queued passes', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const gate = deferred();
  const queries: string[] = [];
  const pool = { query: async (sql: string) => {
    queries.push(sql);
    if (queries.length === 1) await gate.promise;
    return empty;
  } } as unknown as Pool;
  const dispatcher = startQueueDispatcher(dispatcherDeps(pool, new Set()), 1000);
  const pass = dispatcher.runOnce();
  void dispatcher.runOnce();
  let finished = false;
  const stopping = dispatcher.stop().then(() => { finished = true; });
  await Promise.resolve();
  assert.equal(finished, false);
  gate.resolve();
  await Promise.all([pass, stopping]);
  assert.equal(queries.filter(sql => sql.includes('q.claimed_at,q.created_at')).length, 1);
  assert.equal(queries.some(sql => sql.includes('s.started_at')), false);
  const count = queries.length;
  t.mock.timers.tick(10_000);
  assert.equal(queries.length, count);
});

test('reaper shutdown waits for its scan and skips remaining expirations', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const scan = deferred<{ rows: unknown[] }>();
  let queries = 0;
  const pool = { query: () => { queries++; return scan.promise; } } as unknown as Pool;
  const hub = { command: () => assert.fail('stopped reaper must not release a session') } as unknown as AgentHub;
  const stop = startSessionReaper(pool, hub, { idleMinutes: 0, maxHours: 0 }, () => false, 100);
  t.mock.timers.tick(100);
  let stopped = false;
  const stopping = stop().then(() => { stopped = true; });
  await Promise.resolve();
  assert.equal(stopped, false);
  scan.resolve({ rows: [{ id: 'session', host_id: 'host', owner_user_id: 'owner', lease_expired: true }] });
  await stopping;
  t.mock.timers.tick(1000);
  assert.equal(queries, 1);
});

test('a slow ops sample cannot overlap and shutdown drains its retention query', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const gate = deferred();
  const queries: string[] = [];
  const pool = { query: async (sql: string) => { queries.push(sql); if (queries.length === 1) await gate.promise; return empty; } } as unknown as Pool;
  const stop = startSampler(pool, 1);
  t.mock.timers.tick(5000);
  assert.equal(queries.length, 1);
  let stopped = false;
  const stopping = stop().then(() => { stopped = true; });
  await Promise.resolve();
  assert.equal(stopped, false);
  gate.resolve();
  await stopping;
  assert.equal(queries.length, 2);
  assert.match(queries[1]!, /DELETE FROM ops_samples/);
  t.mock.timers.tick(5000);
  assert.equal(queries.length, 2);
});

test('route disposers release auth cleanup and operations sampling timers', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let queries = 0;
  const context = {
    pool: { query: async () => { queries++; return empty; } }, config: { opsSampleSeconds: 1 },
    requireAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
    requireAdmin: (_req: unknown, _res: unknown, next: () => void) => next(),
  } as unknown as ServerContext;
  const app = express();
  const stopAuth = registerAuthRoutes(app, context);
  const stopOps = registerOpsRoutes(app, context);
  await Promise.all([stopAuth(), stopOps()]);
  assert.equal(queries, 2, 'initial operations sample drains before its disposer resolves');
  t.mock.timers.tick(3_600_000);
  assert.equal(queries, 2);
});

class FakeSocket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  bufferedAmount = 0;
  sent: string[] = [];
  terminate() { this.readyState = WebSocket.CLOSED; this.emit('close'); }
  close() { this.terminate(); }
  send(value: string, callback?: unknown) { this.sent.push(value); if (typeof callback === 'function') callback(); }
}

test('hub disposal rejects pending RPCs, closes channels, and clears its timers', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const hub = new AgentHub({ query: () => assert.fail('disposed hub must not query') } as unknown as Pool);
  const agent = new FakeSocket(), viewer = new FakeSocket(), tunnel = new FakeSocket(), awaitingHello = new FakeSocket();
  const internal = hub as any;
  internal.agents.set('host', { ws: agent, hostId: 'host', lastHeartbeat: 0 });
  hub.attachAgent(awaitingHello as unknown as WebSocket, 'other');
  hub.refreshStream = () => {};
  hub.addViewer('session', 'host', viewer as unknown as WebSocket);
  hub.addTunnel('session', 'host', tunnel as unknown as WebSocket);
  internal.scheduleKeyframeOnDrain('session', 'host', viewer);
  const rpc = assert.rejects(hub.command('host', 'session', 'start', {}, 60_000), /shutting down/);
  const stop = hub.dispose();
  assert.equal(stop, hub.dispose());
  await Promise.all([stop, rpc]);
  assert.equal(hub.hasAgent('host'), false);
  assert.equal(hub.hasActiveTunnel('session'), false);
  for (const socket of [agent, viewer, tunnel, awaitingHello]) assert.equal(socket.readyState, WebSocket.CLOSED);
  assert.equal(internal.pending.size, 0);
  assert.equal(internal.viewerDrainPolls.has(viewer), false);
  t.mock.timers.tick(120_000);
  await assert.rejects(hub.command('host', 'session', 'start', {}), /shutting down/);
});

test('an in-flight hello cannot re-register an agent after hub disposal', async () => {
  const gate = deferred();
  const entered = deferred();
  const client = { query: async (sql: string) => {
    if (sql === 'BEGIN') { entered.resolve(); await gate.promise; }
    return empty;
  }, release: () => {} };
  const hub = new AgentHub({ connect: async () => client } as unknown as Pool);
  const socket = new FakeSocket();
  hub.attachAgent(socket as unknown as WebSocket, 'host');
  socket.emit('message', JSON.stringify({ type: 'hello', hostId: 'host', slots: 1 }));
  await entered.promise;
  let stopped = false;
  const stopping = hub.dispose().then(() => { stopped = true; });
  await Promise.resolve();
  assert.equal(stopped, false);
  gate.resolve();
  await stopping;
  assert.equal(hub.hasAgent('host'), false);
  assert.equal(socket.sent.length, 0);
});

test('server shutdown closes live WebSockets and pending upgrades before ending the pool', { timeout: 5000 }, async () => {
  const credential = deferred<{ rows: { host_id: string }[] }>();
  const authenticating = deferred();
  let ended = 0;
  const pool = { query: async (sql: string) => {
    assert.match(sql, /agent_credentials/);
    authenticating.resolve();
    return credential.promise;
  }, end: async () => { ended++; } } as unknown as Pool;
  const hub = new AgentHub(pool);
  const server = createServer();
  const stopWebSocket = attachWebSocket(server, {
    pool, hub, config: { agentToken: 'bootstrap-token', bootstrapAgentId: 'host' },
  } as unknown as ServerContext);
  const stop = createServerShutdown(server, pool, async () => { await Promise.all([hub.dispose(), stopWebSocket()]); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  const agent = new WebSocket('ws://127.0.0.1:' + port + '/agent/connect', { headers: { Authorization: 'Bearer bootstrap-token' } });
  await once(agent, 'open');
  const agentClosed = new Promise<void>(resolve => agent.once('close', () => resolve()));
  const pending = new WebSocket('ws://127.0.0.1:' + port + '/agent/connect', { headers: { Authorization: 'Bearer other-token' } });
  pending.on('error', () => {});
  const pendingClosed = new Promise<void>(resolve => pending.once('close', () => resolve()));
  try {
    await authenticating.promise;
    const stopping = stop();
    assert.equal(stopping, stop(), 'repeated signals reuse the same shutdown');
    await Promise.all([agentClosed, pendingClosed]);
    assert.equal(ended, 0, 'credential lookup still owns the pool');
    credential.resolve({ rows: [{ host_id: 'late-host' }] });
    await stopping;
    assert.equal(ended, 1);
    assert.equal(hub.hasAgent('late-host'), false);
    assert.equal(server.listening, false);
    assert.equal(server.listenerCount('upgrade'), 0);
  } finally {
    credential.resolve({ rows: [] });
    agent.terminate();
    pending.terminate();
    await stop();
  }
});

test('failed service cleanup still drains active HTTP before ending the pool', { timeout: 5000 }, async () => {
  const received = deferred<import('node:http').ServerResponse>();
  const server = createServer((_req, res) => { received.resolve(res); });
  let ended = 0;
  const stop = createServerShutdown(server, { end: async () => { ended++; } }, async () => { throw new Error('cleanup failed'); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  const request = get('http://127.0.0.1:' + port, { agent: false });
  const response = await received.promise;
  const stopped = assert.rejects(stop(), /cleanup failed/);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(ended, 0);
  const finished = new Promise<void>(resolve => request.once('response', res => { res.resume(); res.once('end', () => resolve()); }));
  response.end('done');
  await Promise.all([finished, stopped]);
  assert.equal(ended, 1);
});
