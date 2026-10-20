import test from 'node:test';
import assert from 'node:assert/strict';
import { NetworkInspector, validateNetworkInspectorParams } from './network-inspector.mjs';
test('capture refuses a custom proxy and restores only its own proxy', async () => {
  let setting = 'custom.test:8080', captures = 0;
  const calls = [];
  const adb = { run: async (_serial, args) => { calls.push(args); if (args.includes('get')) return { exitCode: 0, stdout: setting }; setting = args.at(-1); return { exitCode: 0, stdout: '' }; } };
  const control = { networkInspector: async (_id, params) => { captures++; return { recording: params.op === 'start' }; } };
  const inspector = new NetworkInspector(adb, control);
  await assert.rejects(inspector.command('session', 'device', { op: 'start', pcap: false }));
  assert.equal(captures, 0);
  setting = ':0';
  await inspector.command('session', 'device', { op: 'start', pcap: false });
  assert.equal(setting, '10.0.2.2:18888');
  await inspector.command('session', 'device', { op: 'stop' });
  assert.equal(setting, ':0'); assert.equal(inspector.timers.size, 0);
  setting = 'changed.test:3128';
  await inspector.command('session', 'device', { op: 'stop' });
  assert.equal(setting, 'changed.test:3128');
  inspector.dispose('session');
});

test('a failed capture start is rolled back', async () => {
  let stops = 0;
  const inspector = new NetworkInspector({ run: async () => ({ exitCode: 0, stdout: ':0' }) },
    { networkInspector: async (_id, p) => { if (p.op === 'start') throw new Error('start failed'); stops++; return {}; } });
  await assert.rejects(inspector.command('session', 'device', { op: 'start', pcap: true }), /start failed/);
  assert.equal(stops, 1); assert.equal(inspector.timers.size, 0);
});

test('ADB failures during capture setup roll back capture, proxy and timers', async () => {
  for (const failure of ['throw', 'exit', 'readback']) {
    let setting = ':0', calls = [], reads = 0;
    const original = new Error('ADB unavailable');
    const inspector = new NetworkInspector({ run: async (_serial, args) => {
      if (args.includes('get')) {
        reads++;
        if (failure === 'readback' && reads === 2) throw original;
        return { exitCode: 0, stdout: setting };
      }
      if (args.at(-1) === '10.0.2.2:18888') {
        setting = args.at(-1);
        if (failure === 'throw') throw original;
        if (failure === 'exit') return { exitCode: 1, stdout: '' };
      } else setting = args.at(-1);
      return { exitCode: 0, stdout: '' };
    } }, { networkInspector: async (_id, params) => {
      calls.push(params);
      return { recording: params.op === 'start' };
    } });
    await assert.rejects(inspector.command('session', 'device', { op: 'start', pcap: true }));
    assert.deepEqual(calls, [{ op: 'start', pcap: true }, { op: 'stop', reason: 'start_failed' }]);
    assert.equal(setting, ':0', failure);
    assert.equal(inspector.timers.size, 0);
    assert.equal(inspector.pcapTimers.size, 0);
    assert.equal(inspector.generations.size, 0);
  }
});

test('network inspector parameters cross the control boundary without extra operation fields', async () => {
  const { validateControlRequest } = await import('./control-ipc.mjs');
  for (const params of [{ op: 'start', pcap: true, captureBodies: true }, { op: 'status', summary: true },
    { op: 'pcap', offset: 0, captureId: 'a'.repeat(32) }, { op: 'stop', reason: 'time_limit' }]) {
    assert.doesNotThrow(() => validateControlRequest({ op: 'networkInspector', sessionId: 'session-1234', params }));
  }
  for (const params of [{ op: 'start', pcap: true, captureBodies: 'true' }, { op: 'status', captureBodies: true },
    { op: 'pcap', offset: -1 }, { op: 'pcap', offset: 0, captureId: 42 }, { op: 'stop', reason: 'custom' }]) {
    assert.throws(() => validateNetworkInspectorParams(params));
  }
});

test('a stale automatic stop cannot stop a later capture', async () => {
  let stops = 0;
  const inspector = new NetworkInspector({ run: async () => ({ exitCode: 0, stdout: ':0' }) },
    { networkInspector: async () => { stops++; return {}; } });
  const previous = Symbol(), current = Symbol();
  inspector.generations.set('session', current);
  await inspector.autoStop('session', 'device', 'time_limit', previous);
  assert.equal(stops, 0);
  inspector.dispose('session');
  assert.equal(inspector.generations.size, 0);
});

test('an unsuccessful stop still releases only the inspector proxy', async () => {
  let setting = '10.0.2.2:18888';
  const inspector = new NetworkInspector({ run: async (_serial, args) => {
    if (args.includes('get')) return { exitCode: 0, stdout: setting };
    setting = args.at(-1); return { exitCode: 0, stdout: '' };
  } }, { networkInspector: async () => { throw new Error('control unavailable'); } });
  await assert.rejects(inspector.command('session', 'device', { op: 'stop' }));
  assert.equal(setting, ':0');
  assert.equal(inspector.timers.size, 0);
});
