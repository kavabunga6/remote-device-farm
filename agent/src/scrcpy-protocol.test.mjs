import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { SocketReader } from './scrcpy-protocol.mjs';
test('fragmented headers and coalesced payloads preserve byte order; close rejects pending readers', async () => {
  const socket = new EventEmitter(), reader = new SocketReader(socket);
  const first = reader.read(4), second = reader.read(2), third = reader.read(1);
  socket.emit('data', Buffer.from([1, 2]));
  socket.emit('data', Buffer.from([3, 4, 5, 6]));
  assert.deepEqual(await first, Buffer.from([1, 2, 3, 4]));
  assert.deepEqual(await second, Buffer.from([5, 6]));
  const closed = assert.rejects(third, /socket closed/);
  socket.emit('close'); await closed;
  assert.equal(reader.waiting.length, 0);
});
test('invalid packet sizes cannot leave an unresolvable pending read', () => {
  const reader = new SocketReader(new EventEmitter());
  for (const value of [NaN, Infinity, -1, 0.5, 17 * 1024 * 1024]) assert.throws(() => reader.read(value), /Invalid/);
  assert.equal(reader.waiting.length, 0);
});
