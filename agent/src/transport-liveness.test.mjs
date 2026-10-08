import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { watchBrokerSocket } from './transport-liveness.mjs';

test('broker liveness ignores slow metrics probes and closes a half-open connection', t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let now = 10000;
  const socket = new EventEmitter(); Object.assign(socket, { readyState: 0, pings: 0,
    ping() { this.pings++; }, terminate() { this.readyState = 3; this.emit('close'); } });
  watchBrokerSocket(socket, { now: () => now });
  socket.readyState = 1; socket.emit('open');
  now += 2000; t.mock.timers.tick(2000); assert.equal(socket.pings, 1);
  socket.emit('pong');
  now += 6000; t.mock.timers.tick(2000); assert.equal(socket.readyState, 1);
  now += 2000; t.mock.timers.tick(2000); assert.equal(socket.readyState, 3);
  assert.equal(socket.listenerCount('pong'), 0);
  const sent = socket.pings; t.mock.timers.tick(10000); assert.equal(socket.pings, sent);
});

test('closing before open removes liveness listeners and cannot create a later timer', t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const socket = new EventEmitter(); Object.assign(socket, { readyState: 0,
    ping: () => assert.fail('closed socket pinged'), terminate: () => assert.fail('closed socket terminated') });
  watchBrokerSocket(socket); socket.emit('close'); socket.readyState = 1; socket.emit('open');
  t.mock.timers.tick(10000); assert.equal(socket.listenerCount('pong'), 0);
});
