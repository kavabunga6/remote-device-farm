import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import net from 'node:net';
import { AndroidAudioStream } from './android-audio.mjs';
import { ScrcpyStream, scrcpyServerArgs } from './scrcpy.mjs';

const serial = 'rdf-11111111-1111-4111-8111-111111111111:5555';
test('audio-only arguments cannot start a video encoder or a control connection', () => {
  const args = scrcpyServerArgs(serial, '/data/local/tmp/test.jar', 1, 'opus', true);
  for (const arg of ['video=false', 'audio=true', 'control=false', 'send_device_meta=false']) assert.ok(args.includes(arg));
  assert.equal(args.some(x => /^(video_codec|video_bit_rate|max_fps|max_size)=/.test(x)), false);
});

test('audio-only forward mode consumes one socket and the audio header instead of a video header', async () => {
  let connections = 0, spawned;
  const sockets = new Set();
  const server = net.createServer(socket => {
    connections++; sockets.add(socket); socket.on('close', () => sockets.delete(socket));
    const config = Buffer.alloc(19); config.write('OpusHead'); config[8] = 1; config[9] = 2; config.writeUInt32LE(48000, 12);
    const header = Buffer.alloc(12); header.writeBigUInt64BE(1n << 62n); header.writeUInt32BE(config.length, 8);
    socket.write(Buffer.concat([Buffer.from([0]), Buffer.from('opus'), header, config]));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const commands = [], events = [];
  const process = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill() { this.emit('close', 0); } });
  const adb = { connect: async () => {}, run: async (_serial, args) => { commands.push(args); return { exitCode: 0, stdout: args[0] === 'forward' && args[1] === 'tcp:0' ? String(server.address().port) : '', stderr: '' }; } };
  const stream = new ScrcpyStream({ sessionId: 'audio-only', serial, adb, serverPath: new URL('./android-audio.test.mjs', import.meta.url),
    audioOnly: true, emit: event => events.push(event), createProcess: (_cmd, args) => { spawned = args; return process; },
    createEmulatorTouch: () => { throw new Error('audio cannot open touch control'); } });
  try {
    await stream.start();
    await new Promise(resolve => setImmediate(resolve));
    stream.setAudio(true);
    assert.equal(stream.audioAvailable, true); assert.equal(connections, 1);
    assert.equal(stream.videoSocket, undefined); assert.equal(stream.controlSocket, undefined);
    assert.ok(spawned.includes('video=false'));
    assert.ok(events.some(x => x.type === 'audio-config' && x.data));
    assert.equal(events.some(x => x.type.startsWith('video-')), false);
    await stream.close();
    assert.ok(commands.some(args => args[0] === 'forward' && args[1] === '--remove'));
    assert.ok(commands.some(args => args[0] === 'shell' && args[1] === 'rm'));
  } finally { await stream.close(); for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); }
});

test('a pending Android audio capture cannot publish after stop and cleanup completes before stop returns', async () => {
  let started, cleanup, options;
  const start = new Promise(resolve => { started = resolve; });
  const cleaned = new Promise(resolve => { cleanup = resolve; });
  const events = [];
  const capture = new AndroidAudioStream({ emit: event => events.push(event), createStream: value => {
    options = value; return { audioAvailable: true, audioCodec: 'opus', start: () => start, close: () => cleaned };
  } });
  const opening = capture.start(); const rejected = assert.rejects(opening, /closed|stopped/i);
  let stopped = false; const closing = capture.close().then(() => { stopped = true; });
  started(); options.emit({ type: 'audio-frame' }); await new Promise(resolve => setImmediate(resolve));
  assert.equal(stopped, false); assert.deepEqual(events, []);
  cleanup(); await rejected; await closing; assert.equal(stopped, true);
});

test('Android audio retries AAC only for an unsupported Opus encoder and releases its first server', async () => {
  const codecs = [], closed = [];
  const capture = new AndroidAudioStream({ emit() {}, createStream: options => ({ audioCodec: options.audioCodec, audioAvailable: true,
    start: async () => { codecs.push(options.audioCodec); if (options.audioCodec === 'opus') throw Object.assign(new Error('opus'), { code: 'SCRCPY_AUDIO_CODEC_ERROR' }); },
    close: async () => { closed.push(options.audioCodec); }, setAudio() {} }) });
  await capture.start(); assert.deepEqual(codecs, ['opus', 'aac']); assert.equal(capture.codec, 'aac');
  assert.deepEqual(closed, ['opus']); await capture.close(); assert.deepEqual(closed, ['opus', 'aac']);
});
