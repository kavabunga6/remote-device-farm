import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import type { Pool } from 'pg';
import { AgentHub } from '../src/agent.js';
import { readInputMetadata, streamHeartbeat } from '../src/stream-input.js';
const EPOCH = '11111111-1111-4111-8111-111111111111';
class Socket extends EventEmitter {
  readyState = WebSocket.OPEN as number;
  bufferedAmount = 0;
  sent: Record<string, unknown>[] = [];
  pings = 0;
  send(value: string) { this.sent.push(JSON.parse(value)); }
  ping() { this.pings++; }
  close() { if (this.readyState !== WebSocket.CLOSED) { this.readyState = WebSocket.CLOSED; this.emit('close'); } }
  terminate() { this.close(); }
  get ws() { return this as unknown as WebSocket; }
}

test('input metadata rejects old connection, replay, expired and unbounded deadlines', () => {
  const valid = { epoch: EPOCH, seq: 2, deadline: 11000 };
  assert.deepEqual(readInputMetadata(valid, EPOCH, 1, 10000), valid);
  assert.throws(() => readInputMetadata(valid, EPOCH, 2, 10000), /already received/);
  assert.throws(() => readInputMetadata({ ...valid, epoch: 'old' }, EPOCH, 1, 10000), /another connection/);
  assert.throws(() => readInputMetadata({ ...valid, deadline: 10000 }, EPOCH, 1, 10000), /expired/);
  assert.throws(() => readInputMetadata({ ...valid, deadline: 999999 }, EPOCH, 1, 10000), /expired/);
});

test('heartbeat detects half-open socket; valid pong extends liveness', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let now = 10000;
  const socket = new Socket();
  const handle = streamHeartbeat(socket.ws, { intervalMs: 2000, timeoutMs: 8000, now: () => now });
  assert.equal(handle({ type: 'ping', id: 'heartbeat-1' }), true);
  assert.deepEqual(socket.sent, [{ type: 'pong', id: 'heartbeat-1', serverTime: 10000 }]);
  now += 6000; t.mock.timers.tick(2000);
  assert.equal(socket.readyState, WebSocket.OPEN);
  socket.emit('pong');
  now += 6000; t.mock.timers.tick(2000);
  assert.equal(socket.readyState, WebSocket.OPEN);
  now += 2000; t.mock.timers.tick(2000);
  assert.equal(socket.readyState, WebSocket.CLOSED);
});

function hubFixture() {
  const hub = new AgentHub({} as Pool);
  const commands: Array<{ action: string; params: Record<string, unknown>; input?: Record<string, unknown> }> = [];
  hub.command = async (_host, _session, action, params, _timeout, input) => {
    commands.push({ action, params, input });
    return action === 'input-open' ? { agentTime: Date.now() - 2000 } : {};
  };
  hub.hasAgent = () => true;
  return { hub, commands };
}

test('disconnect releases only its input epoch even with a remaining spectator', async () => {
  const { hub, commands } = hubFixture();
  const controller = new Socket(), spectator = new Socket();
  const ready = await hub.openInput('s', 'h', controller.ws);
  hub.addViewer('s', 'h', controller.ws, ready);
  hub.addViewer('s', 'h', spectator.ws);
  await hub.input('s', 'h', controller.ws, { epoch: ready.inputEpoch, seq: 1, deadline: Date.now() + 1000 }, { kind: 'key', keyCode: 4 });
  const sent = commands.find(item => item.action === 'input')!;
  assert.ok(Number(sent.input?.deadline) < Date.now() - 500, 'deadline converted conservatively to the agent clock');
  await assert.rejects(hub.input('s', 'h', controller.ws, { epoch: ready.inputEpoch, seq: 1, deadline: Date.now() + 1000 }, {}), /already received/);
  assert.deepEqual(commands.filter(item => item.action === 'input-release').map(item => item.params.epoch), [ready.inputEpoch], 'rejecting input releases immediately, before browser disconnect');
  controller.close();
  assert.equal(spectator.readyState, WebSocket.OPEN);
  assert.deepEqual(commands.filter(item => item.action === 'input-release').map(item => item.params.epoch), [ready.inputEpoch]);
  assert.equal(commands.some(item => item.action === 'stream-stop'), false);
  await assert.rejects(hub.input('s', 'h', controller.ws, { epoch: ready.inputEpoch, seq: 2, deadline: Date.now() + 1000 }, {}), /closed/);
  await hub.dispose();
});

test('brief viewer reconnect cancels deferred stream stop; no viewers stop media after grace', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { hub, commands } = hubFixture();
  const first = new Socket(); hub.addViewer('s', 'h', first.ws); first.close();
  assert.equal(commands.at(-1)?.action, 'stream-start');
  assert.equal(commands.at(-1)?.params.relayMedia, false);
  t.mock.timers.tick(14000);
  const second = new Socket(); hub.addViewer('s', 'h', second.ws);
  t.mock.timers.tick(2000);
  assert.equal(commands.some(item => item.action === 'stream-stop'), false);
  second.close(); t.mock.timers.tick(15000);
  assert.equal(commands.filter(item => item.action === 'stream-stop').length, 1);
  await hub.dispose();
});

test('RTC viewer stops redundant relay while mixed viewers keep the WebSocket media path', async () => {
  const { hub, commands } = hubFixture();
  const rtc = new Socket(), ws = new Socket();
  hub.addViewer('s', 'h', rtc.ws); hub.setViewerTransport(rtc.ws, 'webrtc');
  assert.equal(commands.at(-1)?.params.relayMedia, false);
  hub.addViewer('s', 'h', ws.ws);
  assert.equal(commands.at(-1)?.params.relayMedia, true);
  ws.close();
  assert.equal(commands.at(-1)?.params.relayMedia, false);
  await hub.dispose();
});
