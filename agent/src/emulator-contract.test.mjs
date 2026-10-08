import test from 'node:test';
import assert from 'node:assert/strict';
import { DockerClient, contractEnv } from './docker.mjs';
import { validateProfile } from './config.mjs';

const CONTRACT = { Labels: { 'remote-device-farm.contract': 'emulator-v1' }, Env: ['PATH=/usr/bin'] };

async function create(profile, imageConfig = CONTRACT, extra = {}) {
  const docker = new DockerClient('/unused');
  const calls = [];
  docker.ensureSessionNetworks = async () => ({ management: 'm', egress: 'e' });
  docker.request = async (method, path, body) => {
    calls.push({ path, body });
    if (path.startsWith('/images/')) return { Config: imageConfig };
    return path.startsWith('/containers/create') ? { Id: 'c1' } : {};
  };
  await docker.createEmulator({ sessionId: 's', agentId: 'h', selfContainerId: 'a', adbPublicKey: 'KEY\n', ...extra,
    profile: { image: 'rdf-emulator:34-google_apis-x86_64', cpu: 4, memoryMb: 6144, guestMemoryMb: 4096, guestCores: 2, diskGb: 8,
      emulatorParams: '', containerEnv: {}, dockerOptions: {}, gpuMode: 'software', ...profile } });
  return calls.find((call) => call.path.startsWith('/containers/create')).body;
}

test('a contract image gets only RDF_* variables, no farm flags and no entrypoint override', async () => {
  const body = await create({ emulatorParams: '-no-audio', sdCardMb: 2048,
    dockerOptions: { entrypoint: ['/x'], command: ['y'], emulatorParamsEnv: 'EXTRA_FLAGS' } });
  for (const value of ['ADBKEY_PUB=KEY', 'RDF_RAM_MB=4096', 'RDF_CORES=2', 'RDF_DATA_MB=8192', 'RDF_SDCARD_MB=2048', 'RDF_DEVICE=phone',
    'RDF_GPU=off', 'RDF_EXTRA_ARGS=-no-audio -adb-path /bin/false', 'NVIDIA_VISIBLE_DEVICES=void']) assert.ok(body.Env.includes(value), value + ' in ' + body.Env.join('|'));
  assert.ok(!body.Env.some((value) => /^(EMULATOR_PARAMS|AVD_CONFIG|EXTRA_FLAGS|RDF_SD_CARD_MB)=/.test(value)), body.Env.join('|'));
  assert.equal(body.Entrypoint, undefined);
  assert.equal(body.Cmd, undefined);
  assert.deepEqual(body.HostConfig.Devices, [{ PathOnHost: '/dev/kvm', PathInContainer: '/dev/kvm', CgroupPermissions: 'rwm' }]);
  assert.equal(body.HostConfig.Memory, 6144 * 1024 * 1024);
});

test('device type and screen select the contract device preset', () => {
  const base = { memoryMb: 6144, guestMemoryMb: null, guestCores: null, cpu: 4, diskGb: 8, emulatorParams: '' };
  const env = (profile) => contractEnv({ ...base, ...profile }, 'KEY', 'off');
  assert.ok(env({ deviceType: 'tv' }).includes('RDF_DEVICE=tv'));
  assert.ok(env({ deviceType: 'automotive', resolution: '1408x792' }).includes('RDF_SCREEN=1408x792'));
  assert.ok(env({ deviceType: 'mobile', resolution: '2560x1600' }).includes('RDF_DEVICE=tablet'));
  assert.ok(env({ deviceType: 'mobile', resolution: '1080x2400' }).includes('RDF_DEVICE=phone'));
  assert.ok(env({}).includes('RDF_RAM_MB=5120'), 'without guest memory the emulator keeps 1 GiB of the container');
  assert.ok(env({}).includes('RDF_CORES=4'));
});

test('GPU on a contract image uses the node backend and the NVIDIA runtime', async () => {
  const body = await create({ gpuMode: 'nvidia', gpuBackend: 'cuda' });
  assert.ok(body.Env.includes('RDF_GPU=nvidia'));
  assert.equal(body.HostConfig.Runtime, 'nvidia');
  assert.ok(body.Env.some((value) => value.startsWith('NVIDIA_DRIVER_CAPABILITIES=')));
  const dri = await create({ gpuMode: 'nvidia', gpuBackend: 'gpu' }, CONTRACT, { driDevice: '/dev/dri/renderD128' });
  assert.ok(dri.Env.includes('RDF_GPU=dri'));
  assert.ok(dri.HostConfig.Devices.some((device) => device.PathOnHost === '/dev/dri/renderD128'));
});

test('images without the label keep the legacy launch path', async () => {
  const body = await create({}, { Env: [] });
  assert.ok(body.Env.some((value) => value.startsWith('EMULATOR_PARAMS=')));
  assert.ok(!body.Env.some((value) => value.startsWith('RDF_')));
});

test('profiles carry device type and resolution to the agent, validated', () => {
  const base = { image: 'rdf-emulator:34-google_apis-x86_64', cpu: 4, memoryMb: 6144, diskGb: 8 };
  assert.deepEqual([validateProfile({ ...base, deviceType: 'tv', resolution: '1920x1080' }, ['rdf-emulator']).deviceType,
    validateProfile({ ...base, deviceType: 'tv', resolution: '1920x1080' }, ['rdf-emulator']).resolution], ['tv', '1920x1080']);
  assert.throws(() => validateProfile({ ...base, deviceType: 'fridge' }, ['rdf-emulator']), /device type/);
  assert.throws(() => validateProfile({ ...base, resolution: '1080 x 2400' }, ['rdf-emulator']), /resolution/);
});


test('farm headless launches disable SDK helper ADB without injecting any private key', async () => {
  const body = await create({});
  assert(body.Env.includes('RDF_EXTRA_ARGS=-adb-path /bin/false'));
  assert(!body.Env.some(value => /PRIVATE.*KEY|BEGIN.*PRIVATE KEY/.test(value)));
  const generic = await create({}, { Env: [] });
  assert(!generic.Env.some(value => value.includes('-adb-path')), 'Other image entrypoints retain their declared launch behavior');
});
