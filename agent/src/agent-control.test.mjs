import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentControl } from './agent-control.mjs';

const config = { agentId: 'agent-1', slots: 2, ioContainerOverride: 'io-container',
  allowedPrefixes: [], nvidiaXorgModuleDir: null };
const profile = { image: 'us-docker.pkg.dev/android-emulator-268719/images/30-google-x64-no-metrics:30.1.2', cpu: 2, memoryMb: 4096, diskGb: 8, emulatorParams: '' };
const key = 'QUJDRA== rdf@farm\n';

test('control validates profile before making Docker requests', async () => {
  const docker = { listManaged: async () => { throw new Error('Docker must not be called'); } };
  const control = new AgentControl(config, docker);
  await assert.rejects(control.start('session-1234', { ...profile, emulatorParams: 'x; rm /' }, key),
    /Invalid EMULATOR_PARAMS/);
  await assert.rejects(control.start('session-1234', { ...profile, cpu: 99 }, key), /Profile CPU/);
});

test('control admission counts existing managed Docker resources independently of I/O', async () => {
  let pulled = false;
  const docker = {
    listManaged: async () => [{ Id: 'existing-id', State: 'running',
      Labels: { 'remote-device-farm.session': 'session-old1' } }],
    inspect: async () => ({ HostConfig: { NanoCpus: 2_000_000_000, Memory: 4096 * 1024 * 1024 } }),
    request: async () => ({ NCPU: 8, MemTotal: 16 * 1024 * 1024 * 1024 }),
    ensureImage: async () => { pulled = true; },
  };
  const control = new AgentControl({ ...config, slots: 1 }, docker);
  control.hostInfo = async () => ({ kvm: true, nvidiaRuntime: false });
  await assert.rejects(control.start('session-new1', profile, key), /No free emulator slots/);
  assert.equal(pulled, false);
});

test('recovery keeps an existing emulator with network disabled and reattaches I/O only to management', async () => {
  const calls = [];
  const sessionId = 'session-1234';
  const management = 'rdf-m-' + sessionId;
  const container = { Id: 'running-id', State: 'running', Labels: { 'remote-device-farm.session': sessionId } };
  const docker = {
    listManaged: async () => [container],
    inspect: async () => ({ HostConfig: { NanoCpus: 2_000_000_000, Memory: 4096 * 1024 * 1024 },
      NetworkSettings: { Networks: { [management]: {} } } }),
    ensureNetwork: async (...args) => { calls.push(['ensureNetwork', ...args]); },
    connectAgentToManagement: async (...args) => { calls.push(['connectAgent', ...args]); },
    listManagedNetworks: async () => [{ Labels: { 'remote-device-farm.session': sessionId } }],
    removeManaged: async () => { throw new Error('Running emulator must survive recovery'); },
  };
  const recovered = await new AgentControl(config, docker).recover();
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].containerId, container.Id);
  assert.equal(recovered[0].serial, 'rdf-' + sessionId + ':5555');
  assert.equal(recovered[0].networkEnabled, false);
  assert.equal(recovered[0].cleanupPending, false);
  assert.deepEqual(calls.map((call) => call[0]), ['ensureNetwork', 'connectAgent']);
  assert.equal(calls[1][1], management);
  assert.equal(calls[1][2], 'io-container');
});

test('transient recovery failure never removes a running emulator', async () => {
  let removed = false;
  const sessionId = 'session-1234';
  const docker = {
    listManaged: async () => [{ Id: 'running-id', State: 'running', Labels: { 'remote-device-farm.session': sessionId } }],
    inspect: async () => ({ NetworkSettings: { Networks: { ['rdf-m-' + sessionId]: {} } } }),
    ensureNetwork: async () => { throw new Error('Docker daemon temporarily unavailable'); },
    removeManaged: async () => { removed = true; },
  };
  await assert.rejects(new AgentControl(config, docker).recover(), /temporarily unavailable/);
  assert.equal(removed, false);
});



test('control serializes concurrent starts and applies its own slot limit after the first create', async () => {
  const managed = [];
  let releasePull;
  let enteredPull;
  const pulling = new Promise((resolve) => { enteredPull = resolve; });
  const pullGate = new Promise((resolve) => { releasePull = resolve; });
  let creates = 0;
  const docker = {
    listManaged: async () => managed,
    ensureImage: async () => { enteredPull(); await pullGate; },
    createEmulator: async ({ sessionId }) => {
      creates++;
      managed.push({ Id: 'created-' + sessionId, State: 'running',
        Labels: { 'remote-device-farm.session': sessionId } });
      return { containerId: 'created-' + sessionId, name: 'rdf-' + sessionId };
    },
  };
  const control = new AgentControl({ ...config, slots: 1 }, docker);
  control.hostInfo = async () => ({ kvm: true, nvidiaRuntime: false });
  control.capacity = async () => ({
    occupied: managed.map(() => ({ cpu: 2, memoryMb: 4096 })),
    host: { slots: 1, cpuCores: 8, memoryTotalMb: 16384, memoryAvailableMb: 16384 },
  });
  const first = control.serialStart('session-first1', profile, key);
  const second = control.serialStart('session-second2', profile, key);
  await pulling;
  releasePull();
  assert.equal((await first).containerId, 'created-session-first1');
  await assert.rejects(second, /No free emulator slots/);
  assert.equal(creates, 1);
});

test('runtime policy expands slots and shrink does not evict running containers', async () => {
  const managed = [{ Id: 'existing-id', State: 'running', Labels: { 'remote-device-farm.session': 'session-old1' } }];
  const docker = {
    listManaged: async () => managed,
    ensureImage: async () => {},
    createEmulator: async ({ sessionId }) => {
      managed.push({ Id: 'created-' + sessionId, State: 'running', Labels: { 'remote-device-farm.session': sessionId } });
      return { containerId: 'created-' + sessionId, name: 'rdf-' + sessionId };
    },
  };
  const control = new AgentControl({ ...config, slots: 1 }, docker);
  control.hostInfo = async () => ({ kvm: true, nvidiaRuntime: false });
  control.capacity = async () => ({
    occupied: managed.map(() => ({ cpu: 2, memoryMb: 4096 })),
    host: { slots: control.policy.slots, cpuCores: 16, memoryTotalMb: 65536, memoryAvailableMb: 65536 },
  });
  assert.deepEqual(await control.serialPolicy({ revision: 1, slots: 3, slotCpu: 4, slotMemoryMb: 8192 }),
    { revision: 1, slots: 3, slotCpu: 4, slotMemoryMb: 8192 });
  await control.serialStart('session-new1', profile, key);
  await control.serialStart('session-new2', profile, key);
  assert.equal(managed.length, 3);
  await control.serialPolicy({ revision: 2, slots: 1, slotCpu: 4, slotMemoryMb: 8192 });
  assert.equal(managed.length, 3);
  await assert.rejects(control.serialStart('session-new3', profile, key), /No free emulator slots/);
  await assert.rejects(control.serialStart('session-new4', { ...profile, cpu: 5 }, key), /per-slot limit/);
  assert.equal(managed.length, 3);
});


test('control uses the node GPU backend without requiring GPU profile metadata', async () => {
  for (const [gpuCapabilities, requested, expected] of [
    [['cuda', 'gpu'], undefined, 'cuda'], [['gpu'], undefined, 'gpu'],
    [['cuda', 'gpu'], 'gpu', 'gpu'],
  ]) {
    let createdProfile;
    const docker = {
      listManaged: async () => [], ensureImage: async () => {},
      createEmulator: async ({ profile: launchProfile }) => {
        createdProfile = launchProfile;
        return { containerId: 'created', name: 'rdf-session-gpu1' };
      },
    };
    const control = new AgentControl(config, docker);
    control.hostInfo = async () => ({ kvm: true, gpuCapabilities });
    control.capacity = async () => ({ occupied: [], host: {
      slots: 2, cpuCores: 8, memoryTotalMb: 16384, memoryAvailableMb: 16384,
    } });
    await control.start('session-gpu1', { ...profile, gpuMode: 'nvidia', gpuBackend: requested }, key);
    assert.equal(createdProfile.gpuBackend, expected);
    assert.equal(createdProfile.image, profile.image);
    assert.equal(createdProfile.memoryMb, profile.memoryMb);
  }
});

test('control rejects a backend that became unavailable before pulling or creating', async () => {
  let pulled = false;
  const docker = { listManaged: async () => [], ensureImage: async () => { pulled = true; } };
  const control = new AgentControl(config, docker);
  control.hostInfo = async () => ({ kvm: true, gpuCapabilities: ['gpu'] });
  control.capacity = async () => ({ occupied: [], host: {} });
  await assert.rejects(control.start('session-gpu1', { ...profile, gpuMode: 'nvidia', gpuBackend: 'cuda' }, key), /not available on this node/);
  assert.equal(pulled, false);
});


test('prewarm validates pinned trusted images and serializes pulls without allocating containers', async () => {
  const image = profile.image + '@sha256:' + 'a'.repeat(64);
  const calls = [];
  let release;
  const barrier = new Promise(resolve => { release = resolve; });
  const docker = { ensureImage: async (value, _progress, { signal }) => {
    signal.throwIfAborted(); calls.push(value);
    if (calls.length === 1) await barrier;
  } };
  const control = new AgentControl(config, docker);
  await assert.rejects(control.prewarmImage(profile.image, null), /pinned digest/);
  await assert.rejects(control.prewarmImage('evil.example.com/image@sha256:' + 'a'.repeat(64), null), /Only published/);
  const first = control.prewarmImage(image, null);
  const second = control.prewarmImage(image.replace(/a{64}$/, 'b'.repeat(64)), null);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 1);
  release();
  assert.equal((await first).ready, true);
  assert.equal((await second).ready, true);
  assert.equal(calls.length, 2);
});

test('a cancelled or failed prewarm releases the serial pull queue', async () => {
  const image = profile.image + '@sha256:' + 'a'.repeat(64);
  let attempts = 0;
  const control = new AgentControl(config, { ensureImage: async () => { if (++attempts === 1) throw new Error('registry unreachable'); } });
  const cancelled = new AbortController(); cancelled.abort(new Error('stopped'));
  await assert.rejects(control.prewarmImage(image, null, { signal: cancelled.signal }), /stopped/);
  await assert.rejects(control.prewarmImage(image, null), /registry unreachable/);
  assert.equal((await control.prewarmImage(image, null)).ready, true);
});


test('image cancellation delegates only the selected build ledger job', async () => {
  const control = new AgentControl(config, { request: () => assert.fail('Cancellation must not issue arbitrary Docker commands') });
  const calls = [];
  control.images = { cancel: id => { calls.push(id); return { jobs: [{ id, state: 'cancelled' }] }; } };
  assert.deepEqual(await control.handle({ op: 'emulatorCancel', jobId: 'queued-build' }), { jobs: [{ id: 'queued-build', state: 'cancelled' }] });
  assert.deepEqual(calls, ['queued-build']);
});
