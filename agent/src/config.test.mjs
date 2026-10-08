import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, validateImage, validateNvidiaXorgModuleDir, validateProfile } from './config.mjs';

test('image references are data, never shell fragments', () => {
  assert.equal(validateImage('us-docker.pkg.dev/android-emulator-268719/images/30-google-x64:30.1.2'), 'us-docker.pkg.dev/android-emulator-268719/images/30-google-x64:30.1.2');
  assert.throws(() => validateImage('good; docker run --privileged bad'));
  assert.throws(() => validateImage('good\nBAD=1'));
  assert.throws(() => validateImage('evil.example/image:latest', ['us-docker.pkg.dev/']));
  assert.throws(() => validateImage('registry.example/emulator-evil:1', ['registry.example/emulator']));
  assert.throws(() => validateImage('registry.example/emulator:1'), /Only published Google/);
  assert.equal(validateImage('us-docker.pkg.dev/android-emulator-268719/images/30-google-x64-no-metrics:30.1.2', ['us-docker.pkg.dev/android-emulator-268719/images/']), 'us-docker.pkg.dev/android-emulator-268719/images/30-google-x64-no-metrics:30.1.2');
});

test('explicit image allowlist permits trusted ready GPU images and enforces prefix boundaries', () => {
  const image = 'rdf-gpu-emulator:android-30';
  assert.throws(() => validateImage(image), /Only published Google/);
  assert.equal(validateImage(image, ['rdf-gpu-emulator']), image);
  const digestImage = `registry.example:5000/emulators/android-30@sha256:${'a'.repeat(64)}`;
  assert.equal(validateImage(digestImage, ['registry.example:5000/emulators/']), digestImage);
  assert.equal(validateImage(digestImage, [digestImage]), digestImage);
  assert.equal(validateImage('registry.example/emulator:1', ['registry.example/emulator']), 'registry.example/emulator:1');
  const base = { image, cpu: 4, memoryMb: 6144, gpuMode: 'nvidia', gpuBackend: 'cuda' };
  assert.equal(validateProfile(base, ['rdf-gpu-emulator']).gpuMode, 'nvidia');
  for (const [candidate, prefix] of [
    ['rdf-gpu-emulator-evil:android-30', 'rdf-gpu-emulator'],
    ['registry.example.evil/emulator:1', 'registry.example'],
    ['registry.example/emulator-evil:1', 'registry.example/emulator'],
    ['registry.example/emulator:10', 'registry.example/emulator:1'],
    ['other.example/emulator:1', 'registry.example/'],
    ['us-docker.pkg.dev/android-emulator-268719/images/30-google-x64:30.1.2', 'rdf-gpu-emulator'],
  ]) {
    assert.throws(() => validateImage(candidate, [prefix]), /outside AGENT_ALLOWED_IMAGE_PREFIXES/);
  }
});

test('ready image references require a valid repository and explicit tag or digest', () => {
  for (const image of [
    'rdf-gpu-emulator', 'registry.example:5000/emulator',
    'registry.example//emulator:1', 'registry.example/Emulator:1',
    'registry.example/emulator:', 'registry.example/emulator:1:2',
    'registry.example/emulator@sha256:abc', 'registry.example/emulator@sha256:' + 'g'.repeat(64),
    'registry.example/emulator@sha512:' + 'a'.repeat(128),
    'registry.example/emulator:1/path', 'registry.example/emulator:1\\bad',
    'registry.example/emulator:1;id', 'registry.example/emulator:1\n',
  ]) {
    assert.throws(() => validateImage(image, ['rdf-gpu-emulator', 'registry.example']), /Invalid Docker image reference/, image);
  }
  const googleDigest = `us-docker.pkg.dev/android-emulator-268719/images/30-google-x64@sha256:${'b'.repeat(64)}`;
  assert.equal(validateImage(googleDigest), googleDigest);
});

test('legacy SDK build placeholders remain blocked even when explicitly allowed', () => {
  for (const image of ['rdf-sdk-emulator:android-36', 'registry.example/rdf-sdk-emulator:android-36',
    `rdf-sdk-emulator@sha256:${'a'.repeat(64)}`]) {
    assert.throws(() => validateImage(image, [image]), /SDK build placeholders/);
  }
});

test('profile only accepts bounded emulator settings', () => {
  const good = validateProfile({ image: 'us-docker.pkg.dev/android-emulator-268719/images/30-google-x64-no-metrics:30.1.2', cpu: 2, memoryMb: 4096, diskGb: 8, emulatorParams: '-no-snapshot' });
  assert.equal(good.emulatorParams, '-no-snapshot');
  assert.throws(() => validateProfile({ image: good.image, cpu: 0, memoryMb: 4096 }));
  assert.throws(() => validateProfile({ image: good.image, cpu: 2, memoryMb: 4096, emulatorParams: 'foo\nBAR=1' }));
});

test('guest resources fit inside Docker limits and do not duplicate emulator flags', () => {
  const base = { image: 'us-docker.pkg.dev/android-emulator-268719/images/30-google-x64-no-metrics:30.1.2', cpu: 4, memoryMb: 4096, diskGb: 8, emulatorParams: '' };
  const selected = validateProfile({ ...base, guestMemoryMb: 2048, guestCores: 2 });
  assert.equal(selected.guestMemoryMb, 2048);
  assert.equal(selected.guestCores, 2);
  assert.throws(() => validateProfile({ ...base, guestMemoryMb: 4096 }), /Guest memory/);
  assert.throws(() => validateProfile({ ...base, guestCores: 5 }), /Guest cores/);
  assert.throws(() => validateProfile({ ...base, guestMemoryMb: 2048, emulatorParams: '-memory 2048' }), /one place/);
  assert.throws(() => validateProfile({ ...base, guestCores: 2, emulatorParams: '-cores 2' }), /one place/);
});

test('GPU mode is explicit and cannot be overridden by emulator parameters', () => {
  const base = { image: 'us-docker.pkg.dev/android-emulator-268719/images/30-google-x64-no-metrics:30.1.2', cpu: 2, memoryMb: 4096, diskGb: 8, emulatorParams: '-no-snapshot' };
  assert.equal(validateProfile(base).gpuMode, 'software');
  assert.equal(validateProfile(base).gpuBackend, null);
  assert.equal(validateProfile({ ...base, gpuMode: 'nvidia' }).gpuBackend, null);
  assert.equal(validateProfile({ ...base, gpuMode: 'software', gpuBackend: 'cuda' }).gpuBackend, null);
  for (const gpuBackend of ['none', 'other', '', 1, {}]) assert.throws(() => validateProfile({ ...base, gpuBackend }), /GPU backend/);
  assert.equal(validateProfile({ ...base, gpuMode: 'nvidia', gpuBackend: 'gpu' }).gpuBackend, 'gpu');
  assert.equal(validateProfile({ ...base, gpuMode: 'nvidia', gpuBackend: 'cuda' }).gpuMode, 'nvidia');
  assert.throws(() => validateProfile({ ...base, gpuMode: 'nvidia-device=all' }), /GPU mode/);
  for (const emulatorParams of ['-gpu host', '--gpu host', '--gpu=host', '-no-snapshot -gpu host']) {
    assert.throws(() => validateProfile({ ...base, emulatorParams }), /GPU mode/);
  }
  assert.throws(() => validateProfile({ ...base, gpuMode: 'nvidia', gpuBackend: 'cuda', emulatorParams: '-gpu=swiftshader' }), /GPU mode/);
});

test('optional NVIDIA Xorg module path is validated at startup', () => {
  const base = { AGENT_BROKER_URL: 'ws://broker/agent/connect',
    AGENT_TOKEN: 'a'.repeat(32), AGENT_ID: 'agent-1',
    AGENT_SELF_CONTAINER_ID: 'agent-1', AGENT_SLOTS: '1' };
  assert.equal(loadConfig(base).nvidiaXorgModuleDir, null);
  const moduleDir = '/usr/lib/x86_64-linux-gnu/nvidia/xorg';
  assert.equal(loadConfig({ ...base, AGENT_NVIDIA_XORG_MODULE_DIR: moduleDir }).nvidiaXorgModuleDir, moduleDir);
  for (const bad of ['/', 'relative/path', '/usr/lib/../etc', '/usr/lib//nvidia',
    '/usr/lib/nvidia/', '/usr/lib:nvidia', '/usr/lib\nnvidia', 'C:\\nvidia']) {
    assert.throws(() => loadConfig({ ...base, AGENT_NVIDIA_XORG_MODULE_DIR: bad }),
      /AGENT_NVIDIA_XORG_MODULE_DIR/);
  }
  assert.equal(validateNvidiaXorgModuleDir(undefined), null);
});
test('physical phones are enabled only with an allowlist and an explicit wipe strategy', () => {
  const env = { AGENT_BROKER_URL: 'ws://x', AGENT_TOKEN: 'a'.repeat(32), AGENT_ID: 'agent-1' };
  assert.equal(loadConfig(env).usb.enabled, false);
  const usb = { ...env, AGENT_USB_ENABLED: '1' };
  assert.throws(() => loadConfig(usb), /AGENT_USB_ALLOWLIST/);
  assert.throws(() => loadConfig({ ...usb, AGENT_USB_ALLOWLIST: 'R58M' }), /AGENT_USB_WIPE must be command/);
  assert.throws(() => loadConfig({ ...usb, AGENT_USB_ALLOWLIST: 'R58M', AGENT_USB_WIPE: 'soft' }), /AGENT_USB_WIPE must be command/);
  const enabled = { ...usb, AGENT_USB_ALLOWLIST: 'R58M', AGENT_USB_WIPE: 'command' };
  assert.throws(() => loadConfig(enabled), /AGENT_USB_WIPE_CMD/);
  for (const command of ['/opt/rdf/reset-android.sh', '/opt/rdf/../rdf/reset-android.sh', 'relative.sh', '/opt/reset.sh\n']) {
    assert.throws(() => loadConfig({ ...enabled, AGENT_USB_WIPE_CMD: command }), /AGENT_USB_WIPE_CMD/);
  }
  assert.equal(loadConfig({ ...enabled, AGENT_USB_WIPE_CMD: '/opt/device-tools/reprovision-android' }).usb.wipeCmd, '/opt/device-tools/reprovision-android');
  assert.throws(() => loadConfig({ ...usb, AGENT_USB_ALLOWLIST: 'R58M', AGENT_USB_WIPE: 'partial' }), /partial cleanup cannot protect/);
  assert.equal(loadConfig({ ...usb, AGENT_USB_ALLOWLIST: 'R58M', AGENT_USB_WIPE: 'command', AGENT_USB_WIPE_CMD: '/opt/reset.sh' }).usb.wipe, 'command');
  assert.throws(() => loadConfig({ ...usb, AGENT_USB_ALLOWLIST: 'R58M', AGENT_USB_WIPE: 'partial', AGENT_USB_ALLOW_PARTIAL_WIPE: '1' }), /partial cleanup cannot protect/);
});

test('profile container variables are plain data and cannot override farm variables or add Docker options', async () => {
  const base = { image: 'us-docker.pkg.dev/android-emulator-268719/images/30-google-x64-no-metrics:30.1.2', cpu: 2, memoryMb: 4096, diskGb: 8, emulatorParams: '' };
  assert.deepEqual(validateProfile({ ...base, containerEnv: { WEB_VNC: 'true', _OK1: 'a b' } }).containerEnv, { WEB_VNC: 'true', _OK1: 'a b' });
  assert.deepEqual(validateProfile(base).containerEnv, {});
  for (const bad of [{ GPU_ACCELERATED: 'true' }, { gpu_accelerated: 'false' }, { ADBKEY_PUB: 'x' }, { EMULATOR_PARAMS: '-gpu host' }, { AVD_CONFIG: 'disk.dataPartition.size=1T' }, { nvidia_visible_devices: 'all' }, { LD_PRELOAD: '/x.so' }, { PATH: '/x' }, { DOCKER_HOST: 'x' },
    { '1BAD': 'x' }, { 'A-B': 'x' }, { A: 'line\nbreak' }, { A: 'x'.repeat(513) }, { A: 5 }, ['A=b'], 'A=b', Object.fromEntries(Array.from({ length: 17 }, (_, i) => ['V' + i, 'x']))]) {
    assert.throws(() => validateProfile({ ...base, containerEnv: bad }), /container environment/i, JSON.stringify(bad).slice(0, 40));
  }
});

test('profile storage: SD card size and reserved emulator flags', () => {
  const base = { image: 'us-docker.pkg.dev/android-emulator-268719/images/30-google-x64-no-metrics:30.1.2', cpu: 2, memoryMb: 4096, diskGb: 8 };
  assert.equal(validateProfile(base).sdCardMb, undefined);
  assert.equal(validateProfile({ ...base, sdcardGb: 4 }).sdCardMb, 4096);
  assert.equal(validateProfile({ ...base, sdcardGb: 0 }).sdCardMb, 0);
  assert.equal(validateProfile({ ...base, sdcardGb: 4, sdCardMb: 4096 }).sdCardMb, 4096);
  assert.throws(() => validateProfile({ ...base, sdcardGb: 4, sdCardMb: 0 }), /Conflicting SD/);
  for (const sdcardGb of [-1, 33, 1.5, 'x', '4', true]) assert.throws(() => validateProfile({ ...base, sdcardGb }));
  assert.throws(() => validateProfile({ ...base, emulatorParams: '-partition-size 99999' }));
  assert.throws(() => validateProfile({ ...base, sdcardGb: 2, emulatorParams: '-sdcard /x.img' }));
  assert.throws(() => validateProfile({ ...base, emulatorParams: '-sdcard /x.img' }), /Unsupported emulator argument/);
});

test('SD card size is optional, disabled explicitly, or bounded in MiB', () => {
  const profile = { image: 'us-docker.pkg.dev/android-emulator-268719/images/30-google-x64-no-metrics:30.1.2', cpu: 2, memoryMb: 4096 };
  assert.equal(Object.hasOwn(validateProfile(profile), 'sdCardMb'), false);
  for (const sdCardMb of [0, 128, 1024, 32768]) {
    assert.equal(validateProfile({ ...profile, sdCardMb }).sdCardMb, sdCardMb);
  }
  for (const sdCardMb of [-1, 127, 32769, 128.5, '1024', true, {}, '128;id']) {
    assert.throws(() => validateProfile({ ...profile, sdCardMb }), /sdCardMb/);
  }
});
