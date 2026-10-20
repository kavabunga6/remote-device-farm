import test from 'node:test';
import assert from 'node:assert/strict';
import { androidCapabilities, probeAndroid } from './android-capabilities.mjs';
import { ProviderRegistry } from './registry.mjs';
import { DeviceProvider } from './base.mjs';
const available = ['video', 'audio', 'touch', 'keys', 'shell', 'logs', 'screenshot', 'tunnel'];
test('version dependent features require a confirmed Android SDK', () => {
  assert.deepEqual(androidCapabilities(available, 29).capabilities, available.filter(c => c !== 'audio'));
  assert.deepEqual(androidCapabilities(available, 30).capabilities, available);
  const unknown = androidCapabilities(available, null);
  assert.deepEqual(unknown.capabilities, ['shell', 'logs', 'screenshot', 'tunnel']);
  assert.equal(unknown.capabilityReasons.video, 'device-probe-unavailable');
  assert.equal(androidCapabilities(available, 19).capabilityReasons.touch, 'android-version-unsupported');
});
test('probe parses bounded properties and fails conservatively without exposing raw ADB output', async () => {
  const adb = { run: async (serial, argv, options) => {
    assert.equal(serial, 'phone');
    assert.deepEqual(argv, ['shell', 'getprop']);
    assert.equal(options.timeoutMs, 3000);
    return { exitCode: 0, stdout: '[ro.build.version.sdk]: [29]\n[ro.build.version.release]: [10]\n[private]: [secret]' };
  } };
  const result = await probeAndroid(adb, 'phone', available);
  assert.equal(result.sdkLevel, 29);
  assert.equal(result.osVersion, '10');
  assert.equal(result.capabilities.includes('audio'), false);
  assert.equal(JSON.stringify(result).includes('secret'), false);
  const failed = await probeAndroid({ run: async () => { throw Error('host private path'); } }, 'phone', available);
  assert.equal(failed.capabilities.includes('video'), false);
  const abort = new AbortController(); abort.abort();
  await assert.rejects(probeAndroid({ run: async () => { throw abort.signal.reason; } }, 'phone', available, { signal: abort.signal }), { name: 'AbortError' });
});
test('device capability denial is enforced by the provider dispatch, including screenshot and tunnel declarations', async () => {
  class Provider extends DeviceProvider {
    constructor() { super({ kind: 'usb-android', platform: 'android' }); this.sessions.set('session', { capabilities: ['shell'] }); }
    get ops() { return { audio: async () => 'audio', adb: async () => 'shell', screenshot: async () => 'image' }; }
    tunnelTarget() { return {}; }
  }
  const provider = new Provider(), registry = new ProviderRegistry([provider]);
  assert.ok(provider.capabilities.includes('screenshot'));
  assert.ok(provider.capabilities.includes('tunnel'));
  assert.throws(() => registry.execute('audio', 'session', { enabled: true }), { code: 'device_capability_unavailable' });
  assert.equal(await registry.execute('audio', 'session', { enabled: false }), 'audio');
  assert.equal(await registry.execute('adb', 'session', {}), 'shell');
});
