import assert from 'node:assert/strict';
import test from 'node:test';
import WebSocket from 'ws';
import type { Pool } from 'pg';
import { AgentHub } from '../src/agent.js';

test('an open socket without heartbeat is unavailable before the stale sweep, and a fresh heartbeat restores it', async () => {
  const hub = new AgentHub({} as Pool); const sent: string[] = [];
  const ws = { readyState: WebSocket.OPEN, send: (s: string) => sent.push(s), terminate() {} } as unknown as WebSocket;
  const link = { ws, hostId: 'worker', lastHeartbeat: Date.now() - 46_000 };
  const internal = hub as unknown as { agents: Map<string, typeof link> };
  internal.agents.set('worker', link);
  try {
    assert.equal(hub.hasAgent('worker'), false);
    await assert.rejects(hub.command('worker', 'session', 'adb', {}, 10), (e: unknown) => (e as { code: string }).code === 'agent_offline');
    assert.deepEqual(sent, []);
    link.lastHeartbeat = Date.now(); assert.equal(hub.hasAgent('worker'), true);
    Object.defineProperty(ws, 'readyState', { value: WebSocket.CLOSED }); assert.equal(hub.hasAgent('worker'), false);
  } finally { await hub.dispose(); }
});
