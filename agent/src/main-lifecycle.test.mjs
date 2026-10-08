import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

// Isolate the real connection functions: importing main also boots providers,
// probes the host and connects to the configured broker.
const source = await readFile(new URL('./main.mjs', import.meta.url), 'utf8');
const connectionCode = source.slice(source.indexOf('function connect() {'), source.indexOf("process.on('SIGINT', shutdown);"));

function fixture() {
  const sockets = [], intervals = new Set(), reconnects = [], hellos = [], graceTimers = new Set(), stopped = [], released = [];
  class FakeWebSocket extends EventEmitter {
    static OPEN = 1;
    constructor() { super(); this.readyState = 0; sockets.push(this); }
    open() { this.readyState = FakeWebSocket.OPEN; this.emit('open'); }
    close() { this.readyState = 3; this.emit('close'); }
  }
  const context = vm.createContext({
    WebSocket: FakeWebSocket, config: { brokerUrl: 'ws://unused', token: 'unused', agentId: 'test' },
    console: { log() {}, warn() {} }, resendAlerts() {}, watchBrokerSocket() {},
    announce: () => new Promise(resolve => hellos.push(resolve)),
    setInterval: fn => { intervals.add(fn); return fn; }, clearInterval: id => intervals.delete(id),
    setTimeout: (fn, delay) => { if (delay === 20000) graceTimers.add(fn); else reconnects.push(fn); return fn; },
    clearTimeout: fn => graceTimers.delete(fn),
    inputGate: { disconnect: async () => { released.push(true); } }, rtc: { closeAll: async () => {} },
    streams: { streams: new Map([['session-1', {}]]), stop: async id => { stopped.push(id); } }, tunnels: new Map(), process: { exit() {} },
  });
  vm.runInContext('let socket, heartbeatTimer, streamDisconnectTimer; let reconnectDelayMs = 1000; let closing = false;\n' + connectionCode, context);
  return { sockets, intervals, reconnects, hellos, graceTimers, stopped, released, connect: () => vm.runInContext('connect()', context),
    shutdown: () => vm.runInContext('shutdown()', context) };
}

const flush = () => new Promise(resolve => setImmediate(resolve));

test('hello completing after disconnect cannot install a heartbeat interval', async () => {
  const broker = fixture();
  broker.connect();
  broker.sockets[0].open();
  broker.sockets[0].close();
  broker.hellos[0]();
  await flush();
  assert.equal(broker.intervals.size, 0);
  assert.equal(broker.reconnects.length, 1);
});

test('an old hello cannot replace the new connection heartbeat', async () => {
  const broker = fixture();
  broker.connect();
  broker.sockets[0].open();
  broker.sockets[0].close();
  broker.reconnects.shift()();
  broker.sockets[1].open();
  broker.hellos[1]();
  await flush();
  assert.equal(broker.intervals.size, 1);
  broker.hellos[0]();
  await flush();
  assert.equal(broker.intervals.size, 1);
  broker.sockets[1].close();
  assert.equal(broker.intervals.size, 0);
});

test('shutdown while hello is pending prevents a late heartbeat', async () => {
  const broker = fixture();
  broker.connect();
  broker.sockets[0].open();
  await broker.shutdown();
  broker.hellos[0]();
  await flush();
  assert.equal(broker.intervals.size, 0);
  assert.equal(broker.reconnects.length, 0);
});


test('brief broker reconnect releases input immediately but preserves local media', async () => {
  const broker = fixture(); broker.connect(); broker.sockets[0].open(); broker.hellos[0](); await flush();
  broker.sockets[0].close(); await flush();
  assert.equal(broker.released.length, 1);
  assert.deepEqual(broker.stopped, []);
  assert.equal(broker.graceTimers.size, 1);
  broker.reconnects.shift()(); broker.sockets[1].open();
  assert.equal(broker.graceTimers.size, 0);
  assert.deepEqual(broker.stopped, []);
  await broker.shutdown();
});

test('expired reconnect grace closes local media without killing a device', async () => {
  const broker = fixture(); broker.connect(); broker.sockets[0].open();
  broker.sockets[0].close();
  for (const expire of broker.graceTimers) expire();
  assert.deepEqual(broker.stopped, ['session-1']);
  await broker.shutdown();
});

const announcementCode = source.slice(source.indexOf('async function announce(type, connection = socket) {'), source.indexOf('async function reconcileStoppedSessions() {'));

test('blocked cleanup cannot delay heartbeats or enqueue overlapping maintenance', async () => {
  const messages = [];
  let release, reconciliations = 0, maintained = 0;
  const cleanup = new Promise(resolve => { release = resolve; });
  const context = vm.createContext({
    config: { agentId: 'node-1', name: 'Node' }, emulator: { policy: { slots: 1, revision: 1 } },
    metrics: async () => ({ kvm: true }), send: event => { messages.push(event); return true; },
    registry: { activeSessions: () => [{ sessionId: 'stopping-session' }], describeProviders: async () => [] },
    reconcileStoppedSessions: async () => { reconciliations++; await cleanup; },
    providers: [{ kind: 'emulator', maintain: async () => { maintained++; } }],
    console: { warn() {} },
  });
  vm.runInContext('let maintenanceTask; let closing = false; let socket = { readyState: 1 }; const WebSocket = { OPEN: 1 }; const heartbeatTasks = new WeakMap();\n' + announcementCode, context);
  for (let i = 0; i < 6; i++) await vm.runInContext("announce('heartbeat')", context);
  assert.equal(messages.filter(event => event.type === 'heartbeat').length, 6);
  assert.equal(reconciliations, 1, 'cleanup remains single-flight across heartbeats');
  assert.equal(maintained, 0);
  release(); await flush();
  assert.equal(maintained, 1);
  await vm.runInContext("announce('heartbeat')", context); await flush();
  assert.equal(reconciliations, 2, 'maintenance resumes after the previous pass finishes');
});


test('slow heartbeat probes coalesce and cannot publish to a replacement socket', async () => {
  const messages = []; let resolveProbe, probes = 0;
  const context = vm.createContext({
    config: { agentId: 'node-1' }, emulator: { policy: { slots: 1 } },
    metrics: () => { probes++; return new Promise(resolve => { resolveProbe = resolve; }); },
    send: event => { messages.push(event); return true; },
    registry: { activeSessions: () => [], describeProviders: async () => [] },
    reconcileStoppedSessions: async () => {}, providers: [], console: { warn() {} },
  });
  vm.runInContext('let maintenanceTask; let closing = false; let socket = { readyState: 1 }; const WebSocket = { OPEN: 1 }; const heartbeatTasks = new WeakMap();\n' + announcementCode, context);
  const pending = Array.from({ length: 8 }, () => vm.runInContext("announce('heartbeat')", context));
  assert.equal(probes, 1);
  vm.runInContext('socket = { readyState: 1 }', context);
  resolveProbe({}); await Promise.all(pending);
  assert.equal(messages.length, 0, 'old probe result is discarded');
  const next = vm.runInContext("announce('heartbeat')", context);
  resolveProbe({}); await next;
  assert.equal(messages.length, 1);
});
