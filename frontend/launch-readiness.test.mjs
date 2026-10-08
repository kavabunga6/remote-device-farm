import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
const bundle = await build({ entryPoints: [fileURLToPath(new URL('./src/launch-readiness.ts', import.meta.url))], bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent' });
const { profileSettingsHref, profileLaunchIssues, hostLaunchIssues, hostGpuBackend, launchReadiness } = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].contents).toString('base64'));
const launchBundle = await build({ entryPoints: [fileURLToPath(new URL('./src/launch-options.ts', import.meta.url))], bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent' });
const { parseLaunchDraft, effectiveLaunchProfile, launchResourceError } = await import('data:text/javascript;base64,' + Buffer.from(launchBundle.outputFiles[0].contents).toString('base64'));
const profile = (patch = {}) => ({ id: 'android-29', name: 'Android 10', enabled: true, image: 'emulator:test', cpu: 4, memoryMb: 4096, abi: 'x86_64', ...patch });
const host = (id = 'node', patch = {}) => ({ id, name: id, status: 'online', disabled: false, maxSessions: 1, activeSessions: 0, slotCpu: 4, slotMemoryMb: 4096, nvidiaGpuAvailable: true, architecture: 'x64', policyPending: false, ...patch });
const codes = issues => issues.map(issue => issue.code);

test('all profiles can use GPU when the node supports it, ignoring old profile restrictions', () => {
  for (const gpuSupport of [undefined, 'none', 'cuda', 'gpu']) {
    const p = profile({ gpuSupport });
    assert.equal(launchReadiness(p, [host()], 'nvidia').state, 'ready');
    assert.equal(launchReadiness(p, [host()], 'software').state, 'ready');
  }
  assert.equal(profileSettingsHref('a&b'), '#/admin/profiles?profile=a%26b');
});

test('all node blockers are shown together with precise node links and the selected mode memory', () => {
  const p = profile({ memoryMb: 6144 });
  const h = host('gpu & lab', { disabled: true, status: 'offline', architecture: 'aarch64', nvidiaGpuAvailable: false, slotCpu: 2 });
  const result = launchReadiness(p, [h], 'nvidia', '', true);
  assert.equal(result.state, 'blocked');
  assert.deepEqual(codes(result.issues), ['host_disabled', 'host_offline', 'host_architecture', 'host_gpu_unavailable', 'host_resources', 'host_privileged_unavailable']);
  assert.ok(result.issues.every(issue => issue.message.startsWith('gpu & lab: ') && issue.remedy && issue.href === '#/admin/nodes?host=gpu%20%26%20lab'));
  assert.match(result.issues.find(issue => issue.code === 'host_resources').message, /6 ГБ.*4 ГБ/);
  assert.equal(hostLaunchIssues(p, h, 'software').find(issue => issue.code === 'host_resources').message.includes('6 ГБ'), true);
});

test('busy GPU node offers queue even while an incompatible CPU node has a free slot', () => {
  const result = launchReadiness(profile(), [host('cpu', { nvidiaGpuAvailable: false }), host('gpu', { activeSessions: 1 })], 'nvidia');
  assert.equal(result.state, 'busy'); assert.equal(result.host.id, 'gpu');
  assert.deepEqual(codes(result.issues), ['slots_busy']);
  assert.deepEqual(codes(result.nodes[0].issues), ['host_gpu_unavailable']);
  assert.deepEqual(codes(result.nodes[1].issues), ['slots_busy']);
  assert.equal(launchReadiness(profile(), [host('gpu', { activeSessions: 1 }), host('gpu-free')], 'nvidia').host.id, 'gpu-free');
});

test('disabled, offline, stale and zero-capacity nodes do not masquerade as a busy compatible node', () => {
  for (const patch of [{ disabled: true }, { status: 'offline' }, { lastSeenAt: new Date(Date.now() - 60_000).toISOString() }, { maxSessions: 0 }]) {
    assert.equal(launchReadiness(profile(), [host('unavailable', patch)], 'nvidia').state, 'blocked');
  }
  assert.equal(launchReadiness(profile(), [host('fresh', { lastSeenAt: new Date().toISOString() })], 'nvidia').state, 'ready');
  assert.equal(launchReadiness(profile(), [host('legacy-without-timestamp')], 'nvidia').state, 'ready');
  assert.equal(launchReadiness(profile(), [host('pending', { policyPending: true })], 'nvidia').state, 'ready');
});

test('both modes use the same memory and ignore legacy GPU memory overrides', () => {
  const p = profile({ gpuMemoryMb: 6144 });
  assert.equal(launchReadiness(p, [host()], 'software').state, 'ready');
  assert.equal(launchReadiness(p, [host()], 'nvidia').state, 'ready');
  assert.equal(launchReadiness(profile({ memoryMb: 6144 }), [host()], 'nvidia').state, 'blocked');
});

test('host capability inventory matches CUDA and GPU and overrides old booleans', () => {
  const nodes = [host('cuda', { gpuCapabilities: ['cuda'], nvidiaGpuAvailable: false, driGpuAvailable: true }), host('gpu', { gpuCapabilities: ['gpu'], nvidiaGpuAvailable: true, driGpuAvailable: false })];
  assert.equal(launchReadiness(profile(), nodes, 'nvidia').host.id, 'cuda');
  assert.equal(launchReadiness(profile(), [nodes[1]], 'nvidia').host.id, 'gpu');
  assert.equal(hostGpuBackend(nodes[0]), 'cuda');
  assert.equal(hostGpuBackend(nodes[1]), 'gpu');
  assert.equal(hostGpuBackend(host('both', { gpuCapabilities: ['gpu', 'cuda'] })), 'cuda');
  assert.equal(launchReadiness(profile(), [host('none', { gpuCapabilities: [] })], 'nvidia').state, 'blocked');
  assert.equal(launchReadiness(profile(), [host('legacy')], 'nvidia').state, 'ready');
});

test('manual host choice stays authoritative and closest blocked candidate preserves tie order', () => {
  const nodes = [host('poor', { nvidiaGpuAvailable: false, slotCpu: 2 }), host('closest', { slotMemoryMb: 2048 }), host('same', { slotMemoryMb: 2048 })];
  assert.equal(launchReadiness(profile(), nodes, 'nvidia').host.id, 'closest');
  assert.equal(launchReadiness(profile(), [host('chosen', { nvidiaGpuAvailable: false }), host('other')], 'nvidia', 'chosen').state, 'blocked');
  assert.equal(launchReadiness(profile(), [host('other')], 'nvidia', 'missing').issues[0].code, 'host_missing');
  assert.equal(launchReadiness(profile(), [], 'nvidia').issues[0].code, 'hosts_missing');
});

test('profile and node issues combine; missing fields and legacy graphics modes do not promise readiness', () => {
  const result = launchReadiness(profile({ enabled: false, gpuSupport: 'none' }), [host('cpu', { nvidiaGpuAvailable: false })], 'nvidia');
  assert.deepEqual(codes(result.issues), ['profile_disabled', 'host_gpu_unavailable']);
  assert.equal(profileLaunchIssues(undefined, 'software')[0].code, 'profile_missing');
  assert.ok(codes(profileLaunchIssues(profile({ image: '', memoryMb: undefined }), 'software')).includes('profile_image_missing'));
  assert.ok(codes(profileLaunchIssues(profile({ memoryMb: undefined }), 'software')).includes('profile_resources_invalid'));
  assert.equal(launchReadiness(profile({ gpuMode: 'nvidia', gpuSupport: 'none' }), [host()], 'nvidia').state, 'ready');
  assert.deepEqual(profileLaunchIssues(profile({ gpuMode: 'nvidia', gpuSupport: 'none' }), 'software'), []);
});

test('ABI comparison follows server rules and allows missing legacy metadata', () => {
  assert.equal(launchReadiness(profile({ abi: 'arm64-v8a,x86_64' }), [host()], 'nvidia').state, 'ready');
  assert.equal(launchReadiness(profile({ abi: null }), [host()], 'nvidia').state, 'ready');
  for (const abi of ['amd64', 'X86_64', 'unknown']) {
    assert.ok(codes(hostLaunchIssues(profile({ abi }), host(), 'software')).includes('host_architecture'));
  }
});

test('offline and disabled GPU nodes explain availability instead of missing hardware', () => {
  for (const [patch, code] of [[{ status: 'offline' }, 'host_offline'], [{ disabled: true }, 'host_disabled'], [{ lastSeenAt: new Date(Date.now() - 60_000).toISOString() }, 'host_stale']]) {
    const result = launchReadiness(profile(), [host('cpu', { gpuCapabilities: [] }), host('gpu', patch)], 'nvidia');
    assert.equal(result.state, 'blocked');
    assert.equal(result.host.id, 'gpu');
    assert.deepEqual(codes(result.issues), [code]);
  }
});


test('resource drafts preserve omitted profile defaults, explicit Android image defaults and integer overrides', () => {
  const options = { cpu: 3, memoryMb: 4096, guestCores: 2, guestMemoryMb: 2048, diskGb: 8, sdCardMb: 0, emulatorParams: '', privileged: false };
  assert.deepEqual(parseLaunchDraft({ ...options, cpu: '3', memoryMb: '4096', guestCores: '2', guestMemoryMb: '2048', diskGb: '8', sdCardMb: '0' }), { options, error: '' });
  assert.deepEqual(parseLaunchDraft({ cpu: '', memoryMb: '', guestCores: '', guestMemoryMb: '' }), { options: {}, error: '' });
  const imageDefaults = { guestCores: null, guestMemoryMb: null };
  assert.deepEqual(parseLaunchDraft(imageDefaults), { options: imageDefaults, error: '' });
  for (const [field, min, max] of [['cpu', 1, 16], ['memoryMb', 1024, 65536], ['guestCores', 1, 16], ['guestMemoryMb', 1024, 64512]]) {
    for (const value of [String(min), String(max)]) assert.equal(parseLaunchDraft({ [field]: value }).error, '');
    for (const value of ['1.5', '-1', 'NaN', 'Infinity', '1e3', String(min - 1), String(max + 1), '9007199254740993']) {
      assert.ok(parseLaunchDraft({ [field]: value }).error, field + ': ' + value);
    }
  }
});

test('resource allowance uses resulting container limits and keeps null image defaults distinct', () => {
  const p = profile({ cpu: 4, memoryMb: 4096, guestCores: 2, guestMemoryMb: 2048 });
  assert.equal(launchResourceError(p, { cpu: 3, memoryMb: 3072 }), '');
  assert.match(launchResourceError(p, { cpu: 1 }), /Ядра Android/);
  assert.match(launchResourceError(p, { memoryMb: 2048 }), /1024/);
  assert.match(launchResourceError(p, { cpu: 8 }), /лимиту профиля/);
  assert.match(launchResourceError(p, { memoryMb: 8192 }), /лимиту профиля/);
  assert.equal(launchResourceError(p, { cpu: 8, memoryMb: 8192, guestCores: 8, guestMemoryMb: 7168 }, true), '');
  assert.equal(launchResourceError(p, { guestCores: 4, guestMemoryMb: 3072 }), '');
  assert.equal(launchResourceError(p, { cpu: 1, memoryMb: 1024, guestCores: null, guestMemoryMb: null }), '');
  assert.ok(launchResourceError(p, { guestMemoryMb: 65536 }, true));
  const effective = effectiveLaunchProfile(p, { cpu: 2, guestCores: null });
  assert.equal(effective.cpu, 2); assert.equal(effective.guestCores, null); assert.equal(effective.guestMemoryMb, 2048);
  assert.equal(p.cpu, 4); assert.equal(p.guestCores, 2);
});

test('host readiness checks requested resources and rejects conflicting Android allocation', () => {
  const p = profile({ cpu: 8, memoryMb: 8192, guestCores: 4, guestMemoryMb: 4096 });
  assert.equal(launchReadiness(p, [host()], 'software').state, 'blocked');
  const smaller = { cpu: 4, memoryMb: 4096, guestCores: 2, guestMemoryMb: 2048 };
  assert.equal(launchReadiness(p, [host()], 'software', '', false, smaller).state, 'ready');
  const nodes = [host('small'), host('large', { slotCpu: 8, slotMemoryMb: 8192 })];
  assert.equal(launchReadiness(profile(), nodes, 'nvidia', '', false, { cpu: 8, memoryMb: 8192 }).host.id, 'large');
  assert.equal(launchReadiness(profile(), [host('busy', { activeSessions: 1 })], 'software', '', false, { cpu: 2, memoryMb: 2048 }).state, 'busy');
  assert.ok(codes(launchReadiness(p, [host()], 'software', '', false, { cpu: 2, memoryMb: 2048 }).issues).includes('launch_resources_invalid'));
  assert.match(hostLaunchIssues(profile(), host(), 'software', false, { cpu: 8, memoryMb: 8192 })[0].message, /8 CPU.*8 ГБ/);
});
