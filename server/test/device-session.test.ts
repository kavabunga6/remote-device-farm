import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import type { ServerContext } from '../src/server-context.js';
import { ApiError } from '../src/http-common.js';
import { createDeviceSession } from '../src/device-session.js';
import { testPool } from './support/api-fixture.js';

const U1 = '11111111-1111-4111-8111-111111111111';
const U2 = '22222222-2222-4222-8222-222222222222';

async function setup(devices: unknown[]) {
  const db = new PGlite();
  for (const file of (await readdir(new URL('../migrations/', import.meta.url))).filter(f => f.endsWith('.sql')).sort()) {
    await db.exec(await readFile(new URL(`../migrations/${file}`, import.meta.url), 'utf8'));
  }
  for (const [id, name] of [[U1, 'one'], [U2, 'two']]) {
    await db.query("INSERT INTO users(id,provider,subject,username,display_name) VALUES($1,'local',$2,$2,$2)", [id, name]);
  }
  await db.query("INSERT INTO hosts(id,name,slots,status,last_seen_at,devices,provider_capabilities) VALUES('h1','H1',1,'online',now(),$1,$2)",
    [JSON.stringify(devices), JSON.stringify({ 'usb-android': ['video', 'touch', 'shell'] })]);
  const commands: Array<{ hostId: string; sessionId: string; action: string; params: unknown }> = [];
  const pool = testPool(db);
  const context = {
    pool,
    config: { maxSessionsPerUser: 0 },
    hub: {
      hasAgent: () => true, refreshStream() {},
      command: async (hostId: string, sessionId: string, action: string, params: unknown) => { commands.push({ hostId, sessionId, action, params }); return {}; },
    },
  } as unknown as Pick<ServerContext, 'pool' | 'hub' | 'config'>;
  return { db, pool, context, commands };
}

test('renting a free USB phone stores device, capability snapshot and sends a lease to the agent', async () => {
  const { db, pool, context, commands } = await setup([{ kind: 'usb-android', id: 'R58M', state: 'free' }]);
  try {
    const id = await createDeviceSession(context, { id: U1, role: 'user' }, { hostId: 'h1', kind: 'usb-android', deviceId: 'R58M' });
    for (let attempt = 0; attempt < 100; attempt++) {
      const ready = await pool.query("SELECT 1 FROM service_logs WHERE session_id=$1 AND code='session.running'", [id]);
      if (ready.rows.length) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const row = (await pool.query('SELECT device_kind,device_id,capabilities,profile_id FROM sessions WHERE id=$1', [id])).rows[0] as Record<string, unknown>;
    assert.deepEqual(row, { device_kind: 'usb-android', device_id: 'R58M', capabilities: ['video', 'touch', 'shell'], profile_id: 'device-usb-android' });
    assert.deepEqual(commands[0], { hostId: 'h1', sessionId: id, action: 'start', params: { kind: 'usb-android', deviceSerial: 'R58M' } });
    await assert.rejects(createDeviceSession(context, { id: U2, role: 'user' }, { hostId: 'h1', kind: 'usb-android', deviceId: 'R58M' }),
      (e: unknown) => e instanceof ApiError && e.status === 409);
  } finally { await pool.end(); }
});

test('quarantined, cleaning or unknown devices cannot be rented', async () => {
  const { db, pool, context } = await setup([{ kind: 'usb-android', id: 'Q', state: 'quarantined' }, { kind: 'usb-android', id: 'C', state: 'cleaning' }]);
  try {
    for (const deviceId of ['Q', 'C']) {
      await assert.rejects(createDeviceSession(context, { id: U1, role: 'user' }, { hostId: 'h1', kind: 'usb-android', deviceId }),
        (e: unknown) => e instanceof ApiError && e.status === 409);
    }
    await assert.rejects(createDeviceSession(context, { id: U1, role: 'user' }, { hostId: 'h1', kind: 'usb-android', deviceId: 'nope' }),
      (e: unknown) => e instanceof ApiError && e.status === 404);
    assert.equal((await db.query('SELECT 1 FROM sessions')).rows.length, 0);
  } finally { await pool.end(); }
});
