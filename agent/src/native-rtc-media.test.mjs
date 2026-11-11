import assert from 'node:assert/strict';
import test from 'node:test';
import { NativeVp8Frames } from './native-rtc-media.mjs';

const key = Buffer.from([0x10, 0, 0, 0x9d, 0x01, 0x2a, 0x38, 0x04, 0x60, 0x09, 42]);
const packet = (sequenceNumber, timestamp, data, start = true, marker = true) => ({
  header: { sequenceNumber, timestamp, marker }, payload: Buffer.concat([Buffer.from([start ? 0x10 : 0]), data])
});
test('native VP8 reassembles one access unit, dimensions and RTP clock wrap without transcoding', () => {
  const stream = new NativeVp8Frames();
  assert.equal(stream.push(packet(65535, 0xfffffff0, key.subarray(0, 6), true, false)), null);
  const frame = stream.push(packet(0, 0xfffffff0, key.subarray(6), false));
  assert.deepEqual(frame.data, key);
  assert.equal(frame.keyframe, true); assert.equal(frame.width, 1080); assert.equal(frame.height, 2400);
  const delta = Buffer.from([1, 42]);
  const next = stream.push(packet(1, 8984, delta));
  assert.deepEqual(next.data, delta); assert.equal(next.timestamp - frame.timestamp, 100000);
});
test('missing RTP fragments require a new keyframe and never emit corrupt deltas', () => {
  let requests = 0;
  const stream = new NativeVp8Frames({ requestKeyframe: () => requests++ });
  stream.push(packet(1, 0, key));
  stream.push(packet(2, 1, key.subarray(0, 5), true, false));
  assert.equal(stream.push(packet(4, 1, key.subarray(5), false)), null);
  assert.equal(stream.push(packet(5, 2, Buffer.from([1, 0]))), null);
  assert.ok(requests > 0); assert.ok(stream.push(packet(6, 3, key))?.keyframe);
});
test('oversized or malformed frames are dropped with bounded retained data', () => {
  const stream = new NativeVp8Frames({ maxBytes: 32, maxPackets: 3 });
  stream.push(packet(1, 0, key));
  for (let i = 0; i < 100; i++) stream.push(packet(i + 2, 1, Buffer.alloc(16), i === 0, false));
  assert.equal(stream.push(packet(102, 1, Buffer.alloc(2), false)), null);
  assert.equal(stream.push(packet(103, 2, Buffer.from([0, 0, 0, 1]))), null);
  assert.ok(stream.push(packet(104, 3, key))?.keyframe);
});

test('loss of an entire frame or its first fragment cannot produce a dependent delta', () => {
  const stream = new NativeVp8Frames();
  stream.push(packet(1, 1, key));
  assert.equal(stream.push(packet(3, 3, Buffer.from([1, 42]))), null);
  assert.ok(stream.push(packet(4, 4, key))?.keyframe);
  assert.equal(stream.push(packet(6, 5, Buffer.from([1, 42]), false)), null);
  assert.ok(stream.push(packet(7, 6, key))?.keyframe);
});
