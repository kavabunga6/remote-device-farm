import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
const source = await readFile(new URL('./main.mjs', import.meta.url), 'utf8');
const sendCode = source.slice(source.indexOf('function send(message) {'), source.indexOf('const metrics ='));
function fixture() {
  const sent = [], requested = [], relayMedia = new Map(), relayNeedsKeyframe = new Set();
  const socket = { readyState: 1, bufferedAmount: 0, send: raw => sent.push(JSON.parse(raw)) };
  const context = vm.createContext({ socket, WebSocket: { OPEN: 1 }, relayMedia, relayNeedsKeyframe,
    streams: { streams: new Map([['s', { requestKeyframe: () => requested.push('s') }]]) } });
  vm.runInContext(sendCode, context);
  return { sent, requested, relayMedia, socket, send: message => context.send({ sessionId: 's', ...message }) };
}

test('RTC-only viewers do not duplicate H264/Opus through broker, retaining metadata and PCM fallback', () => {
  const f = fixture(); f.relayMedia.set('s', false);
  for (const type of ['video-frame', 'frame']) f.send({ type, data: 'media' });
  f.send({ type: 'audio-frame', codec: 'opus', data: 'opus' });
  f.send({ type: 'audio-frame', codec: 'pcm-s16le', data: 'pcm' });
  f.send({ type: 'video-config', data: 'config' });
  f.send({ type: 'result', id: 'command-result' });
  assert.deepEqual(f.sent.map(event => event.type), ['audio-frame', 'video-config', 'result']);
});

test('broker congestion drops stale media independently of RTC and resumes only on a fresh keyframe', () => {
  const f = fixture(); f.socket.bufferedAmount = 300 * 1024;
  f.send({ type: 'video-frame', keyframe: false, data: 'stale' });
  f.send({ type: 'audio-frame', codec: 'pcm-s16le', data: 'stale' });
  f.send({ type: 'result', id: 'ack' });
  assert.deepEqual(f.sent.map(event => event.type), ['result']);
  f.socket.bufferedAmount = 0;
  f.send({ type: 'video-frame', keyframe: false, data: 'undecodable' });
  assert.deepEqual(f.requested, ['s']);
  f.send({ type: 'video-frame', keyframe: true, data: 'fresh' });
  f.send({ type: 'video-frame', keyframe: false, data: 'next' });
  assert.deepEqual(f.sent.filter(event => event.type === 'video-frame').map(event => event.data), ['fresh', 'next']);
});
