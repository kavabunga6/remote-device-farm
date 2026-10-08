import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { androidOps } from './providers/android-ops.mjs';
import { ScrcpyStream, StreamManager, connectVideoPortWithHandshake, encodeKeyPress, encodeTextInput, encodeTouchEvent, parseAudioCodecHeader, parseMediaHeader, scrcpyServerArgs, shouldRetryAac } from './scrcpy.mjs';

test('parses scrcpy media packet flags and bounds', () => {
  const buffer = Buffer.alloc(12);
  buffer.writeBigUInt64BE((1n << 61n) | 12345n);
  buffer.writeUInt32BE(42, 8);
  assert.deepEqual(parseMediaHeader(buffer), { session: false, config: false, keyframe: true, timestamp: 12345, packetSize: 42 });
  buffer.writeUInt32BE(20 * 1024 * 1024, 8);
  assert.throws(() => parseMediaHeader(buffer));
});

test('retries a premature adb-forward connection and preserves the video header', async () => {
  let connections = 0;
  const forward = net.createServer((peer) => {
    connections++;
    if (connections === 1) {
      peer.end();
    } else {
      // The dummy byte and codec header may arrive in the same TCP packet.
      peer.write(Buffer.from([0, 0x68, 0x32, 0x36, 0x34]));
    }
  });
  await new Promise((resolve) => forward.listen(0, '127.0.0.1', resolve));
  let socket;
  try {
    const connected = await connectVideoPortWithHandshake(forward.address().port, 3000);
    socket = connected.socket;
    assert.equal((await connected.reader.read(4)).toString('ascii'), 'h264');
    assert.equal(connections, 2);
  } finally {
    socket?.destroy();
    await new Promise((resolve) => forward.close(resolve));
  }
});

test('accepts scrcpy Opus and AAC codec headers and distinguishes capture errors', () => {
  assert.deepEqual(parseAudioCodecHeader(Buffer.from('opus'), 'opus'), { available: true, codec: 'opus' });
  assert.deepEqual(parseAudioCodecHeader(Buffer.from([0, 0x61, 0x61, 0x63]), 'aac'), { available: true, codec: 'aac' });
  assert.deepEqual(parseAudioCodecHeader(Buffer.alloc(4), 'opus'), { available: false, codec: null });
  assert.throws(() => parseAudioCodecHeader(Buffer.from([0, 0, 0, 1]), 'opus'), { code: 'SCRCPY_AUDIO_CODEC_ERROR' });
  assert.throws(() => parseAudioCodecHeader(Buffer.from('flac'), 'opus'), /Unexpected scrcpy audio codec/);
  assert.throws(() => parseAudioCodecHeader(Buffer.alloc(3), 'opus'), /Invalid scrcpy audio header/);
});

test('retries AAC only after an Opus encoder failure', () => {
  assert.equal(shouldRetryAac(Object.assign(new Error('encoder failed'), { code: 'SCRCPY_AUDIO_CODEC_ERROR' })), true);
  assert.equal(shouldRetryAac(new Error('Could not create default audio encoder for opus')), true);
  assert.equal(shouldRetryAac(new Error('Failed to initialize audio/opus, error 0xfffffffe')), true);
  assert.equal(shouldRetryAac(new Error('scrcpy handshake timed out')), false);
});

test('removes its unique pushed server JAR when a stream closes', async () => {
  const calls = [];
  const stream = new ScrcpyStream({
    sessionId: 'session-1', serial: '127.0.0.1:5555', serverPath: '/unused', emit: () => {},
    adb: { run: async (...args) => { calls.push(args); return { exitCode: 0 }; } },
  });
  stream.deviceServerPath = '/data/local/tmp/rdf-scrcpy-0000002a.jar';
  await stream.close();
  await stream.close();
  assert.deepEqual(calls, [['127.0.0.1:5555', ['shell', 'rm', '-f', '/data/local/tmp/rdf-scrcpy-0000002a.jar'], { timeoutMs: 5000 }]]);
});

test('encodes scrcpy v4.1 touch events with video dimensions and full finger pressure', () => {
  const down = encodeTouchEvent({ action: 'down', x: 321, y: 654, pointerId: 0 }, 720, 1280);
  assert.equal(down.toString('hex'), '02000000000000000000000001410000028e02d00500ffff0000000000000000');
  const move = encodeTouchEvent({ action: 'move', x: 322, y: 655 }, 720, 1280);
  assert.equal(move[1], 2);
  assert.equal(move.readUInt16BE(22), 0xffff);
  const up = encodeTouchEvent({ action: 'up', x: 322, y: 655 }, 720, 1280);
  assert.equal(up[1], 1);
  assert.equal(up.readUInt16BE(22), 0);
  assert.throws(() => encodeTouchEvent({ action: 'move', x: 720, y: 0 }, 720, 1280), /coordinates/);
  assert.throws(() => encodeTouchEvent({ action: 'cancel', x: 0, y: 0 }, 720, 1280), /action/);
});

test('sends a down-move-up sequence only to the matching live scrcpy session', () => {
  const messages = [];
  const serial = 'emulator-1:5555';
  const stream = new ScrcpyStream({ sessionId: 'session-1', serial, adb: {}, serverPath: '/unused', emit: () => {} });
  stream.videoConfig = { width: 720, height: 1280 };
  stream.controlSocket = { destroyed: false, writableLength: 0, write: (message) => messages.push(Buffer.from(message)) };
  const manager = new StreamManager({ adb: {}, serverPath: '/unused', emit: () => {} });
  manager.streams.set('session-1', stream);
  assert.throws(() => manager.touch('session-2', serial, { action: 'down', x: 1, y: 1 }), /unavailable/);
  assert.throws(() => manager.touch('session-1', 'other:5555', { action: 'down', x: 1, y: 1 }), /unavailable/);
  assert.throws(() => manager.touch('session-1', serial, { action: 'move', x: 1, y: 1 }), /not down/);
  assert.deepEqual(manager.touch('session-1', serial, { action: 'down', x: 1, y: 1 }), { ok: true });
  assert.throws(() => manager.touch('session-1', serial, { action: 'down', x: 1, y: 1 }), /already down/);
  manager.touch('session-1', serial, { action: 'move', x: 2, y: 3 });
  manager.touch('session-1', serial, { action: 'up', x: 2, y: 3 });
  assert.deepEqual(messages.map((message) => message[1]), [0, 2, 1]);
  assert.equal(stream.activePointers.size, 0);
  stream.controlSocket.destroyed = true;
  assert.throws(() => manager.touch('session-1', serial, { action: 'down', x: 1, y: 1 }), /unavailable/);
});


test('drops congested H264 deltas and resumes only from a keyframe with fresh config', () => {
  let writable = true;
  const events = [];
  const control = [];
  const stream = new ScrcpyStream({
    sessionId: 'session-1', serial: 'emulator-1:5555', adb: {}, serverPath: '/unused',
    emit: event => events.push(event),
    canEmitVideo: () => writable,
  });
  stream.videoConfig = { type: 'video-config', codec: 'h264', width: 720, height: 1280, data: 'c3Bz' };
  stream.controlSocket = { destroyed: false, write: message => control.push(Buffer.from(message)) };
  const delta = { session: false, config: false, keyframe: false, timestamp: 100 };
  const keyframe = { ...delta, keyframe: true, timestamp: 200 };

  stream.forwardVideoFrame(keyframe, Buffer.from('first'));
  assert.deepEqual(events.map(event => event.type), ['video-config', 'video-frame']);
  assert.equal(stream.videoNeedsKeyframe, false);

  writable = false;
  stream.forwardVideoFrame(delta, Buffer.from('stale1'));
  stream.forwardVideoFrame(delta, Buffer.from('stale2'));
  assert.equal(events.length, 2);
  assert.equal(stream.videoNeedsKeyframe, true);

  writable = true;
  stream.forwardVideoFrame(delta, Buffer.from('dependent'));
  stream.forwardVideoFrame(delta, Buffer.from('dependent2'));
  assert.deepEqual(control.map(message => message.toString('hex')), ['11']);
  assert.equal(events.length, 2);

  stream.forwardVideoFrame(keyframe, Buffer.from('fresh'));
  assert.deepEqual(events.map(event => event.type), ['video-config', 'video-frame', 'video-config', 'video-frame']);
  assert.equal(events[3].data, Buffer.from('fresh').toString('base64'));
  assert.equal(stream.videoNeedsKeyframe, false);
  stream.lastVideoResetAt = 0;
  stream.resendConfig();
  assert.equal(control.at(-1).toString('hex'), '11');
});


async function waitUntil(predicate, timeoutMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for stream state');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

test('recovers a screenshot fallback to scrcpy and discards an in-flight stale PNG', async () => {
  const events = [];
  let attempts = 0;
  let finishScreenshot;
  const screenshot = new Promise(resolve => { finishScreenshot = resolve; });
  class FakeScrcpy extends ScrcpyStream {
    async start() {
      attempts++;
      if (attempts === 1) throw new Error('device offline');
      this.videoConfig = { type: 'video-config', codec: 'h264', data: 'c3Bz' };
      this.emit({ type: 'video-frame', sessionId: this.sessionId, data: 'candidate-frame' });
    }
    async close() { this.closed = true; }
  }
  const manager = new StreamManager({
    adb: { screenshot: () => screenshot },
    serverPath: '/unused', emit: event => events.push(event),
    scrcpyRetryIntervalMs: 10,
    createScrcpyStream: options => new FakeScrcpy(options),
  });
  try {
    assert.equal((await manager.start('session-recovery', 'emulator:5555')).mode, 'screenshots');
    const fallback = manager.streams.get('session-recovery');
    await waitUntil(() => manager.streams.get('session-recovery') instanceof FakeScrcpy);
    assert.equal(attempts, 2);
    assert.equal(fallback.closed, true);
    finishScreenshot({ type: 'frame', data: 'old-image' });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(events.map(event => event.type), ['video-config']);
  } finally {
    await manager.stop('session-recovery');
  }
});

test('stopping a screenshot fallback cancels its pending scrcpy retry', async () => {
  let attempts = 0;
  class FakeScrcpy extends ScrcpyStream {
    async start() { attempts++; throw new Error('device offline'); }
    async close() { this.closed = true; }
  }
  const manager = new StreamManager({
    adb: { screenshot: () => new Promise(() => {}) },
    serverPath: '/unused', emit: () => {},
    scrcpyRetryIntervalMs: 25,
    createScrcpyStream: options => new FakeScrcpy(options),
  });
  assert.equal((await manager.start('session-stop', 'emulator:5555')).mode, 'screenshots');
  await manager.stop('session-stop');
  await new Promise(resolve => setTimeout(resolve, 55));
  assert.equal(attempts, 1);
  assert.equal(manager.streams.has('session-stop'), false);
});

test('stopping during a scrcpy retry prevents resurrecting the stream', async () => {
  let attempts = 0;
  let finishRetry;
  const retryGate = new Promise(resolve => { finishRetry = resolve; });
  let retryStream;
  class FakeScrcpy extends ScrcpyStream {
    async start() {
      attempts++;
      if (attempts === 1) throw new Error('device offline');
      retryStream = this;
      await retryGate;
    }
    async close() { this.closed = true; }
  }
  const manager = new StreamManager({
    adb: { screenshot: () => new Promise(() => {}) },
    serverPath: '/unused', emit: () => {},
    scrcpyRetryIntervalMs: 10,
    createScrcpyStream: options => new FakeScrcpy(options),
  });
  assert.equal((await manager.start('session-race', 'emulator:5555')).mode, 'screenshots');
  await waitUntil(() => attempts === 2);
  await manager.stop('session-race');
  finishRetry();
  await waitUntil(() => retryStream.closed);
  assert.equal(manager.streams.has('session-race'), false);
  assert.equal(attempts, 2);
});

test('scrcpy launch requests an IDR at least once per second', () => {
  const args = scrcpyServerArgs('emulator:5555', '/data/local/tmp/server.jar', 42, 'opus');
  assert.ok(args.includes('video_codec_options=i-frame-interval:int=1'));
  assert.ok(args.includes('audio_codec=opus'));
  assert.ok(args.includes('scid=0000002a'));
});

test('a scrcpy dimension packet waits for complete codec config before notifying viewers', async () => {
  const events = [];
  const stream = new ScrcpyStream({ sessionId: 'session-1', serial: 'emulator:5555', adb: {}, serverPath: '/unused', emit: event => events.push(event) });
  const packet = Buffer.alloc(12);
  packet.writeBigUInt64BE(1n << 63n);
  packet.writeUInt32BE(720, 4);
  packet.writeUInt32BE(1280, 8);
  let reads = 0;
  await assert.rejects(stream.readVideo({ read: async () => { if (reads++ === 0) return packet; throw new Error('done'); } }), /done/);
  assert.deepEqual(events, []);
  assert.equal(stream.videoConfig.width, 720);
  assert.equal(stream.videoConfig.height, 1280);
});

test('explicit IDR requests use the scrcpy control socket and throttle repeats', () => {
  const written = [];
  const serial = 'emulator:5555';
  const stream = new ScrcpyStream({ sessionId: 'session-1', serial, adb: {}, serverPath: '/unused', emit: () => {} });
  stream.controlSocket = { destroyed: false, write: data => written.push(Buffer.from(data)) };
  const manager = new StreamManager({ adb: {}, serverPath: '/unused', emit: () => {} });
  manager.streams.set('session-1', stream);
  assert.deepEqual(manager.requestKeyframe('session-1', 'other:5555'), { requested: false });
  assert.deepEqual(manager.requestKeyframe('session-1', serial), { requested: true });
  assert.deepEqual(manager.requestKeyframe('session-1', serial), { requested: false });
  assert.deepEqual(written.map(data => data.toString('hex')), ['11']);
  stream.lastVideoResetAt = 0;
  stream.controlSocket.destroyed = true;
  assert.deepEqual(manager.requestKeyframe('session-1', serial), { requested: false });
});

test('keeps native scrcpy audio and does not open emulator gRPC when supported', async () => {
  const stream = new ScrcpyStream({
    sessionId: 'native-audio', serial: 'rdf-11111111-2222-3333-4444-555555555555:5555',
    adb: {}, serverPath: '/unused', emit: () => {},
  });
  stream.audioAvailable = true;
  const manager = new StreamManager({
    adb: {}, serverPath: '/unused', emit: () => {},
    createEmulatorAudioStream: () => { throw new Error('Unexpected gRPC connection'); },
  });
  manager.streams.set('native-audio', stream);
  assert.deepEqual(await manager.setAudio('native-audio', true),
    { enabled: true, available: true, codec: 'opus' });
  assert.equal(stream.audioEnabled, true);
  assert.equal(manager.emulatorAudio.size, 0);
  await manager.setAudio('native-audio', false);
  assert.equal(stream.audioEnabled, false);
});

test('uses emulator gRPC audio with screenshot video and closes it on disable', async () => {
  const events = [];
  let opened = 0;
  let closed = 0;
  let failed;
  const manager = new StreamManager({
    adb: {}, serverPath: '/unused', emit: event => events.push(event),
    createEmulatorAudioStream: options => {
      opened++;
      failed = options.onFailure;
      return {
        start: async () => {},
        setEnabled: enabled => {
          if (enabled) options.emit({ type: 'audio-config', sessionId: options.sessionId, codec: 'pcm-s16le' });
        },
        close: () => { closed++; },
      };
    },
  });
  const sessionId = 'fallback-audio';
  manager.streams.set(sessionId, { serial: 'rdf-11111111-2222-3333-4444-555555555555:5555' });
  assert.deepEqual(await manager.setAudio(sessionId, true),
    { enabled: true, available: true, codec: 'pcm-s16le' });
  assert.equal(opened, 1);
  assert.equal(events[0].type, 'audio-config');
  failed(new Error('emulator stopped'));
  assert.equal(manager.audio.get(sessionId), false);
  assert.equal(events.at(-1).type, 'audio-unavailable');
  assert.equal(manager.emulatorAudio.size, 0);
  await manager.setAudio(sessionId, true);
  assert.equal(opened, 2);
  await manager.setAudio(sessionId, false);
  assert.equal(closed, 2);
  assert.equal(manager.emulatorAudio.size, 0);
});


test('concurrent initial stream starts share one scrcpy process', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let attempts = 0;
  const created = [];
  class FakeScrcpy extends ScrcpyStream {
    async start() { attempts++; await gate; }
    async close() { this.closed = true; }
  }
  const manager = new StreamManager({ adb: {}, serverPath: '/unused', emit() {},
    createScrcpyStream: options => { const stream = new FakeScrcpy(options); created.push(stream); return stream; } });
  const first = manager.start('initial-shared', 'emulator:5555');
  const second = manager.start('initial-shared', 'emulator:5555');
  release();
  try {
    assert.deepEqual(await first, await second);
    assert.equal(attempts, 1);
  } finally {
    await manager.stop('initial-shared');
    for (const stream of created) await stream.close();
  }
});

test('stop during initial startup closes the completed candidate without resurrecting video', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const events = [];
  let candidate;
  class FakeScrcpy extends ScrcpyStream {
    async start() { await gate; this.emit({ type: 'video-frame', data: 'late-frame' }); }
    async close() { this.closed = true; }
  }
  const manager = new StreamManager({ adb: {}, serverPath: '/unused', emit: event => events.push(event),
    createScrcpyStream: options => { candidate = new FakeScrcpy(options); return candidate; } });
  const start = manager.start('initial-stop', 'emulator:5555');
  const outcome = start.then(value => value, error => error);
  const stop = manager.stop('initial-stop');
  release();
  try {
    assert.match((await outcome).message || '', /cancelled/i);
    await stop;
    assert.equal(manager.streams.size, 0);
    assert.equal(candidate.closed, true);
    assert.deepEqual(events, []);
  } finally {
    await manager.stop('initial-stop');
    await candidate.close();
  }
});


test('encodes a complete scrcpy key press including Android volume mute 164', () => {
  const message = encodeKeyPress(164);
  assert.equal(message.toString('hex'), '0000000000a400000000000000000001000000a40000000000000000');
  assert.deepEqual(encodeKeyPress('164'), message);
  for (const value of [0, 301, -1, 1.5, 'home', undefined]) {
    assert.throws(() => encodeKeyPress(value), /Invalid Android keycode/);
  }
});

test('sends literal text in bounded complete UTF-8 packets without truncation', () => {
  assert.equal(encodeTextInput('a b%s').toString('hex'), '01000000056120622573');
  const text = 'a'.repeat(299) + '\u{1f642}\u0436'.repeat(220);
  const message = encodeTextInput(text);
  const decoded = [];
  const lengths = [];
  for (let offset = 0; offset < message.length;) {
    assert.equal(message[offset], 1);
    const length = message.readUInt32BE(offset + 1);
    assert.ok(length > 0 && length <= 300);
    const payload = message.subarray(offset + 5, offset + 5 + length);
    // Fatal decoding proves a packet never splits a UTF-8 code point.
    decoded.push(new TextDecoder('utf-8', { fatal: true }).decode(payload));
    lengths.push(length);
    offset += 5 + length;
  }
  assert.equal(lengths[0], 299);
  assert.equal(decoded.join(''), text);
  assert.equal(encodeTextInput('').length, 0);
  assert.doesNotThrow(() => encodeTextInput('a'.repeat(1000)));
  for (const value of ['a'.repeat(1001), 'a\nb', 'a\rb', 'a\0b', 123, undefined]) {
    assert.throws(() => encodeTextInput(value), /Invalid input text/);
  }
});

test('routes keys and text through the live scrcpy control without an adb process', () => {
  const writes = [];
  const adbCalls = [];
  const serial = 'emulator-1:5555';
  const stream = new ScrcpyStream({ sessionId: 'session-1', serial, adb: {}, serverPath: '/unused', emit: () => {} });
  stream.controlSocket = { destroyed: false, writableLength: 0, write: message => writes.push(Buffer.from(message)) };
  const adb = { input: (...args) => { adbCalls.push(args); return { ok: true }; } };
  const manager = new StreamManager({ adb, serverPath: '/unused', emit: () => {} });
  manager.streams.set('session-1', stream);
  const ops = androidOps({ adb, streams: manager });
  assert.deepEqual(ops.input({ serial }, { kind: 'key', keyCode: 164 }, { sessionId: 'session-1' }), { ok: true });
  assert.deepEqual(ops.input({ serial }, { kind: 'text', text: 'hello world' }, { sessionId: 'session-1' }), { ok: true });
  assert.deepEqual(writes, [encodeKeyPress(164), encodeTextInput('hello world')]);
  assert.deepEqual(adbCalls, []);
  // Live touch still follows the same channel and pointer-state validation.
  stream.videoConfig = { width: 720, height: 1280 };
  ops.input({ serial }, { kind: 'touch', action: 'down', x: 30, y: 40 }, { sessionId: 'session-1' });
  ops.input({ serial }, { kind: 'touch', action: 'up', x: 30, y: 40 }, { sessionId: 'session-1' });
  assert.deepEqual(writes.slice(2).map(message => message[1]), [0, 1]);
});

test('keeps adb fallback for unavailable control and legacy device-coordinate gestures', () => {
  const adbCalls = [];
  const serial = 'emulator-1:5555';
  const adb = { input: (...args) => { adbCalls.push(args); return { ok: true }; } };
  const manager = new StreamManager({ adb, serverPath: '/unused', emit: () => {} });
  const stream = new ScrcpyStream({ sessionId: 'session-1', serial, adb, serverPath: '/unused', emit: () => {} });
  stream.controlSocket = { destroyed: false, writableLength: 0, write: () => assert.fail('must not write to this socket') };
  manager.streams.set('session-1', stream);
  const key = { kind: 'key', keyCode: 4 };
  manager.input('other-session', serial, key);
  manager.input('session-1', 'other-serial:5555', key);
  manager.input('session-1', serial, { kind: 'tap', x: 1000, y: 1900 });
  manager.input('session-1', serial, { kind: 'swipe', x1: 0, y1: 1900, x2: 0, y2: 100 });
  stream.controlSocket.destroyed = true;
  manager.input('session-1', serial, key);
  stream.controlSocket.destroyed = false;
  stream.closed = true;
  manager.input('session-1', serial, key);
  stream.closed = false;
  stream.controlSocket = undefined;
  manager.input('session-1', serial, key);
  manager.streams.set('session-1', { serial, starting: true });
  manager.input('session-1', serial, key);
  manager.streams.set('session-1', { serial, closed: false });
  manager.input('session-1', serial, key);
  assert.equal(adbCalls.length, 9);
  assert.equal(adbCalls[1][0], 'other-serial:5555');
  assert.throws(() => manager.input('session-1', serial, { kind: 'touch', action: 'down', x: 1, y: 2 }), /unavailable/);
  assert.equal(adbCalls.length, 9);
});

test('does not replay invalid, congested, or failed scrcpy input through adb', () => {
  const serial = 'emulator-1:5555';
  let writes = 0;
  const stream = new ScrcpyStream({ sessionId: 'session-1', serial, adb: {}, serverPath: '/unused', emit: () => {} });
  stream.controlSocket = { destroyed: false, writableLength: 0, write: () => { writes++; throw new Error('socket write failed'); } };
  const manager = new StreamManager({ adb: { input: () => assert.fail('must not replay through adb') }, serverPath: '/unused', emit: () => {} });
  manager.streams.set('session-1', stream);
  assert.throws(() => manager.input('session-1', serial, { kind: 'key', keyCode: 301 }), /keycode/);
  assert.throws(() => manager.input('session-1', serial, { kind: 'text', text: 'bad\ntext' }), /input text/);
  assert.equal(writes, 0);
  stream.controlSocket.writableLength = 64 * 1024 + 1;
  assert.throws(() => manager.input('session-1', serial, { kind: 'key', keyCode: 164 }), /congested/);
  assert.equal(writes, 0);
  stream.controlSocket.writableLength = 0;
  assert.throws(() => manager.input('session-1', serial, { kind: 'text', text: 'once' }), /socket write failed/);
  assert.equal(writes, 1);
});


function nativeFixture(options = {}) {
  const sent = [], control = [], geometries = [], events = [];
  let closed = 0, released = 0, reads = 0, failed, read = async () => ({exitCode: 0, stdout: 'SurfaceOrientation: 0'});
  const controller = {prepare: async () => ({}), isAvailable: () => closed === 0, setGeometry: value => geometries.push(value),
    sendTouch: value => { sent.push(value); return true; }, releaseInput: async () => { released++; }, close: async () => { closed++; }};
  const stream = new ScrcpyStream({sessionId: 'native-test', serial: 'rdf-11111111-2222-3333-4444-555555555555:5555',
    adb: {run: (...args) => { reads++; return read(...args); }}, serverPath: '/unused', emit: event => events.push(event), ...options,
    createEmulatorTouch: options => { failed = options.onFailure; return controller; }});
  stream.controlSocket = {destroyed: false, writableLength: 0, write: message => control.push(message), destroy() {this.destroyed = true;}};
  stream.videoConfig = {width: 720, height: 1280, data: 'config'};
  return {stream, sent, control, geometries, events, setRead: value => {read = value;}, fail: error => failed(error), closed: () => closed, released: () => released, reads: () => reads};
}

test('native gestures wait for an observed actual rotation and keep down/move/up ordered', async () => {
  const f = nativeFixture();
  await f.stream.startNativeTouch();
  assert.equal(f.events.at(-1).nativeTouches, true);
  let resolve;
  f.setRead(() => new Promise(done => {resolve = done;}));
  f.stream.observeDisplayOutput(Buffer.from('[server] VERBOSE: DisplayMonitor: 1080x1920 [rotation=0] -> 1080x1920 [rotation=2]\n'), 'stdout');
  const down = f.stream.touch({action: 'down', x: 70, y: 90});
  const move = f.stream.touch({action: 'move', x: 75, y: 95});
  const up = f.stream.touch({action: 'up', x: 80, y: 100});
  await Promise.resolve();
  assert.deepEqual(f.sent, []);
  resolve({exitCode: 0, stdout: 'SurfaceOrientation: 2'});
  await Promise.all([down, move, up]);
  assert.deepEqual(f.sent.map(event => event.action), ['down', 'move', 'up']);
  assert.deepEqual(f.geometries.at(-1), {rotation: 2});
  assert.equal(f.sent[0].width, 720);
  assert.equal(f.control.filter(message => message[0] === 2).length, 0);
  await f.stream.close();
});

test('failed native gesture is never replayed or released through scrcpy', async () => {
  const f = nativeFixture(); await f.stream.startNativeTouch();
  await f.stream.touch({action: 'down', x: 10, y: 20});
  f.fail(new Error('delivery uncertain'));
  await assert.rejects(f.stream.touch({action: 'up', x: 10, y: 20}), /unavailable/);
  assert.equal(f.control.filter(message => message[0] === 2).length, 0);
  assert.equal(f.events.at(-1).nativeTouches, false);
  // A later independent gesture may use the surviving fallback channel.
  f.stream.touch({action: 'down', x: 10, y: 20});
  f.stream.touch({action: 'up', x: 10, y: 20});
  assert.equal(f.control.filter(message => message[0] === 2).length, 2);
  await f.stream.close();
});

test('closing a stream while orientation is pending does not inject a late contact', async () => {
  const f = nativeFixture(); await f.stream.startNativeTouch();
  let resolve; f.setRead(() => new Promise(done => {resolve = done;}));
  f.stream.touchGeometry.invalidate();
  const down = f.stream.touch({action: 'down', x: 10, y: 20});
  const outcome = down.catch(error => error);
  await Promise.resolve(); await f.stream.close();
  resolve({exitCode: 0, stdout: 'SurfaceOrientation: 0'});
  assert.match((await outcome).message, /closed/i);
  assert.deepEqual(f.sent, []);
});


test('a connection failure during the initial display probe cannot re-enable native control', async () => {
  const f = nativeFixture(); let resolve;
  f.setRead(() => new Promise(done => {resolve = done;}));
  const start = f.stream.startNativeTouch(); await Promise.resolve();
  f.fail(new Error('closed while probing')); await f.stream.nativeTouch.close();
  resolve({exitCode: 0, stdout: 'SurfaceOrientation: 0'}); await start;
  assert.equal(f.stream.nativeTouchReady, false);
  assert.equal(f.events.some(event => event.nativeTouches === true), false);
  await f.stream.close();
});

test('backpressure drops excess moves but always accepts release of an owned touch', async () => {
  const f = nativeFixture(); await f.stream.startNativeTouch();
  let resolve; f.setRead(() => new Promise(done => {resolve = done;}));
  f.stream.touchGeometry.invalidate();
  const pending = [f.stream.touch({action: 'down', x: 10, y: 20})];
  for (let i = 0; i < 1000; i++) pending.push(f.stream.touch({action: 'move', x: 10 + i % 100, y: 20}));
  pending.push(f.stream.touch({action: 'up', x: 110, y: 20}));
  assert.equal(f.stream.nativeInputPending, 129);
  await Promise.resolve(); resolve({exitCode: 0, stdout: 'SurfaceOrientation: 0'});
  await Promise.all(pending);
  assert.equal(f.sent.at(-1).action, 'up');
  assert.equal(f.sent.length, 129);
  await f.stream.close();
});


test('ordinary native taps reuse geometry without spawning a per-down ADB query', async () => {
  const f = nativeFixture(); await f.stream.startNativeTouch();
  assert.equal(f.reads(), 1);
  for (let i = 0; i < 20; i++) {
    await f.stream.touch({action: 'down', x: 10, y: 20});
    await f.stream.touch({action: 'up', x: 10, y: 20});
  }
  assert.equal(f.reads(), 1);
  assert.equal(f.sent.length, 40);
  await f.stream.close();
});

test('same-size video session invalidates geometry for a 180-degree display rotation', async () => {
  const f = nativeFixture(); await f.stream.startNativeTouch();
  f.setRead(async () => ({exitCode: 0, stdout: 'SurfaceOrientation: 2'}));
  const packet = Buffer.alloc(12);
  packet.writeBigUInt64BE(1n << 63n); packet.writeUInt32BE(720, 4); packet.writeUInt32BE(1280, 8);
  let reads = 0;
  await assert.rejects(f.stream.readVideo({read: async () => {if (!reads++) return packet; throw new Error('end fixture');}}), /end fixture/);
  await f.stream.touch({action: 'down', x: 10, y: 20});
  assert.deepEqual(f.geometries.at(-1), {rotation: 2});
  assert.equal(f.reads(), 2);
  await f.stream.close();
});

test('split DisplayMonitor output refreshes app-locked geometry while unchanged events do not', async () => {
  const f = nativeFixture(); await f.stream.startNativeTouch();
  f.setRead(async () => ({exitCode: 0, stdout: 'Viewport INTERNAL: displayId=0, orientation=1, deviceSize=[1920, 1080], physicalFrame=[96, 0, 1824, 1080]'}));
  f.stream.observeDisplayOutput(Buffer.from('DisplayMonitor: 1080x1920 [rotation=0] -> 1920x1080 [rot'), 'stdout');
  assert.equal(f.reads(), 1);
  f.stream.observeDisplayOutput(Buffer.from('ation=1]\n'), 'stdout');
  await f.stream.touchGeometry.get();
  await f.stream.touch({action: 'down', x: 10, y: 20});
  assert.equal(f.geometries.at(-1).rotation, 1);
  assert.deepEqual(f.geometries.at(-1).physicalFrame, {left: 96, top: 0, right: 1824, bottom: 1080});
  f.stream.observeDisplayOutput(Buffer.from('DisplayMonitor: 1920x1080 [rotation=1] (unchanged)\n'), 'stdout');
  assert.equal(f.reads(), 2);
  await f.stream.close();
});

test('release invalidates pending native geometry input and preserves the native stream', async () => {
  const f = nativeFixture(); await f.stream.startNativeTouch();
  let resolve; f.setRead(() => new Promise(done => {resolve = done;}));
  f.stream.touchGeometry.invalidate();
  const down = f.stream.touch({action: 'down', x: 10, y: 20}).catch(error => error);
  const move = f.stream.touch({action: 'move', x: 20, y: 30}).catch(error => error);
  await Promise.resolve();
  await f.stream.releaseInput('disconnect');
  resolve({exitCode: 0, stdout: 'SurfaceOrientation: 2'});
  assert.equal((await down).code, 'INPUT_RESET');
  assert.equal((await move).code, 'INPUT_RESET');
  assert.deepEqual(f.sent, []);
  assert.equal(f.closed(), 0);
  assert.equal(f.stream.nativeTouchReady, true);
  assert.equal(f.stream.activePointers.size, 0);
  await f.stream.touch({action: 'down', x: 30, y: 40});
  assert.equal(f.sent.length, 1);
  await f.stream.close();
});

test('release keeps video alive, releases scrcpy contacts once, and rejects a captured old key callback', async () => {
  const f = nativeFixture();
  const manager = new StreamManager({adb: {input() {assert.fail('must not replay');}}, serverPath: '/unused', emit() {}});
  manager.streams.set(f.stream.sessionId, f.stream);
  f.stream.touch({action: 'down', x: 10, y: 20, pointerId: 3});
  f.stream.touch({action: 'move', x: 30, y: 40, pointerId: 3});
  const oldKey = manager.realtimeInput(f.stream.sessionId, f.stream.serial, {kind: 'key', keyCode: 4});
  assert.deepEqual(await manager.releaseInput('missing'), {released: false});
  assert.deepEqual(await manager.releaseInput(f.stream.sessionId, 'different:5555'), {released: false});
  assert.deepEqual(await manager.releaseInput(f.stream.sessionId), {released: true});
  await manager.releaseInput(f.stream.sessionId);
  assert.deepEqual(f.control.map(message => message[1]), [0, 2, 1]);
  assert.equal(f.control.at(-1).readUInt32BE(10), 30);
  assert.equal(f.control.at(-1).readUInt32BE(14), 40);
  assert.throws(oldKey, {code: 'INPUT_RESET'});
  assert.equal(f.stream.closed, false);
  assert.equal(f.stream.controlSocket.destroyed, false);
  manager.input(f.stream.sessionId, f.stream.serial, {kind: 'key', keyCode: 4});
  assert.equal(f.control.length, 4);
  await f.stream.close();
});

test('a queued down expires while awaiting new geometry and cannot execute after reconnect', async () => {
  let now = 0;
  const f = nativeFixture({now: () => now, maxInputAgeMs: 500});
  await f.stream.startNativeTouch();
  let resolve; f.setRead(() => new Promise(done => {resolve = done;}));
  f.stream.touchGeometry.invalidate();
  const down = f.stream.touch({action: 'down', x: 10, y: 20}).catch(error => error);
  const up = f.stream.touch({action: 'up', x: 10, y: 20}).catch(error => error);
  now = 501; resolve({exitCode: 0, stdout: 'SurfaceOrientation: 0'});
  assert.equal((await down).code, 'INPUT_EXPIRED');
  assert.equal((await up).code, 'INPUT_RESET');
  assert.deepEqual(f.sent, []);
  assert.equal(f.stream.nativeTouchReady, true);
  assert.equal(f.closed(), 0);
  await f.stream.close();
});

test('video admission receives its session id for independent WebRTC transport capacity', () => {
  const seen = [];
  const stream = new ScrcpyStream({sessionId: 'rtc-viewer', serial: 'emulator:5555', adb: {}, serverPath: '/unused', emit() {},
    canEmitVideo: id => {seen.push(id); return false;}});
  stream.forwardVideoFrame({keyframe: true}, Buffer.from([1]));
  assert.deepEqual(seen, ['rtc-viewer']);
});


test('codec config is emitted before an RTC peer exists even when media frames are gated', async () => {
  const events = [];
  const stream = new ScrcpyStream({sessionId: 'rtc-bootstrap', serial: 'emulator:5555', adb: {}, serverPath: '/unused',
    emit: value => events.push(value), canEmitVideo: () => false});
  const session = Buffer.alloc(12); session.writeBigUInt64BE(1n << 63n); session.writeUInt32BE(720, 4); session.writeUInt32BE(1280, 8);
  const config = Buffer.from([0, 0, 1, 0x67, 0x42, 0xc0, 0x1f]);
  const header = Buffer.alloc(12); header.writeBigUInt64BE(1n << 62n); header.writeUInt32BE(config.length, 8);
  const parts = [session, header, config];
  await assert.rejects(stream.readVideo({read: async () => {if (parts.length) return parts.shift(); throw new Error('end');}}), /end/);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'video-config');
  assert.equal(events[0].data, config.toString('base64'));
  stream.forwardVideoFrame({keyframe: true}, Buffer.from([1]));
  assert.equal(events.length, 1);
  await stream.close();
});

test('trusted input deadline clamps native geometry waiting below the local queue budget', async () => {
  let now = 1000;
  const f = nativeFixture({now: () => now}); await f.stream.startNativeTouch();
  let resolve; f.setRead(() => new Promise(done => {resolve = done;})); f.stream.touchGeometry.invalidate();
  const down = f.stream.touch({action: 'down', x: 10, y: 20, inputDeadline: 1050}).catch(error => error);
  now = 1051; resolve({exitCode: 0, stdout: 'SurfaceOrientation: 0'});
  assert.equal((await down).code, 'INPUT_EXPIRED');
  assert.deepEqual(f.sent, []);
  await f.stream.close();
});
