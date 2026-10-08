import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import type { Pool } from 'pg';
import type WebSocket from 'ws';
import { AgentHub } from '../src/agent.js';
import { assertProfileFitsNode, desiredNodePolicy, parseNodeSettings } from '../src/node-policy.js';

const row = { display_name: null, slot_mode: 'manual', manual_slots: 1, slot_cpu: 4,
  slot_memory_mb: 4096, disabled: false, removed_at: null, policy_revision: 3,
  metrics: { cpuAllocatableCores: 28, memoryAllocatableMb: 32768 } };

test('manual default 1 can switch to daemon-aware dynamic capacity without eviction', () => {
  assert.equal(desiredNodePolicy(row).slots, 1);
  assert.equal(desiredNodePolicy({ ...row, slot_mode: 'dynamic' }).slots, 5);
  assert.equal(desiredNodePolicy({ ...row, slot_mode: 'dynamic', metrics: {
    cpuCores: 28, cpuAllocatableCores: 4, memoryTotalMb: 32768, memoryAllocatableMb: 8192,
  } }).slots, 0);
  assert.equal(desiredNodePolicy({ ...row, disabled: true }).slots, 0);
  assert.equal(desiredNodePolicy({ ...row, removed_at: new Date() }).slots, 0);
});

test('node settings are typed and profiles fit per-slot ceilings', () => {
  assert.deepEqual(parseNodeSettings({ slotMode: 'dynamic', slotCpu: 8, slotMemoryMb: 8192 }, row), {
    displayName: null, slotMode: 'dynamic', manualSlots: 1, slotCpu: 8, slotMemoryMb: 8192, disabled: false,
  });
  assert.throws(() => parseNodeSettings({ manualSlots: null }, row));
  assert.throws(() => parseNodeSettings({ slotCpu: 4, HostConfig: { Privileged: true } }, row));
  assert.doesNotThrow(() => assertProfileFitsNode(row, { cpu: 4, memory_mb: 4096 }));
  assert.throws(() => assertProfileFitsNode(row, { cpu: 5, memory_mb: 4096 }));
});

test('new agent applies policy by ACK and stale heartbeat cannot overwrite slots; old agent stays compatible', async () => {
  const db = new PGlite();
  try {
    for (const version of ['001_init', '005_host_settings', '011_node_management']) {
      await db.exec(await readFile(new URL(`../migrations/${version}.sql`, import.meta.url), 'utf8'));
    }
    const client = { query: db.query.bind(db), release: () => {} };
    const pool = { connect: async () => client, query: db.query.bind(db) } as unknown as Pool;
    const hub = new AgentHub(pool);
    const receive = hub as unknown as {
      onAgentMessage(ws: WebSocket, hostId: string, message: Record<string, unknown>,
        setLink: (link: unknown) => void): Promise<void>;
    };
    const oldSocket = { readyState: 1, send: () => {}, close: () => {} } as unknown as WebSocket;
    await receive.onAgentMessage(oldSocket, 'old-1', {
      type: 'hello', hostId: 'old-1', name: 'Old', slots: 1, metrics: {}, activeSessions: [],
    }, () => {});
    assert.equal(hub.supportsNodePolicy('old-1'), false);
    await receive.onAgentMessage(oldSocket, 'old-1', {
      type: 'heartbeat', hostId: 'old-1', slots: 2, metrics: {}, activeSessions: [],
    }, () => {});
    assert.equal((await db.query<{ slots: number }>("SELECT slots FROM hosts WHERE id='old-1'")).rows[0]?.slots, 2);

    const newSocket = {
      readyState: 0,
      close: () => {},
      send: (raw: string, done?: (error?: Error) => void) => {
        const message = JSON.parse(raw) as Record<string, unknown>;
        done?.();
        if (message.type === 'command' && message.action === 'set-policy') {
          queueMicrotask(() => { void receive.onAgentMessage(newSocket as unknown as WebSocket, 'new-1', {
            type: 'result', id: message.id, ok: true, data: message.params &&
              (message.params as Record<string, unknown>).policy,
          }, () => {}); });
        }
      },
    } as unknown as WebSocket & { readyState: number };
    await receive.onAgentMessage(newSocket, 'new-1', {
      type: 'hello', hostId: 'new-1', name: 'New', slots: 1, policyVersion: 1,
      policyRevision: 0, metrics: { cpuAllocatableCores: 28, memoryAllocatableMb: 32768 }, activeSessions: [],
    }, () => {});
    await db.query("UPDATE hosts SET manual_slots=3,policy_revision=1 WHERE id='new-1'");
    Object.defineProperty(newSocket, 'readyState', { value: 1, writable: true });
    assert.equal(hub.supportsNodePolicy('new-1'), true);
    await hub.applyHostPolicy('new-1');
    assert.deepEqual((await db.query<{ slots: number; applied_policy_revision: number }>(
      "SELECT slots,applied_policy_revision FROM hosts WHERE id='new-1'")).rows[0],
      { slots: 3, applied_policy_revision: 1 });
    // A failed earlier ACK must be retried even if the agent reports the desired
    // revision and slot count. Only the broker's recorded ACK opens new slots.
    await db.query("UPDATE hosts SET slots=0,applied_policy_revision=-1 WHERE id='new-1'");
    await receive.onAgentMessage(newSocket, 'new-1', {
      type: 'heartbeat', hostId: 'new-1', slots: 3, policyRevision: 1, metrics: {}, activeSessions: [],
    }, () => {});
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.deepEqual((await db.query<{ slots: number; applied_policy_revision: number }>(
      "SELECT slots,applied_policy_revision FROM hosts WHERE id='new-1'")).rows[0],
      { slots: 3, applied_policy_revision: 1 });
    Object.defineProperty(newSocket, 'readyState', { value: 0, writable: true });
    await receive.onAgentMessage(newSocket, 'new-1', {
      type: 'heartbeat', hostId: 'new-1', slots: 1, policyRevision: 0, metrics: {}, activeSessions: [],
    }, () => {});
    assert.equal((await db.query<{ slots: number }>("SELECT slots FROM hosts WHERE id='new-1'")).rows[0]?.slots, 3);
  } finally { await db.close(); }
});
