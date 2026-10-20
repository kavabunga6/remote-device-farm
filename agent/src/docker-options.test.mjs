import test from 'node:test';
import assert from 'node:assert/strict';
import { DockerClient } from './docker.mjs';
import { resolveGpuBackend, validateDockerOptions } from './docker-options.mjs';
import { validateProfile } from './config.mjs';

test('docker options are an allowlist', () => {
  assert.deepEqual(validateDockerOptions({ shmSizeMb: 512, ulimits: [{ name: 'nofile', soft: 1024, hard: 4096 }], tmpfs: [{ path: '/dev/shm', sizeMb: 64 }] }),
    { shmSizeMb: 512, ulimits: [{ name: 'nofile', soft: 1024, hard: 4096 }], tmpfs: [{ path: '/dev/shm', sizeMb: 64 }] });
  for (const bad of [{ privileged: true }, { devices: ['/dev/kvm'] }, { binds: ['/:/h'] }, { shmSizeMb: 1 }, { tmpfs: [{ path: '/etc', sizeMb: 1 }] },
    { sysctls: { 'kernel.core_pattern': '1' } }, { ulimits: [{ name: 'memlock', soft: 1, hard: 1 }] }, { command: [''] }, { adbKeyEnv: 'PATH' }]) {
    assert.throws(() => validateDockerOptions(bad), undefined, JSON.stringify(bad));
  }
});

test('custom variable names cannot collide with container variables', () => {
  const base = { image: 'us-docker.pkg.dev/android-emulator-268719/images/30-google-x64:30.1.2', cpu: 2, memoryMb: 4096, diskGb: 8 };
  assert.deepEqual(validateProfile({ ...base, dockerOptions: { adbKeyEnv: 'MY_KEY' } }).dockerOptions, { adbKeyEnv: 'MY_KEY' });
  assert.throws(() => validateProfile({ ...base, dockerOptions: { adbKeyEnv: 'MY_KEY' }, containerEnv: { MY_KEY: 'x' } }));
  assert.throws(() => validateProfile({ ...base, dockerOptions: { adbKeyEnv: 'MY_KEY' }, containerEnv: { my_key: 'x' } }));
});

test('createEmulator applies the allowlisted container options and custom variable names', async () => {
  const docker = new DockerClient('/unused');
  const calls = [];
  docker.ensureSessionNetworks = async () => ({ management: 'm', egress: 'e' });
  docker.request = async (method, path, body) => { calls.push({ path, body }); return path.startsWith('/containers/create') ? { Id: 'c1' } : {}; };
  await docker.createEmulator({ sessionId: 's', agentId: 'h', selfContainerId: 'a', adbPublicKey: 'KEY',
    profile: { image: 'x/y:1', cpu: 2, memoryMb: 4096, guestMemoryMb: null, guestCores: null, diskGb: 4, emulatorParams: '-no-snapshot', containerEnv: { SECRET: 'v' },
      dockerOptions: { shmSizeMb: 256, ulimits: [{ name: 'nofile', soft: 1, hard: 2 }], tmpfs: [{ path: '/dev/shm', sizeMb: 8 }], sysctls: { 'net.core.somaxconn': '128' },
        command: ['run', '--x'], entrypoint: ['/start.sh'], adbKeyEnv: 'MY_ADB_KEY', emulatorParamsEnv: 'EMU_ARGS' } } });
  const body = calls.find((call) => call.path.startsWith('/containers/create')).body;
  assert.ok(body.Env.includes('MY_ADB_KEY=KEY'));
  assert.ok(body.Env.some((value) => value.startsWith('EMU_ARGS=-no-snapshot')));
  assert.ok(!body.Env.some((value) => value.startsWith('ADBKEY_PUB=') || value.startsWith('EMULATOR_PARAMS=')));
  assert.equal(body.HostConfig.ShmSize, 256 * 1024 * 1024);
  assert.deepEqual(body.HostConfig.Ulimits, [{ Name: 'nofile', Soft: 1, Hard: 2 }]);
  assert.deepEqual(body.HostConfig.Tmpfs, { '/dev/shm': 'rw,noexec,nosuid,size=8m', '/rdf-network': 'rw,noexec,nosuid,size=40m,mode=0700' });
  assert.deepEqual(body.HostConfig.Sysctls, { 'net.core.somaxconn': '128' });
  assert.deepEqual(body.Entrypoint, ['/start.sh']);
  assert.deepEqual(body.Cmd, ['run', '--x']);
  assert.equal(body.HostConfig.Privileged, undefined);
  assert.equal(body.HostConfig.NetworkMode, 'm');
});

test('an image that passes some emulator flags itself can switch the farm flags off', async () => {
  assert.throws(() => validateDockerOptions({ farmFlags: ['gpu', 'gpu'] }));
  assert.throws(() => validateDockerOptions({ farmFlags: ['audio'] }));
  const docker = new DockerClient('/unused');
  const calls = [];
  docker.ensureSessionNetworks = async () => ({ management: 'm', egress: 'e' });
  docker.request = async (method, path, body) => { calls.push({ path, body }); return path.startsWith('/containers/create') ? { Id: 'c1' } : {}; };
  await docker.createEmulator({ sessionId: 's', agentId: 'h', selfContainerId: 'a', adbPublicKey: 'KEY',
    profile: { image: 'x/y:1', cpu: 2, memoryMb: 4096, guestMemoryMb: 2048, guestCores: 2, diskGb: 4, emulatorParams: '-no-metrics', containerEnv: { MEMORY: '2048', CORES: '2' },
      dockerOptions: { emulatorParamsEnv: 'EXTRA_FLAGS', farmFlags: ['partition-size'] } } });
  const env = calls.find((call) => call.path.startsWith('/containers/create')).body.Env;
  assert.ok(env.includes('EXTRA_FLAGS=-no-metrics -partition-size 4096'), env.join('|'));
});

const createBody = async (profile, extra = {}, imageConfig = {}) => {
  const docker = new DockerClient('/unused');
  const calls = [];
  docker.ensureSessionNetworks = async () => ({ management: 'm', egress: 'e' });
  docker.request = async (method, path, body) => {
    calls.push({ path, body });
    if (path.startsWith('/images/')) return { Config: imageConfig };
    return path.startsWith('/containers/create') ? { Id: 'c1' } : {};
  };
  await docker.createEmulator({ sessionId: 's', agentId: 'h', selfContainerId: 'a', adbPublicKey: 'KEY', ...extra,
    profile: { image: 'x/y:1', cpu: 2, memoryMb: 4096, guestMemoryMb: null, guestCores: null, diskGb: 4, emulatorParams: '-no-snapshot', containerEnv: {}, ...profile } });
  return calls.find((call) => call.path.startsWith('/containers/create')).body;
};

test('GPU configuration uses the node backend, not per-profile Docker overrides', () => {
  for (const gpu of [{}, { kind: 'dri' }, { capabilities: ['compute'] }, { flags: { accelerated: ['-gpu', 'host'] } }, { env: { accelerated: { GPU_ACCELERATED: 'true' } } }]) {
    assert.throws(() => validateDockerOptions({ gpu }), /gpu is not allowed/);
  }
  assert.throws(() => validateDockerOptions({ emulatorParamsEnv: 'GPU_ACCELERATED' }));
});

test('CUDA automatically controls image-declared GPU switch without changing the image or duplicating renderer flags', async () => {
  const profile = { gpuMode: 'nvidia', gpuBackend: 'cuda', dockerOptions: { emulatorParamsEnv: 'EXTRA_FLAGS', farmFlags: ['partition-size'] } };
  const imageConfig = { Env: ['GPU_ACCELERATED=false'], Entrypoint: ['/original-entrypoint'], Cmd: ['original-arg'] };
  const body = await createBody(profile, {}, imageConfig);
  assert.equal(body.Image, 'x/y:1');
  assert.equal(body.Entrypoint, undefined);
  assert.equal(body.Cmd, undefined);
  assert.equal(body.HostConfig.Memory, 4096 * 1024 * 1024);
  assert.ok(body.Env.includes('NVIDIA_DRIVER_CAPABILITIES=compute,graphics,utility,display'));
  assert.equal(body.HostConfig.Runtime, 'nvidia');
  assert.ok(body.Env.includes('GPU_ACCELERATED=true'));
  assert.ok(body.Env.includes('EXTRA_FLAGS=-no-snapshot -partition-size 4096'));
  assert.deepEqual(body.HostConfig.DeviceRequests, [{ Driver: 'nvidia', Count: 1, Capabilities: [['gpu']] }]);
  const off = await createBody({ ...profile, gpuMode: 'software' }, {}, { Env: ['GPU_ACCELERATED=true'] });
  assert.equal(off.Image, body.Image);
  assert.equal(off.HostConfig.Memory, body.HostConfig.Memory);
  assert.ok(off.Env.includes('GPU_ACCELERATED=false'));
  assert.ok(off.Env.includes('NVIDIA_VISIBLE_DEVICES=void'));
  assert.equal(off.HostConfig.DeviceRequests, undefined);
  assert.equal(off.HostConfig.Runtime, undefined);
  assert.ok(off.Env.includes('EXTRA_FLAGS=-no-snapshot -partition-size 4096'));
});

test('declared GPU switch also suppresses the default farm renderer flag', async () => {
  const body = await createBody({ gpuMode: 'nvidia', gpuBackend: 'cuda' }, {}, { Env: ['GPU_ACCELERATED=false'] });
  assert.ok(body.Env.includes('GPU_ACCELERATED=true'));
  assert.ok(!body.Env.some(value => value.includes('-gpu')));
});

test('plain GPU mode passes the render node through and uses no NVIDIA runtime', async () => {
  const body = await createBody({ gpuMode: 'nvidia', gpuBackend: 'gpu' }, { driDevice: '/dev/dri/renderD128' });
  assert.ok(body.HostConfig.Devices.some((device) => device.PathOnHost === '/dev/dri/renderD128' && device.PathInContainer === '/dev/dri/renderD128'));
  assert.equal(body.HostConfig.DeviceRequests, undefined);
  assert.equal(body.HostConfig.Runtime, undefined);
  assert.ok(body.Env.includes('NVIDIA_VISIBLE_DEVICES=void'));
  assert.ok(body.Env.some((value) => /^EMULATOR_PARAMS=.* -gpu host$/.test(value)), body.Env.join('|'));
  await assert.rejects(() => createBody({ gpuMode: 'nvidia', gpuBackend: 'gpu' }), /AGENT_DRI_DEVICE/);
});

test('generic image receives exactly one renderer flag for the selected mode', async () => {
  for (const [gpuMode, renderer] of [['software', 'swiftshader_indirect'], ['nvidia', 'host']]) {
    const body = await createBody({ gpuMode, gpuBackend: 'cuda' });
    const params = body.Env.find(value => value.startsWith('EMULATOR_PARAMS='));
    assert.equal((params.match(/-gpu /g) ?? []).length, 1);
    assert.ok(params.endsWith('-gpu ' + renderer));
  }
});

test('unsupported GPU selection fails before allocating networks or containers', async () => {
  const docker = new DockerClient('/unused');
  const calls = [];
  docker.request = async (method, path) => { calls.push(path); return { Config: {} }; };
  docker.ensureSessionNetworks = async () => { throw new Error('must not allocate networks'); };
  const args = { sessionId: 's', agentId: 'h', selfContainerId: 'a', adbPublicKey: 'KEY',
    profile: { image: 'x/y:1', gpuMode: 'nvidia' } };
  await assert.rejects(() => docker.createEmulator(args), /GPU backend/);
  assert.deepEqual(calls, []);
});


test('GPU backend comes from current node capabilities for every profile', () => {
  const selected = { gpuMode: 'nvidia' };
  assert.equal(resolveGpuBackend(selected, { gpuCapabilities: ['cuda', 'gpu'] }), 'cuda');
  assert.equal(resolveGpuBackend(selected, { gpuCapabilities: ['gpu'] }), 'gpu');
  assert.equal(resolveGpuBackend({ ...selected, gpuBackend: 'gpu' }, { gpuCapabilities: ['cuda', 'gpu'] }), 'gpu');
  assert.equal(resolveGpuBackend({ gpuMode: 'software', gpuBackend: 'cuda' }, { gpuCapabilities: [] }), null);
  // Explicit readiness data takes precedence over stale legacy booleans or a GPU model.
  for (const host of [{}, { gpuPresent: true, gpuModel: 'NVIDIA' },
    { gpuCapabilities: [], nvidiaGpuAvailable: true, nvidiaRuntime: true }]) {
    assert.throws(() => resolveGpuBackend(selected, host), /not available on this node/);
  }
  assert.throws(() => resolveGpuBackend({ ...selected, gpuBackend: 'cuda' }, { gpuCapabilities: ['gpu'] }), /not available on this node/);
  assert.equal(resolveGpuBackend(selected, { nvidiaRuntime: true }), 'cuda');
  assert.equal(resolveGpuBackend(selected, { driGpuAvailable: true }), 'gpu');
});


test('legacy farm flag exclusions cannot prevent requested GPU acceleration', async () => {
  const body = await createBody({ gpuMode: 'nvidia', gpuBackend: 'cuda',
    dockerOptions: { emulatorParamsEnv: 'EXTRA_FLAGS', farmFlags: [] } });
  assert.ok(body.Env.includes('EXTRA_FLAGS=-no-snapshot -gpu host'));
  assert.equal(body.HostConfig.Runtime, 'nvidia');
});


test('resolved guest resources replace declared container variables while retaining the launcher contract', async () => {
  const containerEnv = { MEMORY: '2048', CORES: '2', KEEP: 'unchanged' };
  const body = await createBody({ cpu: 6, memoryMb: 8192, guestMemoryMb: 4096, guestCores: 4, containerEnv,
    dockerOptions: { emulatorParamsEnv: 'EXTRA_FLAGS', farmFlags: ['partition-size'] } });
  assert.equal(body.HostConfig.NanoCpus, 6_000_000_000);
  assert.equal(body.HostConfig.Memory, 8192 * 1024 * 1024);
  assert.equal(body.HostConfig.MemorySwap, body.HostConfig.Memory);
  assert.deepEqual(body.Env.filter(value => /^(MEMORY|CORES|KEEP)=/.test(value)), ['MEMORY=4096', 'CORES=4', 'KEEP=unchanged']);
  assert.ok(body.Env.includes('EXTRA_FLAGS=-no-snapshot -partition-size 4096'));
  assert.equal(body.Entrypoint, undefined);
  assert.equal(body.Cmd, undefined);
  assert.deepEqual(containerEnv, { MEMORY: '2048', CORES: '2', KEEP: 'unchanged' });
});

test('image-declared memory and core variables accept selected guest resources without image name assumptions', async () => {
  const body = await createBody({ cpu: 4, memoryMb: 6144, guestMemoryMb: 3072, guestCores: 3,
    dockerOptions: { farmFlags: [] } }, {}, { Env: ['MEMORY=1024', 'CORES=1', 'UNRELATED=value'] });
  assert.ok(body.Env.includes('MEMORY=3072'));
  assert.ok(body.Env.includes('CORES=3'));
  assert.ok(body.Env.includes('EMULATOR_PARAMS=-no-snapshot'));
  assert.ok(!body.Env.some(value => value.startsWith('UNRELATED=')));
});

test('unset guest values preserve profile and image defaults even when container limits change', async () => {
  for (const resources of [{ guestMemoryMb: null, guestCores: null }, { guestMemoryMb: undefined, guestCores: undefined }]) {
    const profile = { cpu: 6, memoryMb: 8192, ...resources, dockerOptions: { farmFlags: [] } };
    const imageConfig = { Env: ['MEMORY=1024', 'CORES=1'] };
    const configured = await createBody({ ...profile, containerEnv: { MEMORY: '2048', CORES: '2' } }, {}, imageConfig);
    assert.deepEqual(configured.Env.filter(value => /^(MEMORY|CORES)=/.test(value)), ['MEMORY=2048', 'CORES=2']);
    const inherited = await createBody(profile, {}, imageConfig);
    assert.ok(!inherited.Env.some(value => /^(MEMORY|CORES)=/.test(value)));
  }
});

test('guest resource transport remains explicit per field and does not invent environment variables', async () => {
  const body = await createBody({ cpu: 4, memoryMb: 6144, guestMemoryMb: 3072, guestCores: 3,
    dockerOptions: { farmFlags: ['cores'] } }, {}, { Env: ['MEMORY=1024', 'CORES_OTHER=1'] });
  assert.ok(body.Env.includes('MEMORY=3072'));
  assert.ok(!body.Env.some(value => /^CORES=/.test(value)));
  assert.ok(body.Env.includes('EMULATOR_PARAMS=-no-snapshot -cores 3'));
  const generic = await createBody({ cpu: 4, memoryMb: 6144, guestMemoryMb: 3072, guestCores: 3 });
  assert.ok(!generic.Env.some(value => /^(MEMORY|CORES)=/.test(value)));
  assert.ok(generic.Env.some(value => /^EMULATOR_PARAMS=.* -memory 3072 -cores 3 /.test(value)));
});


test('unsupported guest resource requests fail before allocating networks or containers', async () => {
  for (const [field, flag, name] of [['guestMemoryMb', 'memory', 'MEMORY'], ['guestCores', 'cores', 'CORES']]) {
    const docker = new DockerClient('/unused');
    const calls = [];
    docker.request = async (method, path) => { calls.push(path); return { Config: { Env: ['UNRELATED=1'] } }; };
    docker.ensureSessionNetworks = async () => { throw new Error('must not allocate networks'); };
    const profile = { image: 'x/y:1', cpu: 4, memoryMb: 6144, diskGb: 4, emulatorParams: '',
      [field]: field === 'guestMemoryMb' ? 3072 : 3, dockerOptions: { farmFlags: [] } };
    await assert.rejects(() => docker.createEmulator({ sessionId: 's', agentId: 'h', selfContainerId: 'a', adbPublicKey: 'KEY', profile }),
      new RegExp(`Guest ${flag} cannot be applied.*declare ${name}`));
    assert.deepEqual(calls, ['/images/x%2Fy%3A1/json']);
  }
});

test('explicit argument and ADB variable contracts take precedence over resource variable detection', async () => {
  const body = await createBody({ cpu: 4, memoryMb: 6144, guestMemoryMb: 3072, guestCores: 3,
    dockerOptions: { emulatorParamsEnv: 'MEMORY', adbKeyEnv: 'CORES', farmFlags: ['memory', 'cores'] } }, {},
  { Env: ['MEMORY=', 'CORES='] });
  assert.deepEqual(body.Env.filter(value => value.startsWith('MEMORY=')), ['MEMORY=-no-snapshot -memory 3072 -cores 3']);
  assert.deepEqual(body.Env.filter(value => value.startsWith('CORES=')), ['CORES=KEY']);
  await assert.rejects(() => createBody({ guestMemoryMb: 2048,
    dockerOptions: { emulatorParamsEnv: 'MEMORY', farmFlags: [] } }, {}, { Env: ['MEMORY='] }), /Guest memory cannot be applied/);
});
