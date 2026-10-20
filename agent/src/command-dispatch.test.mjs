import { DeviceProvider } from './providers/base.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { dispatchCommand, dispatchNodeAction } from './command-dispatch.mjs';
import { ScrcpyStream, StreamManager, encodeKeyPress, encodeTextInput } from './scrcpy.mjs';
import { ProviderRegistry } from './providers/registry.mjs';
import { androidOps } from './providers/android-ops.mjs';

function fixture() {
  const sessionId = 'session-1', serial = 'emulator:5555';
  const writes = [], adbCalls = [], locked = [];
  const adb = { input: (...args) => { adbCalls.push(args); return { ok: true }; } };
  const streams = new StreamManager({ adb, serverPath: '/unused', emit: () => {} });
  const stream = new ScrcpyStream({ sessionId, serial, adb, serverPath: '/unused', emit: () => {} });
  stream.controlSocket = { destroyed: false, writableLength: 0, write: message => writes.push(Buffer.from(message)) };
  stream.videoConfig = { width: 720, height: 1280 };
  streams.streams.set(sessionId, stream);
  let releaseSlow;
  const slow = new Promise(resolve => { releaseSlow = resolve; });
  const provider = new DeviceProvider({ kind: 'emulator', platform: 'android' });
  provider.sessions.set(sessionId, { serial });
  Object.defineProperty(provider, 'ops', { value: { ...androidOps({ adb, streams }), slow: () => slow } });
  const registry = new ProviderRegistry([provider]);
  let tail = Promise.resolve();
  const withSessionLock = (id, command) => {
    locked.push(id);
    const current = tail.catch(() => {}).then(command);
    tail = current;
    return current;
  };
  const dispatch = (action, params = {}) => {
    const message = { sessionId, action, params };
    return dispatchCommand(message, { streams, registry, withSessionLock,
      command: () => registry.execute(action, sessionId, params),
      validateSessionId: value => { assert.equal(value, sessionId); return value; } });
  };
  return { sessionId, serial, writes, adbCalls, locked, streams, stream, provider, dispatch, releaseSlow };
}

test('live keys, text and touch bypass a slow session command through real provider ownership', async () => {
  const f = fixture();
  const slow = f.dispatch('slow');
  try {
    assert.deepEqual(await f.dispatch('input', { kind: 'key', keyCode: 164 }), { ok: true });
    assert.deepEqual(await f.dispatch('input', { kind: 'text', text: 'one two' }), { ok: true });
    await f.dispatch('input', { kind: 'touch', action: 'down', x: 10, y: 20 });
    await f.dispatch('input', { kind: 'touch', action: 'up', x: 10, y: 20 });
    assert.deepEqual(f.writes.slice(0, 2), [encodeKeyPress(164), encodeTextInput('one two')]);
    assert.deepEqual(f.writes.slice(2).map(message => message[1]), [0, 1]);
    assert.deepEqual(f.adbCalls, []);
    assert.equal(f.locked.length, 1);
  } finally { f.releaseSlow(); await slow; }
});

test('unavailable or mismatched control keeps adb fallback behind the session lock', async () => {
  for (const mode of ['closed', 'wrong-serial', 'missing']) {
    const f = fixture();
    if (mode === 'closed') f.stream.controlSocket.destroyed = true;
    if (mode === 'wrong-serial') f.stream.serial = 'another:5555';
    if (mode === 'missing') f.streams.streams.clear();
    const slow = f.dispatch('slow');
    const input = f.dispatch('input', { kind: 'text', text: 'exactly once' });
    try {
      await new Promise(resolve => setImmediate(resolve));
      assert.deepEqual(f.adbCalls, []);
      assert.deepEqual(f.writes, []);
      assert.equal(f.locked.length, 2);
    } finally { f.releaseSlow(); await slow; }
    assert.deepEqual(await input, { ok: true });
    assert.deepEqual(f.adbCalls, [[f.serial, { kind: 'text', text: 'exactly once' }]]);
  }
});

test('control closing after realtime selection fails without unlocked adb fallback or duplicate input', async () => {
  const f = fixture();
  const select = f.streams.realtimeInput.bind(f.streams);
  f.streams.realtimeInput = (...args) => {
    const input = select(...args);
    f.stream.controlSocket.destroyed = true;
    return input;
  };
  const slow = f.dispatch('slow');
  try {
    assert.throws(() => f.dispatch('input', { kind: 'text', text: 'do not repeat' }), /control is unavailable/);
    assert.deepEqual(f.writes, []);
    assert.deepEqual(f.adbCalls, []);
    assert.equal(f.locked.length, 1);
  } finally { f.releaseSlow(); await slow; }
});

test('a leftover live stream does not bypass session lifecycle or provider capability checks', () => {
  const f = fixture();
  const input = { kind: 'key', keyCode: 164 };
  f.provider.sessions.get(f.sessionId).cleanupPending = true;
  assert.throws(() => f.dispatch('input', input), /not running/);
  f.provider.sessions.get(f.sessionId).cleanupPending = false;
  f.provider.sessions.get(f.sessionId).startupPending = true;
  assert.throws(() => f.dispatch('input', input), /not running/);
  f.provider.sessions.get(f.sessionId).startupPending = false;
  delete f.provider.ops.input;
  assert.throws(() => f.dispatch('input', input), /not supported/);
  f.provider.sessions.clear();
  assert.throws(() => f.dispatch('input', input), /not running/);
  assert.deepEqual(f.writes, []);
  assert.deepEqual(f.adbCalls, []);
  assert.deepEqual(f.locked, []);
});


test('fallback input checks its deadline again after waiting for the session lock', async () => {
  let unlock; let fresh = true; let called = false;
  const lock = new Promise(resolve => { unlock = resolve; });
  const message = { action: 'input', sessionId: 's', params: { kind: 'tap', x: 1, y: 2 } };
  const pending = dispatchCommand(message, { command: () => { called = true; },
    withSessionLock: (_id, command) => lock.then(command), registry: { isNodeAction: () => false }, streams: {},
    assertInputFresh: () => { if (!fresh) throw new Error('Input expired'); } });
  const rejected = assert.rejects(pending, /expired/);
  fresh = false; unlock(); await rejected;
  assert.equal(called, false);
});


test('first visible-frame keys and touch use the startup candidate while optional audio is still pending', async () => {
  const f = fixture();
  f.streams.streams.clear();
  let audioReady;
  f.stream.start = () => new Promise(resolve => { audioReady = resolve; });
  f.stream.close = async () => { f.stream.closed = true; };
  f.streams.createScrcpyStream = () => f.stream;
  const startup = f.dispatch('stream-start');
  await new Promise(resolve => setImmediate(resolve));
  let key, down, up;
  try {
    assert.equal(f.streams.streams.get(f.sessionId).starting, true);
    key = f.dispatch('input', { kind: 'key', keyCode: 3 });
    down = f.dispatch('input', { kind: 'touch', action: 'down', x: 10, y: 20 });
    up = f.dispatch('input', { kind: 'touch', action: 'up', x: 10, y: 20 });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(f.writes[0], encodeKeyPress(3), 'Home must reach scrcpy before optional audio settles');
    assert.deepEqual(f.writes.slice(1).map(message => message[1]), [0, 1]);
    assert.deepEqual(f.adbCalls, []);
    assert.equal(f.locked.length, 1, 'only stream-start owns the slow session lock');
  } finally {
    audioReady();
    await Promise.allSettled([startup, key, down, up]);
    await f.streams.stop(f.sessionId);
  }
});

test('startup control requires an open socket and release invalidates captured startup input', async () => {
  const f = fixture(); f.streams.streams.clear();
  let audioReady;
  f.stream.start = () => new Promise(resolve => { audioReady = resolve; });
  f.stream.close = async () => { f.stream.closed = true; };
  f.streams.createScrcpyStream = () => f.stream;
  const startup = f.streams.start(f.sessionId, f.serial);
  await new Promise(resolve => setImmediate(resolve));
  try {
    f.stream.controlSocket.destroyed = true;
    assert.equal(f.streams.realtimeInput(f.sessionId, f.serial, { kind: 'key', keyCode: 3 }), null);
    f.stream.controlSocket.destroyed = false;
    assert.equal(f.streams.realtimeInput(f.sessionId, 'other:5555', { kind: 'key', keyCode: 3 }), null);
    const captured = f.streams.realtimeInput(f.sessionId, f.serial, { kind: 'key', keyCode: 3 });
    assert.equal(typeof captured, 'function');
    await f.streams.releaseInput(f.sessionId, f.serial);
    assert.throws(captured, /reset|closed|connection/i);
    assert.deepEqual(f.writes, []);
  } finally { audioReady(); await startup; await f.streams.stop(f.sessionId); }
});


test('image node operations reply without waiting for unrelated heartbeat maintenance', async () => {
  for (const action of ['emulator-catalog', 'emulator-build', 'emulator-cancel', 'emulator-jobs', 'image-prewarm']) {
    let releaseHeartbeat, completed = false, heartbeatCalls = 0;
    const pendingHeartbeat = new Promise(resolve => { releaseHeartbeat = resolve; });
    const result = { jobs: [{ id: 'accepted-job', state: 'queued' }] };
    const registry = new ProviderRegistry([{ kind: 'emulator', nodeOps: { [action]: async params => {
      assert.equal(params.package, 'requested'); return result;
    } } }]);
    const request = dispatchNodeAction(action, { package: 'requested' }, { registry,
      announce: () => { heartbeatCalls++; return pendingHeartbeat; },
    }).then(value => { completed = true; return value; });
    try {
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(completed, true, action + ' must reply while heartbeat is unresolved');
      assert.equal(heartbeatCalls, 0);
      assert.deepEqual(await request, result);
    } finally { releaseHeartbeat(); await request; }
  }
});

test('policy node operations still refresh heartbeat and failed image requests remain failures', async () => {
  const events = [];
  const registry = { nodeAction: async action => {
    events.push(action);
    if (action === 'emulator-build') throw new Error('queue persistence failed');
    return { applied: true };
  } };
  const announce = async type => { events.push(type); };
  assert.deepEqual(await dispatchNodeAction('set-policy', {}, { registry, announce }), { applied: true });
  assert.deepEqual(events, ['set-policy', 'heartbeat']);
  await assert.rejects(dispatchNodeAction('emulator-build', {}, { registry, announce }), /queue persistence failed/);
  assert.deepEqual(events, ['set-policy', 'heartbeat', 'emulator-build']);
});
