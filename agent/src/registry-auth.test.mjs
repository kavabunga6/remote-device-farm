import test from 'node:test';
import assert from 'node:assert/strict';
import { farmRegistryPrefix, validateImage, validateProfile, validateRegistryAuth } from './config.mjs';
import { validateControlRequest } from './control-ipc.mjs';
import { DockerClient } from './docker.mjs';

const auth = { username: 'rdf', password: 'token', serveraddress: 'farm.example.com' };

test('the farm registry on the broker host is trusted without configuration; other registries still need the allowlist', () => {
  const trusted = [farmRegistryPrefix('wss://farm.example.com/agent/connect')];
  assert.deepEqual(trusted, ['farm.example.com/rdf-emulator']);
  assert.equal(validateImage('farm.example.com/rdf-emulator:34-google_apis-x86_64@sha256:' + 'b'.repeat(64), [], trusted).startsWith('farm.example.com'), true);
  assert.throws(() => validateImage('evil.example.com/rdf-emulator:34', [], trusted));
  assert.throws(() => validateImage('farm.example.com/other:1', [], trusted));
  assert.equal(farmRegistryPrefix('ws://10.0.0.5:8088/agent/connect'), '10.0.0.5:8088/rdf-emulator');
  assert.equal(farmRegistryPrefix('not a url'), null);
});

test('registry credentials are checked and travel with the profile only', () => {
  assert.deepEqual(validateRegistryAuth(auth), auth);
  for (const bad of [{ ...auth, extra: 1 }, { ...auth, serveraddress: 'https://x' }, { ...auth, password: '' }, 'x']) assert.throws(() => validateRegistryAuth(bad));
  const profile = validateProfile({ image: 'farm.example.com/rdf-emulator:34-x', cpu: 4, memoryMb: 6144, diskGb: 8, registryAuth: auth }, [], ['farm.example.com/rdf-emulator']);
  assert.deepEqual(profile.registryAuth, auth);
});

test('control requests accept builds with a registry target and contract profile fields', () => {
  const build = { op: 'emulatorBuild', packages: ['system-images;android-34;google_apis_playstore;x86_64'], target: { repository: 'farm.example.com/rdf-emulator', auth } };
  assert.equal(validateControlRequest(build), build);
  for (const bad of [{ ...build, packages: ['$(reboot)'] }, { ...build, target: { repository: 'x; rm' } }, { ...build, target: { ...build.target, dockerfile: 'FROM x' } }, { op: 'emulatorCatalog' }]) {
    assert.throws(() => validateControlRequest(bad), undefined, JSON.stringify(bad));
  }
  assert.ok(validateControlRequest({ op: 'emulatorCatalog', refresh: false }));
  assert.ok(validateControlRequest({ op: 'start', sessionId: 'session-1', adbPublicKey: 'QUJD rdf\n',
    profile: { image: 'x', cpu: 1, memoryMb: 2048, diskGb: 8, deviceType: 'tv', resolution: '1920x1080', registryAuth: auth } }));
});

test('pulling a registry image sends X-Registry-Auth', async () => {
  const docker = new DockerClient('/unused');
  const calls = [];
  const pulled = new Set();
  docker.request = async (method, path, body, options = {}) => {
    calls.push({ path, options });
    if (path.startsWith('/images/create')) { pulled.add(new URLSearchParams(path.split('?')[1]).get('fromImage')); return null; }
    if (path.endsWith('/json') && ![...pulled].some(image => path.includes(encodeURIComponent(image)))) throw new Error('No such image');
    return {};
  };
  await docker.ensureImage('farm.example.com/rdf-emulator:34@sha256:' + 'c'.repeat(64), () => {}, { auth });
  const pull = calls.find(call => call.path.startsWith('/images/create'));
  assert.deepEqual(JSON.parse(Buffer.from(pull.options.headers['X-Registry-Auth'], 'base64url')), auth);
  await docker.ensureImage('us-docker.pkg.dev/x/y:1', () => {});
  assert.deepEqual(calls.filter(call => call.path.startsWith('/images/create')).at(-1).options.headers, {});
});


test('build result acknowledgements and prewarm IPC stay typed and bounded', () => {
  assert.ok(validateControlRequest({ op: 'emulatorJobs', acknowledged: ['job-1'] }));
  assert.ok(validateControlRequest({ op: 'emulatorJobs' }), 'existing empty job requests still work');
  for (const acknowledged of ['all', Array(51).fill('job'), ['../bad']]) {
    assert.throws(() => validateControlRequest({ op: 'emulatorJobs', acknowledged }), /acknowledgements/);
  }
  const image = 'farm.example.com/rdf-emulator:34@sha256:' + 'a'.repeat(64);
  assert.ok(validateControlRequest({ op: 'prewarmImage', image, auth: null }));
  assert.throws(() => validateControlRequest({ op: 'prewarmImage', image: 'farm.example.com/rdf-emulator:34', auth: null }), /digest/);
  assert.throws(() => validateControlRequest({ op: 'prewarmImage', image, auth: null, privileged: true }), /Unexpected/);
});
