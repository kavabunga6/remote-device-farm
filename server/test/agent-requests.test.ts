import assert from 'node:assert/strict';
import test from 'node:test';
import type WebSocket from 'ws';
import { AgentRequests } from '../src/agent-requests.js';
const meta = (action = 'adb') => ({ ws: {} as WebSocket, hostId: 'host', sessionId: 'session', action });
test('RPC timeout, send failure and response settle once and release their timers', async () => {
  const requests = new AgentRequests();
  let id = '';
  const pending = requests.request(meta(), 1000, value => { id = value; });
  requests.take(id)!.resolve({ ok: true });
  assert.deepEqual(await pending, { ok: true });
  assert.equal(requests.take(id), undefined);
  await assert.rejects(requests.request(meta(), 1000, () => { throw Error('send failed'); }), /send failed/);
  await assert.rejects(requests.request(meta(), 5, () => {}), /timed out/);
  assert.equal([...requests].length, 0);
});
test('disconnect preserves starts for recovery and disposal rejects all outstanding requests', async () => {
  const requests = new AgentRequests();
  const start = requests.request(meta('start'), 1000, () => {});
  const command = requests.request(meta(), 1000, () => {});
  const failed = assert.rejects(command, /disconnected/);
  requests.rejectWhere(entry => entry.action !== 'start', Error('disconnected'));
  await failed;
  assert.equal([...requests].length, 1);
  const stopped = assert.rejects(start, /shutdown/);
  requests.rejectWhere(() => true, Error('shutdown'));
  await stopped;
  assert.equal([...requests].length, 0);
});
