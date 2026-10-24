import test from 'node:test';
import assert from 'node:assert/strict';
import { crc32, deflateSync } from 'node:zlib';
import { cameraPng, applyCameraImage } from './camera-image.mjs';
import { validateControlRequest } from './control-ipc.mjs';
import { validateEmuConsoleArgs } from './emu-console.mjs';
function png(extra = []) {
  const chunk = (name, data) => {
    const bytes = Buffer.alloc(data.length + 12);
    bytes.writeUInt32BE(data.length); bytes.write(name, 4); data.copy(bytes, 8);
    bytes.writeUInt32BE(crc32(bytes.subarray(4, -4)), bytes.length - 4); return bytes;
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(1); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header),
    ...extra.map(data => chunk('tEXt', Buffer.from(data))), chunk('IDAT', deflateSync(Buffer.from([0, 255, 0, 0, 255]))), chunk('IEND', Buffer.alloc(0))]);
}
test('camera PNG decoder bounds dimensions and output and strips metadata', () => {
  const clean = cameraPng(png(['private metadata']).toString('base64'));
  assert.ok(!clean.includes(Buffer.from('private metadata')));
  assert.deepEqual(clean, png());
  assert.throws(() => cameraPng(Buffer.from('<svg/>').toString('base64')));
  const corrupt = png(); corrupt[20] = 255;
  assert.throws(() => cameraPng(corrupt.toString('base64')));
  assert.throws(() => cameraPng('a'.repeat(400000)));
});
test('camera console and IPC accept only fixed session-local image paths and macro', () => {
  assert.ok(validateEmuConsoleArgs(['virtualscene-image', 'wall', '/android-home/rdf-camera.png']));
  assert.ok(validateControlRequest({ op: 'cameraImage', sessionId: 'session-test', params: { op: 'set', imageBase64: png().toString('base64') } }));
  for (const args of [['virtualscene-image', 'wall', '/etc/passwd'], ['automation', 'play', '/tmp/script'], ['virtualscene-image', 'table', '/android-home/rdf-camera.png']])
    assert.throws(() => validateEmuConsoleArgs(args));
  assert.throws(() => validateControlRequest({ op: 'cameraImage', sessionId: 'session-test', params: { op: 'set', imageBase64: 'a'.repeat(350001) } }));
});
test('camera refuses unrelated containers before executing or importing any data', async () => {
  let calls = 0;
  const docker = { inspect: async () => ({ Config: { Labels: { 'remote-device-farm.managed': 'true', 'remote-device-farm.agent': 'another' } }, State: { Running: true } }),
    request: async () => { calls++; } };
  await assert.rejects(applyCameraImage(docker, 'container', 'session-test', 'ours', { op: 'set', imageBase64: png().toString('base64') }));
  assert.equal(calls, 0);
});
