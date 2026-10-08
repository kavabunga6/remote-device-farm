import test from 'node:test';
import assert from 'node:assert/strict';
import { annexBNals, h264Profile, packetizeH264, rtpTimestamp, opusPacketSamples, OpusRtpClock } from './rtc-media.mjs';
import { loadRtcConfig } from './rtc-config.mjs';
import { rtcInputParams } from './webrtc.mjs';

const sps = Buffer.from([0, 0, 0, 1, 0x67, 0x42, 0xc0, 0x1f, 9]);
test('Annex B preserves mixed start codes and extracts actual encoder profile', () => {
  const data = Buffer.concat([sps, Buffer.from([0, 0, 1, 0x68, 42])]);
  assert.equal(h264Profile(data), '42c01f');
  assert.deepEqual(annexBNals(data).map(n => [...n]), [[0x67, 0x42, 0xc0, 0x1f, 9], [0x68, 42]]);
  assert.throws(() => annexBNals(Buffer.from([1, 2, 3])), /Annex B/);
});
test('FU-A fragments reassemble byte-identically and mark only final packet of access unit', () => {
  const original = Buffer.concat([Buffer.from([0x65]), Buffer.alloc(2500, 42)]);
  const packets = packetizeH264(Buffer.concat([sps, Buffer.from([0, 0, 1]), original]), 500);
  assert.ok(packets.every(p => p.payload.length <= 500));
  assert.equal(packets.filter(p => p.marker).length, 1);
  assert.equal(packets.at(-1).marker, true);
  const fu = packets.slice(1);
  assert.equal(fu[0].payload[1] & 0x80, 0x80);
  assert.equal(fu.at(-1).payload[1] & 0x40, 0x40);
  const header = (fu[0].payload[0] & 0xe0) | (fu[0].payload[1] & 31);
  assert.deepEqual(Buffer.concat([Buffer.from([header]), ...fu.map(p => p.payload.subarray(2))]), original);
});
test('RTP timestamp conversion handles rollover without signed overflow', () => {
  assert.equal(rtpTimestamp(1000000, 90000), 90000);
  assert.equal(rtpTimestamp(1000000, 48000), 48000);
  assert.equal(rtpTimestamp(2 ** 40, 90000), Number((BigInt(2 ** 40) * 90000n / 1000000n) & 0xffffffffn));
  assert.throws(() => rtpTimestamp(-1, 90000));
});
test('WebRTC config is explicit, bounded and never accepts arbitrary server schemes', () => {
  assert.equal(loadRtcConfig({}).enabled, false);
  assert.throws(() => loadRtcConfig({ AGENT_WEBRTC_PORT_MIN: '60000', AGENT_WEBRTC_PORT_MAX: '50000' }));
  assert.throws(() => loadRtcConfig({ AGENT_WEBRTC_HOST_IP: 'evil\naddress' }));
  assert.throws(() => loadRtcConfig({ AGENT_WEBRTC_ICE_SERVERS: '[{"urls":"https://example.test"}]' }));
  const config = loadRtcConfig({ AGENT_WEBRTC_ENABLED: '1', AGENT_WEBRTC_HOST_IP: '192.0.2.20', AGENT_WEBRTC_ICE_SERVERS: '[{"urls":"turn:relay.example:3478","username":"u","credential":"p"}]' });
  assert.deepEqual(config.addresses, ['192.0.2.20']);
  assert.equal(config.iceServers[0].urls[0], 'turn:relay.example:3478');
});
test('Direct DataChannel input has the same narrow validation as HTTP input', () => {
  assert.deepEqual(rtcInputParams({ kind: 'touch', action: 'down', pointerId: 0, x: 42, y: 12, command: 'ignored' }), { kind: 'touch', action: 'down', pointerId: 0, x: 42, y: 12 });
  for (const input of [{ kind: 'shell', argv: ['id'] }, { kind: 'text', text: 'a\nb' }, { kind: 'key', keyCode: 301 },
    { kind: 'touch', action: 'down', pointerId: 1, x: 0, y: 0 }, { kind: 'tap', x: '1', y: 1 }]) assert.throws(() => rtcInputParams(input));
});

test('Opus TOC duration keeps fixed 48 kHz timestamp increments across modes and packet frame counts', () => {
  assert.equal(opusPacketSamples(Buffer.from([0xf8, 0xff, 0xfe])), 960); // 20 ms CELT
  assert.equal(opusPacketSamples(Buffer.from([0x80])), 120); // 2.5 ms CELT
  assert.equal(opusPacketSamples(Buffer.from([0x18])), 2880); // 60 ms SILK
  assert.equal(opusPacketSamples(Buffer.from([0x60])), 480); // 10 ms hybrid
  assert.equal(opusPacketSamples(Buffer.from([0xf9])), 1920); // two 20 ms frames
  assert.equal(opusPacketSamples(Buffer.from([0xfb, 6])), 5760); // six frames, 120 ms
  for (const value of [[], [0xfb], [0xfb, 0], [0xfb, 7]]) assert.throws(() => opusPacketSamples(Buffer.from(value)));
});

test('Opus sample clock ignores measured capture jitter and advances by variable encoded duration across rollover', () => {
  const clock = new OpusRtpClock();
  const first = clock.accept(1665837148, 960, 0);
  assert.equal(first.position, 79960183); assert.equal(first.discontinuity, true);
  assert.deepEqual(clock.accept(1665819133, 960, 20), {position: first.position + 960, discontinuity: false});
  assert.deepEqual(clock.accept(1665840732, 2880, 40), {position: first.position + 1920, discontinuity: false});
  assert.deepEqual(clock.accept(1665842000, 120, 100), {position: first.position + 4800, discontinuity: false});
  const rollover = new OpusRtpClock();
  const near = rollover.accept(89478484000, 960, 0).position;
  const after = rollover.accept(89478505000, 960, 20).position;
  assert.equal(after - near, 960); assert.equal(after >>> 0, (near + 960) >>> 0);
});

test('Opus sample clock rebases after silence or explicit restart without running RTP backwards', () => {
  const clock = new OpusRtpClock();
  assert.equal(clock.accept(1000000, 960, 1000).position, 48000);
  assert.equal(clock.accept(982000, 960, 1020).position, 48960);
  assert.deepEqual(clock.accept(2000000, 960, 2000), {position: 96000, discontinuity: true});
  clock.reset();
  assert.deepEqual(clock.accept(10000, 960, 2020), {position: 96960, discontinuity: true});
  assert.deepEqual(clock.accept(30000, 960, 2040), {position: 97920, discontinuity: false});
  assert.deepEqual(clock.accept(20000, 960, 3040), {position: 145920, discontinuity: true});
});
