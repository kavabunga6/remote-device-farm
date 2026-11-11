import assert from 'node:assert/strict';
import test from 'node:test';
import { ScrcpyStream, StreamManager } from './scrcpy.mjs';

const serial = 'rdf-11111111-1111-4111-8111-111111111111:5555';
function fixture({ failStart = false, pending = false } = {}) {
  let native, scrcpyStarts = 0, releases = 0, inputs = 0, rejectStart;
  class FakeScrcpy extends ScrcpyStream { async start() { scrcpyStarts++; } async close() { this.closed = true; } }
  const manager = new StreamManager({ adb: { input: () => { throw new Error('unexpected ADB'); } }, emit() {}, serverPath: '/unused',
    createScrcpyStream: options => new FakeScrcpy(options),
    createNativeStream: options => native = { ...options, mode: 'emulator-rtc', inputEpoch: 0, closed: false,
      start: async () => { if (failStart) throw new Error('unsupported runtime'); if (pending) await new Promise((_, reject) => { rejectStart = reject; }); },
      close: async () => { native.closed = true; rejectStart?.(new Error('cancelled')); },
      hasControl: () => !native.closed, canInput: () => true, input: async () => { inputs++; }, releaseInput: async () => { releases++; },
      requestKeyframe: () => true, resendConfig() {}
    }
  });
  return { manager, native: () => native, scrcpyStarts: () => scrcpyStarts, inputs: () => inputs, releases: () => releases };
}
test('native stream routes matching session input and release without ADB', async () => {
  const f = fixture(); assert.equal((await f.manager.start('native-one', serial)).mode, 'emulator-rtc');
  await f.manager.input('native-one', serial, { kind: 'key', keyCode: 3 });
  await f.manager.releaseInput('native-one', serial);
  assert.equal(f.inputs(), 1); assert.equal(f.releases(), 1);
  assert.equal(f.manager.requestKeyframe('native-one', serial).requested, true);
  await f.manager.stop('native-one'); assert.equal(f.native().closed, true);
});
test('unsupported native runtime falls back once to scrcpy and ordinary devices skip the native endpoint', async () => {
  const f = fixture({ failStart: true });
  assert.equal((await f.manager.start('native-fallback', serial)).mode, 'scrcpy');
  assert.equal(f.scrcpyStarts(), 1); assert.equal(f.native().closed, true);
  await f.manager.stop('native-fallback');
  const usb = fixture(); assert.equal((await usb.manager.start('usb', 'R1234')).mode, 'scrcpy');
  assert.equal(usb.native(), undefined); await usb.manager.stop('usb');
});
test('stopping pending native startup cancels it without a late scrcpy replacement', async () => {
  const f = fixture({ pending: true });
  const starting = f.manager.start('native-stop', serial); const rejected = assert.rejects(starting, /cancelled/);
  await f.manager.stop('native-stop'); await rejected;
  assert.equal(f.scrcpyStarts(), 0); assert.equal(f.manager.streams.size, 0);
});
test('a failed active native source closes before scrcpy replaces it; late failure cannot resurrect a stopped session', async () => {
  const f = fixture(); await f.manager.start('native-failure', serial);
  f.native().onFailure(new Error('emulator stream lost'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.native().closed, true); assert.equal(f.scrcpyStarts(), 1);
  await f.manager.stop('native-failure'); f.native().onFailure(new Error('late failure'));
  await new Promise(resolve => setImmediate(resolve)); assert.equal(f.manager.streams.size, 0);
});

test('native video with no actual Opus packets uses its Android audio fallback and keeps legacy tap coordinates on ADB', async () => {
  let native, audioClosed = 0, audioEnabled = false, adbInput;
  const manager = new StreamManager({ adb: { input: async (_serial, input) => { adbInput = input; return { ok: true }; } }, emit() {},
    createNativeStream: options => native = { ...options, mode: 'emulator-rtc', audioAvailable: false, start: async () => {}, close: async () => {},
      selectAudioSource() {}, setAudio() {}, hasControl: () => true, canInput: input => input.kind === 'key' },
    createEmulatorAudioStream: () => { throw new Error('native fallback must not depend on QEMU host audio'); },
    createNativeAudioStream: () => ({ codec: 'opus', start: async () => {}, setEnabled: value => { audioEnabled = value; }, close: () => { audioClosed++; } }) });
  manager.audio.set('native-pcm', true);
  await manager.start('native-pcm', serial); await new Promise(resolve => setImmediate(resolve));
  assert.equal(audioEnabled, true); assert.equal(manager.emulatorAudio.size, 1);
  assert.equal((await manager.setAudio('native-pcm', true)).codec, 'opus');
  const tap = { kind: 'tap', x: 900, y: 1800 };
  await manager.input('native-pcm', serial, tap); assert.deepEqual(adbInput, tap);
  await manager.setAudio('native-pcm', false); assert.equal(audioClosed, 1);
  await manager.stop('native-pcm');
});
