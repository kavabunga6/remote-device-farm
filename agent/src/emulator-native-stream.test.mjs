import assert from 'node:assert/strict';
import test from 'node:test';
import { NativeEmulatorStream } from './emulator-native-stream.mjs';
import { protoBytes } from './emulator-rtc-signaling.mjs';

function event() { const handlers = []; return { subscribe: fn => handlers.push(fn), emit: (...args) => handlers.forEach(fn => fn(...args)) }; }
const key = Buffer.from([0x10, 0, 0, 0x9d, 1, 0x2a, 0x38, 4, 0x60, 9, 42]);
function fixture(options = {}) {
  const messages = [], inputs = [], geometry = [], rpc = [];
  let ready, rotation = 0, failPaste = false, closed = 0;
  const answered = new Promise(resolve => { ready = resolve; });
  const track = { kind: 'video', onReceiveRtp: event() };
  const pc = { onTrack: event(), onDataChannel: event(), connectionStateChange: event(),
    getTransceivers: () => [{ kind: 'video', setDirection() {}, receiver: { sendRtcpPLI: async () => {} } }],
    setRemoteDescription: async () => { pc.onTrack.emit(track); }, createAnswer: async () => ({}),
    setLocalDescription: async () => {}, localDescription: { sdp: 'answer' }, addIceCandidate: async () => {}, close: async () => { closed++; } };
  const control = { prepare: async () => ({ width: 1080, height: 2400 }),
    rpc: async (method, bytes) => {
      rpc.push({ method, bytes });
      if (method === 'getScreenshot') return Buffer.concat([protoBytes(1, protoBytes(2, Buffer.from([8, rotation]))), protoBytes(4, Buffer.from('pixel'))]);
      if (failPaste && method === 'sendKey' && bytes.includes(Buffer.from('v'))) throw new Error('paste failed');
      return Buffer.alloc(0);
    }, setGeometry: g => geometry.push(g), sendTouch: p => { inputs.push(p); return true; }, releaseInput: async () => {}, close: async () => { closed++; } };
  const signaling = { start: async receive => receive({ type: 'offer', sdp: 'a=ssrc:42\r\n' }),
    snapshot: async () => Buffer.concat([protoBytes(1, Buffer.from([24, 0xe0, 3, 32, 0x80, 6])), protoBytes(4, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))]),
    send: async () => ready(), close: async () => { closed++; } };
  const stream = new NativeEmulatorStream({ sessionId: 'native-test', serial: 'rdf-11111111-1111-4111-8111-111111111111:5555',
    emit: message => messages.push(message), createPeer: () => pc, createSignaling: () => signaling, createTouch: () => control, ...options });
  let seq = 0;
  const frame = (timestamp = 0, data = key) => track.onReceiveRtp.emit({ header: { timestamp, sequenceNumber: seq++, marker: true }, payload: Buffer.concat([Buffer.from([0x10]), data]) });
  return { stream, answered, pc, frame, messages, inputs, geometry, rpc, control, closed: () => closed, rotation: value => { rotation = value; }, failPaste: () => { failPaste = true; } };
}

test('an advertised audio track does not claim playback; missing Opus uses a stable fallback source', async () => {
  const f = fixture({ audioEnabled: true });
  const starting = f.stream.start(); await f.answered; f.frame(); await starting;
  f.pc.onTrack.emit({ kind: 'audio', onReceiveRtp: event() });
  assert.equal(f.stream.audioAvailable, false);
  assert.equal(f.messages.some(x => x.type === 'audio-config'), false);
  f.stream.selectAudioSource(); f.stream.setAudio(true);
  f.stream.audioPacket({ header: { timestamp: 0 }, payload: Buffer.from([0xf8, 0xff, 0xfe]) });
  assert.equal(f.stream.audioAvailable, false);
  assert.equal(f.messages.some(x => x.type.startsWith('audio-')), false);
  await f.stream.close();
});

test('actual Opus packets establish native audio and precede playback with a decoder config', async () => {
  const f = fixture({ audioEnabled: true });
  const starting = f.stream.start(); await f.answered; f.frame(); await starting;
  f.stream.audioPacket({ header: { timestamp: 0 }, payload: Buffer.from([0xf8, 0xff, 0xfe]) });
  assert.equal(f.stream.audioAvailable, true); f.stream.selectAudioSource();
  assert.equal(f.stream.audioSource, 'opus');
  assert.deepEqual(f.messages.filter(x => x.type.startsWith('audio-')).map(x => x.type), ['audio-config', 'audio-frame']);
  await f.stream.close();
});

test('the internal native peer uses ICE lite so werift cannot add its default public STUN server', async () => {
  const f = fixture(); let options;
  f.stream.createPeer = value => { options = value; return f.pc; };
  const starting = f.stream.start(); await f.answered; f.frame(); await starting;
  assert.equal(options.iceLite, true); assert.deepEqual(options.iceServers, []);
  await f.stream.close();
});
test('connected alone is not ready: native startup waits for the first decodable keyframe', async () => {
  const f = fixture(); let ready = false;
  const starting = f.stream.start().then(() => { ready = true; });
  await f.answered; f.pc.connectionStateChange.emit('connected');
  await new Promise(resolve => setImmediate(resolve)); assert.equal(ready, false);
  f.frame(); await starting; assert.equal(ready, true);
  assert.ok(f.rpc[0].bytes.includes(Buffer.from('WakeUp')));
  assert.equal(f.messages[0].codec, 'vp8'); assert.equal(f.messages[1].type, 'video-frame');
  await f.stream.close(); assert.equal(f.closed(), 3);
});
test('codec metadata is available with video admission disabled so RTC negotiation cannot deadlock', async () => {
  const f = fixture({ canEmitVideo: () => false }); const starting = f.stream.start(); await f.answered;
  f.frame(); await starting;
  assert.deepEqual(f.messages.map(m => m.type), ['video-config']);
  await f.stream.close();
});
test('an emulator with no video frame times out and releases all native resources', async () => {
  const f = fixture({ startTimeoutMs: 20 });
  await assert.rejects(f.stream.start(), /decodable video frame/);
  assert.equal(f.closed(), 3);
});
test('closing pending startup rejects it and cannot publish late media', async () => {
  const f = fixture(); const starting = f.stream.start(); await f.answered;
  const rejected = assert.rejects(starting, /closed/); await f.stream.close(); await rejected;
  f.frame(); assert.equal(f.messages.length, 0);
});
test('native input uses native framebuffer orientation and rejects old input epochs after release', async () => {
  const f = fixture(); const starting = f.stream.start(); await f.answered; f.frame(); await starting;
  f.rotation(3); await f.stream.touch({ action: 'down', x: 10, y: 20, pointerId: 0 });
  assert.equal(f.geometry.at(-1).rotation, 3); assert.equal(f.inputs.at(-1).width, 1080);
  const epoch = f.stream.inputEpoch; await f.stream.releaseInput();
  await assert.rejects(f.stream.input({ kind: 'key', keyCode: 3 }, epoch), /closed/);
  await f.stream.input({ kind: 'key', keyCode: 3 });
  assert.ok(f.rpc.at(-1).bytes.includes(Buffer.from('GoHome')));
  await f.stream.close();
});
test('clipboard paste releases Control even when delivery of the paste key fails', async () => {
  const f = fixture(); const starting = f.stream.start(); await f.answered; f.frame(); await starting;
  f.rpc.length = 0;
  f.failPaste(); await assert.rejects(f.stream.input({ kind: 'text', text: 'Привет' }), /paste failed/);
  assert.equal(f.rpc[0].method, 'setClipboard');
  assert.equal(f.rpc.at(-1).bytes[1], 1); assert.equal(f.stream.controlHeld, false);
  await f.stream.close();
});

test('release waits for pending text and prevents its paste after another controller takes over', async () => {
  const f = fixture(); const starting = f.stream.start(); await f.answered; f.frame(); await starting;
  let finish, entered, done = false;
  const enteredClipboard = new Promise(resolve => { entered = resolve; });
  const previous = f.control.rpc;
  f.control.rpc = async (...args) => { if (args[0] === 'setClipboard') { entered(); await new Promise(resolve => { finish = resolve; }); } return previous(...args); };
  const text = f.stream.input({ kind: 'text', text: 'test' }).finally(() => { done = true; });
  const rejected = assert.rejects(text, /closed/); await enteredClipboard;
  const released = f.stream.releaseInput(); assert.equal(done, false); finish();
  await released; assert.equal(done, true); await rejected;
  await f.stream.input({ kind: 'key', keyCode: 3 }); await f.stream.close();
});

test('a static screen receives one native PNG seed, then switches to the unchanged VP8 stream on redraw', async () => {
  const f = fixture(); const starting = f.stream.start(); await f.answered;
  await f.stream.snapshot(); await starting;
  assert.deepEqual(f.messages.map(m => m.type), ['video-config', 'frame']);
  assert.equal(f.messages[1].mime, 'image/png');
  f.frame(); assert.equal(f.messages.at(-1).codec, 'vp8');
  assert.equal(f.messages.filter(m => m.type === 'frame').length, 1);
  await f.stream.close();
});

test('release cannot deliver a queued touch after its previous controller was revoked', async () => {
  const f = fixture(); const starting = f.stream.start(); await f.answered; f.frame(); await starting;
  const down = f.stream.touch({ action: 'down', x: 10, y: 20, pointerId: 0 });
  const rejected = assert.rejects(down, /closed/); await f.stream.releaseInput(); await rejected;
  assert.equal(f.inputs.length, 0); await f.stream.close();
});
