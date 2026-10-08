import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import type { Pool } from 'pg';
import type WebSocket from 'ws';
import { AgentHub } from '../src/agent.js';
import { hostJson } from '../src/http-common.js';
import { cleanPhysicalDevices } from '../src/physical-devices.js';

const phone = { kind: 'usb-android' as const, platform: 'android' as const, id: 'R58M123ABC',
  model: 'SM_A525F', state: 'free', reason: null };
const legacySlots = { kind: 'emulator', platform: 'android', id: 'slots', model: null, state: null, reason: null };

test('host API hides legacy capacity records without changing physical device state or reasons', () => {
  const devices = [legacySlots, phone, { ...phone, id: 'Q1', state: 'quarantined', reason: 'Wipe failed' },
    { ...phone, id: 'C1', state: 'cleaning' }, { ...phone, id: 'B1', state: 'busy' }];
  const mapped = hostJson({ id: 'node', name: 'Node', slots: 4, devices });
  assert.deepEqual(mapped.devices, devices.slice(1));
  assert.equal(mapped.slots, 4);
  assert.equal(devices[0], legacySlots); // Rendering does not mutate the stored snapshot.
});

test('malformed inventory cannot masquerade as a phone or an available device', () => {
  assert.deepEqual(cleanPhysicalDevices([null, [], 'slots', { id: 'slots' }, { kind: 'emulator', id: 'slots' },
    { kind: 'usb-android', id: '' }, { kind: 'usb-android', id: '   ' }, { kind: 'usb-android', id: 123 },
    { ...phone, id: 'x'.repeat(101) }, { ...phone, id: 'phone\nother' }, { kind: 'usb-android', id: 'unverified-phone' }]),
  [{ kind: 'usb-android', platform: 'android', id: 'unverified-phone', model: null, state: 'unverified', reason: null }]);
  assert.deepEqual(cleanPhysicalDevices({ devices: [phone] }), []);
});

test('agent hello and heartbeat store USB inventory, retain emulator capacity and clear disconnected phones', async () => {
  const db = new PGlite();
  try {
    for (const file of (await readdir(new URL('../migrations/', import.meta.url))).filter(file => file.endsWith('.sql')).sort()) {
      await db.exec(await readFile(new URL('../migrations/' + file, import.meta.url), 'utf8'));
    }
    const client = { query: db.query.bind(db), release: () => {} };
    const hub = new AgentHub({ connect: async () => client, query: db.query.bind(db) } as unknown as Pool);
    const receive = hub as unknown as { onAgentMessage(ws: WebSocket, hostId: string, message: Record<string, unknown>, setLink: (link: unknown) => void): Promise<void> };
    const socket = { readyState: 1, send: () => {}, close: () => assert.fail('Valid heartbeat was rejected') } as unknown as WebSocket;
    // Old agents report a synthetic capacity record alongside actual USB devices.
    const emulator = { kind: 'emulator', platform: 'android', capabilities: ['video', 'env'], devices: [{ id: 'slots', free: 3, total: 4 }] };
    const usb = { kind: 'usb-android', platform: 'android', capabilities: ['video', 'touch'], devices: [phone] };
    await receive.onAgentMessage(socket, 'inventory-node', { type: 'hello', hostId: 'inventory-node', slots: 4,
      metrics: {}, activeSessions: [], providers: [emulator, usb] }, () => {});
    const row = (await db.query<Record<string, unknown>>("SELECT * FROM hosts WHERE id='inventory-node'")).rows[0]!;
    assert.deepEqual(row.devices, [phone]);
    assert.deepEqual(row.provider_capabilities, { emulator: ['video', 'env'], 'usb-android': ['video', 'touch'] });
    assert.equal(hostJson(row).reportedSlots, 4);
    assert.equal((await db.query("SELECT * FROM host_slots WHERE host_id='inventory-node'")).rows.length, 4);

    // A legacy snapshot is repaired by the next heartbeat; rendering already masks it before then.
    await db.query("UPDATE hosts SET devices=$1 WHERE id='inventory-node'", [JSON.stringify([legacySlots, phone])]);
    const quarantined = { ...phone, state: 'quarantined', reason: 'Wipe failed' };
    await receive.onAgentMessage(socket, 'inventory-node', { type: 'heartbeat', hostId: 'inventory-node', slots: 4,
      metrics: {}, activeSessions: [], providers: [emulator, { ...usb, devices: [quarantined] }] }, () => {});
    const next = (await db.query<Record<string, unknown>>("SELECT * FROM hosts WHERE id='inventory-node'")).rows[0]!;
    assert.deepEqual(next.devices, [quarantined]);
    assert.deepEqual(hostJson(next).devices, [quarantined]);

    await receive.onAgentMessage(socket, 'inventory-node', { type: 'heartbeat', hostId: 'inventory-node', slots: 4,
      metrics: {}, activeSessions: [], providers: [emulator, { ...usb, devices: [] }] }, () => {});
    const detached = (await db.query<Record<string, unknown>>("SELECT * FROM hosts WHERE id='inventory-node'")).rows[0]!;
    assert.deepEqual(detached.devices, []);
    assert.equal(hostJson(detached).reportedSlots, 4);
  } finally { await db.close(); }
});
