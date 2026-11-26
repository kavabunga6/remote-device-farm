import test from 'node:test';
import assert from 'node:assert/strict';
import { sessionNetworks } from './docker.mjs';
import { inspectNetwork, NetworkInspector, validateNetworkInspectorParams } from './network-inspector.mjs';
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
    { networkInspector: async (_id, p) => { if (p.op === 'start') throw new Error('start failed'); if(p.op==='stop')stops++; return {}; } });
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
    assert.deepEqual(calls, [{op:'status',summary:true}, { op: 'start', pcap: true }, { op: 'stop', reason: 'start_failed' }]);
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

function dockerStdout(value) {
  const data = Buffer.from(value);
  const header = Buffer.alloc(8);
  header[0] = 1;
  header.writeUInt32BE(data.length, 4);
  return Buffer.concat([header, data]);
}

test('active and legacy proxy revisions are preserved across controller upgrades', async () => {
  for (const state of [
    {protocolVersion:3,runtimeVersion:'old',recording:true,proxyActive:true},
    {protocolVersion:2,recording:false,proxyActive:true,pcapBytes:100},
    {protocolVersion:3,runtimeVersion:'old',recording:false,proxyActive:true,activeConnections:2},
  ]) {
    const commands = new Map(); let count = 0, writes = 0;
    const docker = {
      inspect: async () => ({Config:{Labels:{'remote-device-farm.managed':'true','remote-device-farm.agent':'agent','remote-device-farm.session':'session'}},State:{Running:true}}),
      request: async (method, resource, body) => {
        if (method === 'POST') { const id = (++count).toString(16).padStart(16,'0'); commands.set(id,body.Cmd); if (body.Cmd.join(' ').includes('RDF_WRITE')) writes++; return {Id:id}; }
        return {Running:false,ExitCode:0};
      },
      requestRaw: async (_method, resource) => {
        const command = commands.get(resource.split('/')[2]);
        return dockerStdout(command[0] === 'python3' ? JSON.stringify(state) : '');
      },
    };
    const status = await inspectNetwork(docker,'container','session','agent',{op:'status'});
    assert.equal(status.runtimeCompatible,false);
    await assert.rejects(inspectNetwork(docker,'container','session','agent',{op:'start',pcap:false}));
    assert.equal(writes,0);
    assert.ok(![...commands.values()].some(cmd=>cmd.includes('shutdown')));
  }
});

const networks = sessionNetworks('session');
const helperId = 'f'.repeat(64);

function mockCaptureWithoutPython({ helperAvailable = true, sessionLabel = 'session', networkMode = networks.management } = {}) {
  const emulator = {
    Id: 'e'.repeat(64),
    Config: { Labels: {
      'remote-device-farm.managed': 'true',
      'remote-device-farm.agent': 'agent',
      'remote-device-farm.session': sessionLabel,
    } },
    State: { Running: true },
    HostConfig: { NetworkMode: networkMode },
    NetworkSettings: { Networks: { [networks.management]: {}, [networks.egress]: {} } },
  };
  const captureId = 'a'.repeat(32);
  const commands = new Map(), helpers = [], packetStarts = [];
  let helper = null, recording = false, pcapRequested = false;
  const proxy = {
    async container(parentId, session) {
      assert.equal(parentId, emulator.Id);
      assert.equal(session, 'session');
      helpers.push('lookup');
      return helper;
    },
    async available() { helpers.push('available'); return helperAvailable; },
    async start(parentId, session) {
      assert.equal(parentId, emulator.Id);
      assert.equal(session, 'session');
      helpers.push('start');
      helper = { Id: helperId, State: { Running: true } };
      return helper;
    },
  };
  const packets = {
    async available() { return true; },
    async start(...args) {
      packetStarts.push(args);
      return { pcapState: 'recording', pcapBytes: 24 };
    },
    async status() { return { pcapState: 'recording', pcapBytes: 24, packetCount: 0 }; },
  };
  const docker = {
    async inspect(id) { assert.equal(id, emulator.Id); return emulator; },
    async request(method, resource, body) {
      if (method === 'POST') {
        const id = (commands.size + 1).toString(16).padStart(8, '0');
        commands.set(id, { container: resource.split('/')[2], command: body.Cmd });
        return { Id: id };
      }
      const { container } = commands.get(resource.split('/')[2]);
      return { Running: false, ExitCode: container === emulator.Id ? 1 : 0 };
    },
    async requestRaw(_method, resource) {
      const { container, command } = commands.get(resource.split('/')[2]);
      if (container === emulator.Id) return Buffer.alloc(0);
      assert.equal(container, helper.Id);
      const [, , , script, operation] = command;
      if (script !== '/app/src/network-proxy.py') return Buffer.alloc(0);
      if (operation === 'start') {
        recording = true;
        pcapRequested = command[5] === '1';
      }
      return dockerStdout(JSON.stringify({
        available: true, protocolVersion: 3, recording, proxyActive: true, captureId, pcapRequested, entries: [],
      }));
    },
  };
  return { helpers, commands, packetStarts, captureId, emulatorId: emulator.Id,
    inspect: params => inspectNetwork(docker, emulator.Id, 'session', 'agent', params, packets, proxy) };
}

test('status reports fallback availability without starting the proxy helper', async () => {
  for (const helperAvailable of [true, false]) {
    const { inspect, helpers, commands, emulatorId } = mockCaptureWithoutPython({ helperAvailable });
    const status = await inspect({ op: 'status', summary: true });
    assert.equal(status.available, helperAvailable);
    assert.equal(status.recording, false);
    assert.deepEqual(helpers, ['lookup', 'available']);
    assert.deepEqual([...commands.values()].map(({ container, command }) => [container, command[0]]), [[emulatorId, 'sh']]);
  }
});

test('capture runs the proxy in the helper and records packets in the emulator', async () => {
  const { inspect, helpers, commands, emulatorId, captureId, packetStarts } = mockCaptureWithoutPython();
  const result = await inspect({ op: 'start', pcap: true, captureBodies: true });
  assert.equal(result.recording, true);
  assert.equal(result.pcapState, 'recording');
  assert.deepEqual(helpers, ['lookup', 'available', 'start']);
  assert.deepEqual(packetStarts, [[emulatorId, 'session', captureId]]);
  assert.ok([...commands.values()].some(({ container, command }) =>
    container === helperId && command.join(' ') === '/usr/bin/python3 -I -B /app/src/network-proxy.py start 1 1'));

  commands.clear();
  helpers.length = 0;
  const status = await inspect({ op: 'status', summary: true });
  assert.equal(status.recording, true);
  assert.deepEqual(helpers, ['lookup']);
  assert.deepEqual([...commands.values()].map(({ container, command }) => [container, command[4]]), [[helperId, 'summary']]);
});

test('the helper is never accessed for an emulator owned by another session', async () => {
  const { inspect, helpers, commands } = mockCaptureWithoutPython({ sessionLabel: 'other-session' });
  await assert.rejects(inspect({ op: 'start', pcap: false }));
  assert.deepEqual(helpers, []);
  assert.equal(commands.size, 0);
});

test('the helper is unavailable when the emulator shares a foreign network namespace', async () => {
  for (const networkMode of ['host', 'container:foreign-id']) {
    const { inspect, helpers } = mockCaptureWithoutPython({ networkMode });
    assert.equal((await inspect({ op: 'status' })).available, false);
    await assert.rejects(inspect({ op: 'start', pcap: false }));
    assert.ok(!helpers.includes('start'));
  }
});

test('a repeated start cannot stop an existing capture or disconnect its proxy', async()=>{
  const calls=[];
  const inspector=new NetworkInspector({run:async()=>({exitCode:0,stdout:'10.0.2.2:18888'})},{networkInspector:async(_id,p)=>{calls.push(p);return {recording:true};}});
  await assert.rejects(inspector.command('session','device',{op:'start',pcap:true}),/already/);
  assert.deepEqual(calls,[{op:'status',summary:true}]);
});
