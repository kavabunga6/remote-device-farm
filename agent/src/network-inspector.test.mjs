import test from 'node:test';
import assert from 'node:assert/strict';
import { NetworkInspector } from './network-inspector.mjs';
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
