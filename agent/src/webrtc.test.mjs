import test from 'node:test';
import assert from 'node:assert/strict';
import { WebRtcManager } from './webrtc.mjs';

const SESSION = 'session-test';
const PEER = '11111111-2222-3333-4444-555555555555';
const SDP = {type: 'offer', sdp: 'v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 100\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n'};
const configBytes = suffix => Buffer.from([0, 0, 0, 1, 0x67, 0x42, 0xc0, 0x1f, suffix, 0, 0, 1, 0x68, 42]);
const frame = (keyframe, timestamp = 1000000) => ({type: 'video-frame', sessionId: SESSION, codec: 'h264', keyframe, timestamp,
  data: Buffer.from([0, 0, 1, keyframe ? 0x65 : 0x41, 42]).toString('base64')});
const deferred = () => {let resolve; const promise = new Promise(done => {resolve = done;}); return {promise, resolve};};
function event() {const callbacks = []; return {subscribe: fn => callbacks.push(fn), emit: value => callbacks.forEach(fn => fn(value))};}
async function until(predicate) {
  for (let i = 0; i < 100; i++) {if (predicate()) return; await new Promise(resolve => setImmediate(resolve));}
  assert.fail('Expected asynchronous RTC state was not reached');
}
class FakePeer {
  constructor({send, remote} = {}) {
    this.connectionState = 'connected'; this.closed = 0; this.answerCalls = 0; this.added = 0;
    this.onDataChannel = event(); this.connectionStateChange = event(); this.send = send; this.remote = remote;
    this.packets = [];
  }
  addTrack(track) {
    this.added++;
    return {codec: {payloadType: track.kind === 'video' ? 100 : 111}, ssrc: 42, onPictureLossIndication: event(),
      sendRtp: async packet => {this.packets.push({kind: track.kind, packet}); await this.send?.(packet, track.kind);}};
  }
  async setRemoteDescription(value) {this.remoteStarted = true; await this.remote?.(value);}
  async createAnswer() {this.answerCalls++; return {type: 'answer', sdp: 'v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 100\r\n'};}
  async setLocalDescription(value) {this.localDescription = value;}
  async close() {this.closed++; this.connectionState = 'closed'; this.connectionStateChange.emit('closed');}
}
function channel() {
  return {label: 'control', ordered: true, maxRetransmits: null, maxPacketLifeTime: null, readyState: 'open', bufferedAmount: 0,
    stateChange: event(), onMessage: event(), sent: [], send(value) {this.sent.push(JSON.parse(value));}, close() {this.readyState = 'closed'; this.stateChange.emit('closed');}};
}
function fixture(t, options = {}) {
  const pcs = [], opened = [], released = [], inputs = [], keyframes = [];
  let now = 100000;
  const rtc = new WebRtcManager({
    streams: {streams: new Map(), requestKeyframe: (...args) => {keyframes.push(args);}},
    config: {enabled: true, iceServers: [], addresses: [], icePortRange: [51000, 51100]},
    now: () => now,
    createPeer: () => {const pc = new FakePeer(options.peer?.(pcs.length)); pcs.push(pc); return pc;},
    openInput: (...args) => {opened.push(args); return options.openInput?.(...args);},
    releaseInput: (...args) => {released.push(args); return options.releaseInput?.(...args);},
    input: (...args) => {inputs.push(args); return options.input?.(...args);},
  });
  rtc.publish({type: 'video-config', sessionId: SESSION, codec: 'h264', width: 720, height: 1280, data: configBytes(9).toString('base64')});
  t.after(() => rtc.closeAll());
  return {rtc, pcs, opened, released, inputs, keyframes, setNow: value => {now = value;},
    offer: (canControl = true, peerId = PEER) => rtc.offer(SESSION, 'device:5555', {peerId, description: SDP, canControl})};
}

test('control and view-only peers both require server lease renewal; only controllers release input', async t => {
  t.mock.timers.enable({apis: ['setInterval']});
  const f = fixture(t);
  await f.offer(true); await f.offer(false, '22222222-2222-3333-4444-555555555555');
  assert.equal(f.opened.length, 1);
  f.setNow(109000);
  assert.deepEqual(f.rtc.renew(SESSION, PEER), {renewed: true, inputActivity: 0});
  assert.deepEqual(f.rtc.renew('wrong-session', '22222222-2222-3333-4444-555555555555'), {renewed: false, inputActivity: 0});
  f.setNow(110001); t.mock.timers.tick(1000);
  await until(() => f.pcs[1].closed === 1);
  assert.equal(f.pcs[0].closed, 0); assert.equal(f.released.length, 0);
  f.setNow(119001); t.mock.timers.tick(1000);
  await until(() => f.pcs[0].closed === 1);
  assert.deepEqual(f.released, [[SESSION, PEER]]);
  assert.equal(f.rtc.peers.size, 0);
});

test('lost control heartbeat closes a peer despite a renewed management lease', async t => {
  t.mock.timers.enable({apis: ['setInterval']});
  const f = fixture(t); await f.offer();
  f.pcs[0].onDataChannel.emit(channel());
  f.setNow(108001); f.rtc.renew(SESSION, PEER); t.mock.timers.tick(1000);
  await until(() => f.pcs[0].closed === 1);
  assert.deepEqual(f.released, [[SESSION, PEER]]);
});

test('an overflowing video burst invalidates queued dependencies and waits for a fresh keyframe', async t => {
  const gate = deferred(); let held = false;
  const f = fixture(t, {peer: () => ({send: async () => {if (!held) {held = true; await gate.promise;}}})});
  t.after(() => gate.resolve()); await f.offer();
  f.rtc.publish(frame(true));
  f.rtc.publish(frame(true, 1020000));
  for (let i = 2; i <= 5; i++) f.rtc.publish(frame(false, 1000000 + i * 20000));
  const peer = f.rtc.peers.get(PEER);
  assert.equal(peer.videoQueue.length, 0);
  gate.resolve(); await until(() => !peer.videoBusy);
  assert.equal(peer.needsKeyframe, true);
  const count = f.pcs[0].packets.length;
  f.rtc.publish(frame(false, 1120000));
  assert.equal(f.pcs[0].packets.length, count);
  f.rtc.publish(frame(true, 1140000)); await until(() => !peer.videoBusy);
  assert.equal(peer.needsKeyframe, false);
});

test('a display codec change invalidates in-flight completion and pending old-config frames', async t => {
  const gate = deferred(); let held = false;
  const f = fixture(t, {peer: () => ({send: async () => {if (!held) {held = true; await gate.promise;}}})});
  t.after(() => gate.resolve()); await f.offer();
  f.rtc.publish(frame(true)); f.rtc.publish(frame(true, 1033333));
  f.rtc.publish({type: 'video-config', sessionId: SESSION, codec: 'h264', width: 1280, height: 720, data: configBytes(10).toString('base64')});
  const peer = f.rtc.peers.get(PEER);
  assert.equal(peer.videoQueue.length, 0);
  gate.resolve(); await until(() => !peer.videoBusy);
  assert.equal(peer.needsKeyframe, true);
  // Only the first old SPS packet reached the sender; the old IDR is not sent
  // after its configuration was superseded.
  assert.equal(f.pcs[0].packets.length, 1);
  f.rtc.publish(frame(true, 1066666)); await until(() => !peer.videoBusy);
  assert.equal(peer.needsKeyframe, false);
  assert.equal(f.pcs[0].packets[1].packet.payload.at(-1), 10);
});

test('one slow peer cannot block video delivery to a second peer', async t => {
  const gate = deferred();
  const f = fixture(t, {peer: index => index === 0 ? {send: () => gate.promise} : {}});
  t.after(() => gate.resolve());
  await f.offer(); await f.offer(false, '22222222-2222-3333-4444-555555555555');
  f.rtc.publish(frame(true));
  await until(() => !f.rtc.peers.get('22222222-2222-3333-4444-555555555555').videoBusy);
  assert.equal(f.pcs[0].packets.length, 1);
  assert.equal(f.pcs[1].packets.length, 3);
  gate.resolve();
});

test('closing a pending offer prevents late negotiation and cannot close a replacement peer', async t => {
  const gate = deferred();
  const f = fixture(t, {peer: index => index === 0 ? {remote: () => gate.promise} : {}});
  t.after(() => gate.resolve());
  const pending = f.offer().catch(error => error);
  await until(() => f.pcs[0].remoteStarted);
  await f.rtc.close(SESSION, PEER);
  await f.offer();
  gate.resolve();
  assert.match((await pending).message, /closed during negotiation/);
  assert.equal(f.pcs[0].answerCalls, 0);
  assert.equal(f.pcs[1].closed, 0);
  f.pcs[0].connectionStateChange.emit('closed');
  assert.equal(f.pcs[1].closed, 0);
  assert.equal(f.rtc.peers.get(PEER).pc, f.pcs[1]);
});

test('close waits for an opening input epoch then releases it without constructing late tracks', async t => {
  const gate = deferred();
  const f = fixture(t, {openInput: () => gate.promise});
  t.after(() => gate.resolve());
  const pending = f.offer().catch(error => error);
  const closing = f.rtc.close(SESSION, PEER);
  await assert.rejects(f.offer(), /already exists/);
  gate.resolve();
  await closing;
  assert.match((await pending).message, /closed during negotiation/);
  assert.equal(f.pcs[0].added, 0);
  assert.deepEqual(f.released, [[SESSION, PEER]]);
  assert.equal(f.pcs[0].closed, 1);
});

test('all direct input rejections use input-error and release only their controlling peer epoch', async t => {
  const f = fixture(t, {input: () => Promise.reject(Object.assign(new Error('expired'), {code: 'input_expired'}))});
  await f.offer(); const dc = channel(); f.pcs[0].onDataChannel.emit(dc);
  const input = {type: 'input', epoch: PEER, seq: 1, deadline: 100500, kind: 'key', keyCode: 4};
  dc.onMessage.emit(JSON.stringify(input));
  await until(() => dc.sent.some(value => value.type === 'input-error'));
  assert.deepEqual(dc.sent.at(-1), {type: 'input-error', code: 'input_expired', message: 'expired', seq: 1});
  assert.deepEqual(f.released, [[SESSION, PEER]]);
  dc.onMessage.emit(JSON.stringify({...input, seq: 2, keyCode: 999}));
  assert.equal(dc.sent.at(-1).type, 'input-error');
  assert.equal(dc.sent.at(-1).code, 'invalid_input');
  await f.offer(false, '22222222-2222-3333-4444-555555555555');
  const viewer = channel(); f.pcs[1].onDataChannel.emit(viewer);
  const before = f.released.length;
  viewer.onMessage.emit(JSON.stringify({...input, epoch: '22222222-2222-3333-4444-555555555555'}));
  assert.equal(viewer.sent.at(-1).type, 'input-error');
  assert.equal(viewer.sent.at(-1).code, 'readonly');
  assert.equal(f.released.length, before);
});


test('lease activity counts only successful device inputs, never pings, client sequence values or failed actions', async t => {
  let fail = false;
  const f = fixture(t, {input: async () => {if (fail) throw new Error('rejected');}});
  await f.offer(); const dc = channel(); f.pcs[0].onDataChannel.emit(dc);
  dc.onMessage.emit(JSON.stringify({type: 'ping', id: 'keepalive'}));
  assert.deepEqual(f.rtc.renew(SESSION, PEER), {renewed: true, inputActivity: 0});
  const input = {type: 'input', epoch: PEER, seq: 1000000, deadline: 100500, kind: 'key', keyCode: 4};
  dc.onMessage.emit(JSON.stringify(input));
  await until(() => dc.sent.some(message => message.type === 'input-ack'));
  assert.deepEqual(f.rtc.renew(SESSION, PEER), {renewed: true, inputActivity: 1});
  fail = true; dc.onMessage.emit(JSON.stringify({...input, seq: 1000001}));
  await until(() => dc.sent.some(message => message.type === 'input-error'));
  dc.onMessage.emit(JSON.stringify({type: 'ping', id: 'still-here'}));
  assert.deepEqual(f.rtc.renew(SESSION, PEER), {renewed: true, inputActivity: 1});
});


test('a receiver PLI during an in-flight delta survives completion of that older frame', async t => {
  const gate = deferred(); let hold = false;
  const f = fixture(t, {peer: () => ({send: async () => {if (hold) await gate.promise;}})});
  t.after(() => gate.resolve()); await f.offer();
  const peer = f.rtc.peers.get(PEER);
  f.rtc.publish(frame(true)); await until(() => !peer.videoBusy);
  assert.equal(peer.needsKeyframe, false);
  hold = true; f.rtc.publish(frame(false, 1033333));
  f.rtc.publish(frame(false, 1066666));
  assert.equal(peer.videoQueue.length, 1);
  peer.videoSender.onPictureLossIndication.emit({});
  assert.equal(peer.videoQueue.length, 0);
  gate.resolve(); await until(() => !peer.videoBusy);
  assert.equal(peer.needsKeyframe, true);
  const count = f.pcs[0].packets.length;
  f.rtc.publish(frame(false, 1066666));
  assert.equal(f.pcs[0].packets.length, count);
});

const audioFrame = (timestamp, data = Buffer.from([0xf8, 0xff, 0xfe])) => ({
  type: 'audio-frame', sessionId: SESSION, codec: 'opus', timestamp, data: data.toString('base64'),
});

test('a buffered Opus burst preserves every packet, timestamp and marker without video-style latest replacement', async t => {
  const gate = deferred(); let held = false;
  const f = fixture(t, {peer: () => ({send: async (_packet, kind) => {if (kind === 'audio' && !held) {held = true; await gate.promise;}}})});
  t.after(() => gate.resolve()); await f.offer();
  const peer = f.rtc.peers.get(PEER);
  for (let i = 0; i < 6; i++) f.rtc.publish(audioFrame(1000000 + i * 20000));
  assert.equal(peer.audioQueue.length, 5);
  gate.resolve(); await until(() => !peer.audioBusy);
  const packets = f.pcs[0].packets.filter(value => value.kind === 'audio').map(value => value.packet);
  assert.equal(packets.length, 6);
  assert.deepEqual(packets.map(value => value.header.timestamp), [48000, 48960, 49920, 50880, 51840, 52800]);
  assert.deepEqual(packets.map(value => value.header.marker), [true, false, false, false, false, false]);
  for (let i = 1; i < packets.length; i++) assert.equal(packets[i].header.sequenceNumber, (packets[i - 1].header.sequenceNumber + 1) & 65535);
});

test('Opus congestion retains a bounded fresh tail and never compresses gaps from expired audio', async t => {
  const gate = deferred(); let held = false;
  const f = fixture(t, {peer: () => ({send: async (_packet, kind) => {if (kind === 'audio' && !held) {held = true; await gate.promise;}}})});
  t.after(() => gate.resolve()); await f.offer();
  const peer = f.rtc.peers.get(PEER);
  for (let i = 0; i < 20; i++) f.rtc.publish(audioFrame(1000000 + i * 20000));
  assert.equal(peer.audioQueue.length, 8);
  assert.equal(peer.audioQueue[0].event.timestamp, 1240000);
  f.setNow(100151);
  gate.resolve(); await until(() => !peer.audioBusy);
  assert.equal(f.pcs[0].packets.length, 1);
  f.rtc.publish(audioFrame(1400000));
  await until(() => !peer.audioBusy);
  assert.deepEqual(f.pcs[0].packets.map(value => value.packet.header.timestamp), [48000, 67200]);
  assert.equal(f.pcs[0].packets.at(-1).packet.header.marker, true);
});

test('ordinary video overlap queues complete access units and does not request another keyframe', async t => {
  const gate = deferred(); let held = false;
  const f = fixture(t, {peer: () => ({send: async () => {if (!held) {held = true; await gate.promise;}}})});
  t.after(() => gate.resolve()); await f.offer();
  const peer = f.rtc.peers.get(PEER);
  f.rtc.publish(frame(true, 1000000));
  for (let i = 1; i <= 3; i++) f.rtc.publish(frame(false, 1000000 + i * 30000));
  assert.equal(peer.videoQueue.length, 3);
  assert.equal(f.keyframes.length, 0);
  gate.resolve(); await until(() => !peer.videoBusy);
  const frames = f.pcs[0].packets.filter(value => value.packet.header.marker);
  assert.deepEqual(frames.map(value => value.packet.header.timestamp), [90000, 92700, 95400, 98100]);
  assert.equal(peer.needsKeyframe, false);
  assert.equal(f.keyframes.length, 0);
});

test('expired video access units discard dependent frames, then a fresh IDR recovers immediately', async t => {
  const gate = deferred(); let hold = false;
  const f = fixture(t, {peer: () => ({send: async () => {if (hold) await gate.promise;}})});
  t.after(() => gate.resolve()); await f.offer();
  const peer = f.rtc.peers.get(PEER);
  f.rtc.publish(frame(true, 1000000)); await until(() => !peer.videoBusy);
  hold = true;
  f.rtc.publish(frame(false, 1030000)); f.rtc.publish(frame(false, 1060000));
  f.setNow(100121); gate.resolve(); await until(() => !peer.videoBusy);
  assert.equal(peer.videoQueue.length, 0); assert.equal(peer.needsKeyframe, true);
  const count = f.pcs[0].packets.length;
  f.rtc.publish(frame(false, 1090000)); assert.equal(f.pcs[0].packets.length, count);
  f.rtc.publish(frame(true, 1120000)); await until(() => !peer.videoBusy);
  assert.equal(peer.needsKeyframe, false);
});

test('video queue bytes are bounded and an overflowing fresh IDR replaces the invalidated dependency chain', async t => {
  const gate = deferred(); let held = false;
  const f = fixture(t, {peer: () => ({send: async () => {if (!held) {held = true; await gate.promise;}}})});
  t.after(() => gate.resolve()); await f.offer();
  const peer = f.rtc.peers.get(PEER);
  f.rtc.publish(frame(true, 1000000));
  const large = Buffer.concat([Buffer.from([0, 0, 1, 0x41]), Buffer.alloc(2300000)]).toString('base64');
  f.rtc.publish({...frame(false, 1020000), data: large});
  f.rtc.publish({...frame(false, 1040000), data: large});
  assert.equal(peer.videoQueue.length, 0); assert.equal(peer.needsKeyframe, true);
  f.rtc.publish(frame(true, 1060000));
  gate.resolve(); await until(() => !peer.videoBusy);
  assert.equal(peer.needsKeyframe, false);
  assert.equal(f.pcs[0].packets.length, 4); // one old SPS + complete new SPS/PPS/IDR
});

test('closing a peer clears bounded media queues without sending delayed packets', async t => {
  const gate = deferred();
  const f = fixture(t, {peer: () => ({send: () => gate.promise})});
  t.after(() => gate.resolve()); await f.offer();
  f.rtc.publish(frame(true)); f.rtc.publish(frame(false, 1020000));
  f.rtc.publish(audioFrame(1000000)); f.rtc.publish(audioFrame(1020000));
  const peer = f.rtc.peers.get(PEER);
  await f.rtc.close(SESSION, PEER); gate.resolve();
  await until(() => !peer.videoBusy && !peer.audioBusy);
  assert.equal(peer.videoQueue.length, 0); assert.equal(peer.audioQueue.length, 0);
  assert.equal(f.pcs[0].packets.length, 2);
});

test('Opus byte bounds trim only the oldest unsent packets without compressing their sample positions', async t => {
  const gate = deferred(); let held = false;
  const f = fixture(t, {peer: () => ({send: async (_packet, kind) => {if (kind === 'audio' && !held) {held = true; await gate.promise;}}})});
  t.after(() => gate.resolve()); await f.offer();
  const peer = f.rtc.peers.get(PEER);
  f.rtc.publish(audioFrame(1000000));
  const large = Buffer.alloc(70000, 0xff); large[0] = 0xf8;
  f.rtc.publish(audioFrame(1020000, large)); f.rtc.publish(audioFrame(1040000, large));
  assert.equal(peer.audioQueue.length, 1); assert.equal(peer.audioQueue[0].event.timestamp, 1040000);
  gate.resolve(); await until(() => !peer.audioBusy);
  assert.deepEqual(f.pcs[0].packets.map(value => value.packet.header.timestamp), [48000, 49920]);
});

test('an audio config restart discards queued old samples and cannot inherit their in-flight timestamp', async t => {
  const gate = deferred(); let held = false;
  const f = fixture(t, {peer: () => ({send: async (_packet, kind) => {if (kind === 'audio' && !held) {held = true; await gate.promise;}}})});
  t.after(() => gate.resolve()); await f.offer();
  const peer = f.rtc.peers.get(PEER);
  f.rtc.publish({type: 'audio-config', sessionId: SESSION, codec: 'opus', data: 'old'});
  f.rtc.publish(audioFrame(1000000)); f.rtc.publish(audioFrame(1020000));
  f.rtc.publish({type: 'audio-config', sessionId: SESSION, codec: 'opus', data: 'new'});
  assert.equal(peer.audioQueue.length, 0);
  f.rtc.publish(audioFrame(20000));
  gate.resolve(); await until(() => !peer.audioBusy);
  assert.deepEqual(f.pcs[0].packets.map(value => value.packet.header.timestamp), [48000, 49920]);
  assert.equal(f.pcs[0].packets.at(-1).packet.header.marker, true);
});


test('actual Android Opus PTS jitter and initial backward PTS retain all packets with continuous sample timestamps', async t => {
  const f = fixture(t); await f.offer();
  const peer = f.rtc.peers.get(PEER);
  // First source PTS and deltas captured from the disposable Android 13.
  const deltas = [-18015, 21599, 21197, 21688, 21496, 21268, 21552, 21628,
    21052, 21555, 21163, 21569, 21233, 21560, 1333, 19922, 20927, 21913];
  let pts = 1665837148;
  for (const delta of [0, ...deltas]) {
    pts += delta;
    f.rtc.publish(audioFrame(pts, Buffer.from([0xfc, 0xff, 0xfe])));
    await until(() => !peer.audioBusy);
  }
  const packets = f.pcs[0].packets.map(value => value.packet);
  assert.equal(packets.length, deltas.length + 1);
  const first = packets[0].header.timestamp;
  assert.equal(first, 79960183);
  assert.deepEqual(packets.map(value => value.header.timestamp), packets.map((_, i) => first + i * 960));
  assert.deepEqual(packets.map(value => value.header.marker), packets.map((_, i) => i === 0));
});

test('a long audio pause drops queued old packets, rebases forward and starts a new marked talkspurt', async t => {
  const gate = deferred(); let held = false;
  const f = fixture(t, {peer: () => ({send: async (_packet, kind) => {if (kind === 'audio' && !held) {held = true; await gate.promise;}}})});
  t.after(() => gate.resolve()); await f.offer();
  const peer = f.rtc.peers.get(PEER);
  f.rtc.publish(audioFrame(1000000)); f.rtc.publish(audioFrame(1020000));
  f.setNow(101000); f.rtc.publish(audioFrame(2000000));
  assert.equal(peer.audioQueue.length, 1); assert.equal(peer.audioQueue[0].event.timestamp, 2000000);
  gate.resolve(); await until(() => !peer.audioBusy);
  const packets = f.pcs[0].packets.map(value => value.packet);
  assert.deepEqual(packets.map(value => value.header.timestamp), [48000, 96000]);
  assert.deepEqual(packets.map(value => value.header.marker), [true, true]);
});

test('audio media-duration bound uses samples even when raw capture PTS barely advances', async t => {
  const gate = deferred(); let held = false;
  const f = fixture(t, {peer: () => ({send: async (_packet, kind) => {if (kind === 'audio' && !held) {held = true; await gate.promise;}}})});
  t.after(() => gate.resolve()); await f.offer();
  const peer = f.rtc.peers.get(PEER);
  const sixtyMs = Buffer.from([0x18]);
  for (let i = 0; i < 5; i++) f.rtc.publish(audioFrame(1000000 + i * 1000, sixtyMs));
  assert.equal(peer.audioQueue.length, 3); // 3 * 60 ms apart; oldest unsent is beyond150ms
  gate.resolve(); await until(() => !peer.audioBusy);
  assert.deepEqual(f.pcs[0].packets.map(value => value.packet.header.timestamp), [48000, 53760, 56640, 59520]);
});
