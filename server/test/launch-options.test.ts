import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { parseManifest, checkManifestProfile } from '../src/profile-manifest.js';
import { parseLaunchOptions, parseEmulatorParams, resolveLaunchOptions, normalizeProfileResources, mergeLaunchStorage } from '../src/launch-options.js';

test('launch options enforce numeric storage boundaries and explicit inheritance', () => {
  assert.deepEqual(parseLaunchOptions(undefined), {});
  assert.deepEqual(parseLaunchOptions({privileged:true}), {privileged:true});
  assert.deepEqual(parseLaunchOptions({privileged:false}), {privileged:false});
  assert.deepEqual(parseLaunchOptions({ diskGb: 2, sdCardMb: 0, emulatorParams: '' }), { diskGb: 2, sdCardMb: 0, emulatorParams: '' });
  assert.deepEqual(parseLaunchOptions({ diskGb: 128, sdCardMb: 32768 }), { diskGb: 128, sdCardMb: 32768 });
  assert.deepEqual(resolveLaunchOptions({ cpu: 4, memory_mb: 4096, disk_gb: 16, emulator_params: '-no-snapshot' }, {}), { cpu: 4, memoryMb: 4096, guestCores: null, guestMemoryMb: null, diskGb: 16, sdCardMb: 0, emulatorParams: '-no-snapshot' });
  assert.deepEqual(resolveLaunchOptions({ cpu: 4, memory_mb: 4096, disk_gb: 16, emulator_params: '-no-snapshot' }, { sdCardMb: 0, emulatorParams: '' }), { cpu: 4, memoryMb: 4096, guestCores: null, guestMemoryMb: null, diskGb: 16, sdCardMb: 0, emulatorParams: '' });
  for (const value of [null, [], '', { diskGb: '32' }, { diskGb: 1 }, { diskGb: 129 }, { diskGb: 2.5 }, { sdCardMb: -1 }, { sdCardMb: 127 }, { sdCardMb: 32769 }, { sdCardMb: null }, { privileged: 'true' }, { privileged: 1 }, { privileged: null }, { emulatorParams: null }]) assert.throws(() => parseLaunchOptions(value));
});
test('emulator arguments reject Docker, host paths, shell expansion and overrides of typed controls', () => {
  assert.equal(parseEmulatorParams('  -no-snapshot   -timezone Europe/Moscow -netdelay 20:100 -netspeed lte -change-language ru -change-country RU '), '-no-snapshot -timezone Europe/Moscow -netdelay 20:100 -netspeed lte -change-language ru -change-country RU');
  for (const args of ['--privileged', '--volume /:/host', '-qemu -drive /host', '-http-proxy localhost:1234', '-sdcard /host', '-partition-size 999', '-gpu host', '-memory 8192', '-ports 5554,5555', '-timezone ../../etc', '-netdelay 2:1', '-netspeed 0', '-netdelay 60001', '-noaudio -no-audio', '-nocache -no-cache', '-verbose -verbose', '-no-snapshot;id', '-no-snapshot $(id)', '-no-snapshot\n-verbose', '-timezone', 'x'.repeat(501)]) assert.throws(() => parseEmulatorParams(args), args);
});


test('network upload and download rates are independent while delay ranges stay ordered', () => {
  assert.equal(parseEmulatorParams('-netspeed 1000:100'), '-netspeed 1000:100');
  assert.throws(() => parseEmulatorParams('-netdelay 1000:100'));
});
test('server and agent agree on accepted emulator arguments', async () => {
  const { validateEmulatorParams } = await import(new URL('../../agent/src/emulator-params.mjs', import.meta.url).href);
  for (const input of ['', '-no-metrics', '-no-snapshot -no-metrics', '-no-metrics -no-metrics', '-no-metrics yes', ' -no-snapshot  -verbose ', '-timezone Europe/Moscow', '-timezone America/Argentina/Buenos_Aires', '-timezone UTC', '-timezone A/B/C/D', '-change-language ru -change-country RU', '-noaudio -no-audio', '-nocache -no-cache', '-netspeed 1000:100', '-netdelay 20:100', '-netdelay 100:20', '-camera-front emulated -screen multi-touch', '-qemu -drive /host', '--privileged', '-no-snapshot\n-verbose']) {
    let server: string | undefined, agent: string | undefined;
    try { server = parseEmulatorParams(input); } catch { /* rejected */ }
    try { agent = validateEmulatorParams(input); } catch { /* rejected */ }
    assert.equal(server, agent, input);
  }
});


test('older profile resource arguments become bounded typed defaults before applying typed session overrides', () => {
  const profile = { cpu: 4, memory_mb: 4096, disk_gb: 16, emulator_params: '-no-snapshot -memory 2048 -cores=2', guest_memory_mb: null, guest_cores: null };
  const normalized = normalizeProfileResources(profile);
  assert.equal(normalized.guest_memory_mb, 2048); assert.equal(normalized.guest_cores, 2);
  assert.equal(normalized.emulator_params, '-no-snapshot');
  assert.equal(profile.guest_memory_mb, null);
  assert.deepEqual(resolveLaunchOptions(profile, {}), { cpu: 4, memoryMb: 4096, guestCores: 2, guestMemoryMb: 2048, diskGb: 16, sdCardMb: 0, emulatorParams: '-no-snapshot' });
  assert.throws(() => parseLaunchOptions({ emulatorParams: '-memory 2048' }));
  for (const change of [{ guest_memory_mb: 2048 }, { cpu: 1 }, { memory_mb: 2048 }, { emulator_params: '-cores 2 -cores 2' }]) assert.throws(() => normalizeProfileResources({ ...profile, ...change }));
});


test('both storage contracts agree and profile maxima apply to every source', () => {
  const profile = { cpu: 4, memory_mb: 4096, disk_gb: 8, disk_max_gb: 32, sdcard_gb: 2, sdcard_max_gb: 4 };
  assert.deepEqual(mergeLaunchStorage({ diskGb: 16, sdCardMb: 2048 }, { diskGb: 16, sdcardGb: 2 }), { diskGb: 16, sdCardMb: 2048 });
  assert.deepEqual(mergeLaunchStorage({}, { diskGb: 16, sdcardGb: 2 }), { diskGb: 16, sdCardMb: 2048 });
  assert.throws(() => mergeLaunchStorage({ diskGb: 16 }, { diskGb: 24 }), { code: 'invalid_launch_options' });
  assert.throws(() => mergeLaunchStorage({ sdCardMb: 129 }, { sdcardGb: 1 }), { code: 'invalid_launch_options' });
  assert.equal(resolveLaunchOptions(profile, { sdCardMb: 129 }).sdCardMb, 129);
  assert.equal(resolveLaunchOptions(profile, {}).sdCardMb, 2048);
  for (const request of [{ diskGb: 33 }, { sdCardMb: 4097 }]) assert.throws(() => resolveLaunchOptions(profile, request), { code: 'storage_out_of_range' });
});


test('example manifest defaults resolve and pass the agent launch validator unchanged', async () => {
  const manifest = JSON.parse(await readFile(new URL('../../docs/examples/profiles-test-images.json', import.meta.url), 'utf8'));
  const { profiles, issues } = parseManifest(manifest);
  const { validateProfile } = await import(new URL('../../agent/src/config.mjs', import.meta.url).href);
  assert.deepEqual(issues, []);
  assert.equal(profiles.length, 2);
  for (const item of profiles) {
    const { parsed: profile, issue } = checkManifestProfile(item, false);
    assert.equal(issue, undefined);
    assert.ok(profile);
    const options = resolveLaunchOptions({
      cpu: profile.cpu, memory_mb: profile.memoryMb,
      guest_memory_mb: profile.guestMemoryMb, guest_cores: profile.guestCores,
      disk_gb: profile.diskGb, disk_max_gb: profile.diskMaxGb,
      sdcard_gb: profile.sdcardGb, sdcard_max_gb: profile.sdcardMaxGb,
      emulator_params: profile.emulatorParams,
    }, {});
    assert.equal(options.emulatorParams, profile.emulatorParams, profile.id);
    const checked = validateProfile({ ...profile, ...options }, [profile.image]);
    assert.equal(checked.emulatorParams, profile.emulatorParams, profile.id);
    assert.deepEqual(checked.containerEnv, profile.containerEnv, profile.id);
    assert.deepEqual(checked.dockerOptions, profile.dockerOptions, profile.id);
  }
});


test('resource overrides inherit defaults, validate effective pairs and preserve explicit image defaults', () => {
  const profile = { cpu: 4, memory_mb: 6144, guest_cores: 2, guest_memory_mb: 4096, disk_gb: 8 };
  assert.deepEqual(resolveLaunchOptions(profile, {}), { cpu: 4, memoryMb: 6144, guestCores: 2, guestMemoryMb: 4096, diskGb: 8, sdCardMb: 0, emulatorParams: '' });
  const reduced = resolveLaunchOptions(profile, { cpu: 2, memoryMb: 3072, guestCores: 1, guestMemoryMb: 2048 });
  assert.deepEqual([reduced.cpu, reduced.memoryMb, reduced.guestCores, reduced.guestMemoryMb], [2, 3072, 1, 2048]);
  assert.equal(resolveLaunchOptions(profile, { guestCores: 4, guestMemoryMb: 5120 }).guestCores, 4, 'Android may use more of the same container allocation');
  const imageDefault = resolveLaunchOptions(profile, { guestCores: null, guestMemoryMb: null });
  assert.equal(imageDefault.guestCores, null); assert.equal(imageDefault.guestMemoryMb, null);
  assert.deepEqual(parseLaunchOptions(imageDefault), imageDefault, 'stored snapshots keep nulls');
  for (const patch of [{ cpu: 1 }, { memoryMb: 4096 }, { guestCores: 5 }, { guestMemoryMb: 6144 }]) assert.throws(() => resolveLaunchOptions(profile, patch), { code: 'resources_out_of_range' });
  for (const patch of [{ cpu: 5 }, { memoryMb: 7168 }]) {
    assert.throws(() => resolveLaunchOptions(profile, patch), { code: 'resource_limit_forbidden' });
    assert.doesNotThrow(() => resolveLaunchOptions(profile, patch, { role: 'admin' }));
  }
  for (const patch of [{ cpu: '4' }, { cpu: null }, { cpu: 0 }, { cpu: 17 }, { cpu: 2.5 }, { memoryMb: 1023 }, { memoryMb: 65537 }, { memoryMb: null }, { guestCores: 0 }, { guestCores: 17 }, { guestMemoryMb: 1023 }, { guestMemoryMb: 64513 }]) assert.throws(() => parseLaunchOptions(patch), { code: 'invalid_launch_options' });
  const legacy = { ...profile, guest_cores: null, guest_memory_mb: null, emulator_params: '-memory 4096 -cores 2' };
  const override = resolveLaunchOptions(legacy, { guestMemoryMb: 2048, guestCores: 1 });
  assert.equal(override.guestMemoryMb, 2048); assert.equal(override.guestCores, 1); assert.equal(override.emulatorParams, '');
});
