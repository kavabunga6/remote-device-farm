import test from 'node:test';
import assert from 'node:assert/strict';
import http2 from 'node:http2';
import { EventEmitter } from 'node:events';
import { decodeAudioPacket, emulatorAudioHost, EmulatorAudioStream } from './emulator-audio.mjs';

const SERIAL = 'rdf-11111111-2222-3333-4444-555555555555:5555';
const FORMAT = Buffer.from([0x08, 0x80, 0xf7, 0x02, 0x10, 0x01, 0x18, 0x01]);

function varint(value) {
  const result = [];
  let n = BigInt(value);
  do {
    let byte = Number(n & 0x7fn);
    n >>= 7n;
    if (n) byte |= 0x80;
    result.push(byte);
  } while (n);
  return Buffer.from(result);
}

function packet(pcm, timestamp = 123n) {
  return Buffer.concat([
    Buffer.from([0x0a]), varint(FORMAT.length), FORMAT,
    Buffer.from([0x10]), varint(timestamp),
    Buffer.from([0x1a]), varint(pcm.length), pcm,
  ]);
}

function frame(body) {
  const result = Buffer.alloc(5 + body.length);
  result.writeUInt32BE(body.length, 1);
  body.copy(result, 5);
  return result;
}

async function waitUntil(predicate) {
  const deadline = Date.now() + 500;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Audio event not received');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

test('validates managed emulator endpoint and decodes only stereo 48 kHz S16 PCM', () => {
  assert.equal(emulatorAudioHost(SERIAL), 'rdf-11111111-2222-3333-4444-555555555555');
  assert.throws(() => emulatorAudioHost('localhost:8554'), /Invalid managed emulator serial/);
  assert.throws(() => emulatorAudioHost('rdf-11111111-2222-3333-4444-555555555555.evil:5555'), /Invalid managed emulator serial/);
  const pcm = Buffer.from([0x01, 0x00, 0xff, 0x7f, 0xfe, 0xff, 0x00, 0x80]);
  assert.deepEqual(decodeAudioPacket(packet(pcm, 1780000000000000n)), { pcm, timestamp: 1780000000000000 });
  assert.throws(() => decodeAudioPacket(packet(Buffer.from([1, 2, 3]))), /Invalid emulator PCM/);
  const unsupported = Buffer.concat([Buffer.from([0x0a, 0x03, 0x08, 0x80, 0x02, 0x1a, 0x04]), Buffer.alloc(4)]);
  assert.throws(() => decodeAudioPacket(unsupported), /Unsupported emulator PCM/);
});

test('streams nonzero PCM through agent events, handles fragmented gRPC frames, and stops when disabled', async () => {
  const server = http2.createServer();
  let peer;
  let requestBody = Buffer.alloc(0);
  server.on('stream', (stream, headers) => {
    peer = stream;
    assert.equal(headers[':path'], '/android.emulation.control.EmulatorController/streamAudio');
    stream.on('data', data => { requestBody = Buffer.concat([requestBody, data]); });
    stream.respond({ ':status': 200, 'content-type': 'application/grpc' });
    const warmup = frame(packet(Buffer.alloc(8)));
    stream.write(warmup.subarray(0, 3));
    stream.write(warmup.subarray(3));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const events = [];
  const errors = [];
  const audio = new EmulatorAudioStream({
    sessionId: 'session-1', serial: SERIAL, emit: event => events.push(event),
    onFailure: error => errors.push(error),
    connect: () => http2.connect('http://127.0.0.1:' + server.address().port),
  });
  try {
    await audio.start();
    assert.deepEqual(requestBody.subarray(5), FORMAT);
    assert.equal(events.length, 0);
    audio.setEnabled(true);
    const pcm = Buffer.from([0x01, 0x00, 0xff, 0x7f, 0xfe, 0xff, 0x00, 0x80]);
    peer.write(frame(packet(pcm, 456n)));
    await waitUntil(() => events.some(event => event.type === 'audio-frame'));
    assert.deepEqual(events.map(event => event.type), ['audio-config', 'audio-frame']);
    assert.equal(events[0].codec, 'pcm-s16le');
    assert.equal(events[0].sampleRate, 48000);
    assert.equal(events[0].channels, 2);
    assert.equal(events[1].timestamp, 456);
    assert.deepEqual(Buffer.from(events[1].data, 'base64'), pcm);
    audio.setEnabled(false);
    peer.write(frame(packet(pcm, 789n)));
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(events.length, 2);
    assert.deepEqual(errors, []);
  } finally {
    audio.close();
    peer?.close();
    await new Promise(resolve => server.close(resolve));
  }
});


test('closing during audio startup rejects the waiter and clears its deadline', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const clearDeadline = t.mock.method(globalThis, 'clearTimeout');
  const request = Object.assign(new EventEmitter(), { end() {}, close() {} });
  const client = Object.assign(new EventEmitter(), { request: () => request, close() {}, destroy() {} });
  const audio = new EmulatorAudioStream({ sessionId: 'starting', serial: SERIAL, emit() {}, connect: () => client });
  let outcome = 'pending';
  const ready = audio.start().then(() => { outcome = 'resolved'; }, error => { outcome = error.message; });
  audio.close();
  await Promise.resolve();
  assert.match(outcome, /closed/i);
  assert.equal(clearDeadline.mock.callCount(), 1);
  await ready;
  t.mock.timers.tick(6000);
  assert.equal(audio.closed, true);
});

test('a closed audio stream cannot create a new HTTP/2 client', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let connections = 0;
  const audio = new EmulatorAudioStream({ sessionId: 'closed', serial: SERIAL, emit() {}, connect: () => { connections++; throw new Error('unexpected connect'); } });
  audio.close();
  let outcome = 'pending';
  audio.start().catch(error => { outcome = error.message; });
  await Promise.resolve();
  assert.match(outcome, /closed/i);
  assert.equal(connections, 0);
});
