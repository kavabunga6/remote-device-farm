import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import type { Pool } from 'pg';
import { AgentHub } from '../src/agent.js';

const MIGRATIONS = ['001_init', '005_host_settings', '006_adb_port_access', '008_user_adb_keys', '009_uploaded_adb_public_keys', '010_user_settings_audit', '011_node_management', '012_session_lifecycle',
  '013_queue_notifications', '024_device_quarantine'];

test('a device-alert is audited, every admin is notified once, and the agent gets an ack', async () => {
  const db = new PGlite();
  try {
    for (const file of MIGRATIONS) await db.exec(await readFile(new URL(`../migrations/${file}.sql`, import.meta.url), 'utf8'));
    await db.query("INSERT INTO users(id,provider,subject,username,display_name,role) VALUES " +
      "('11111111-1111-4111-8111-111111111111','local','a','a','a','admin'),('22222222-2222-4222-8222-222222222222','local','u','u','u','user')");
    const hub = new AgentHub({ query: db.query.bind(db) } as unknown as Pool) as unknown as {
      onDeviceAlert(ws: unknown, hostId: string, message: Record<string, unknown>): Promise<void>;
    };
    const sent: string[] = [];
    const ws = { readyState: 1, send: (data: string) => sent.push(data) };
    const alert = { id: 'quarantine:usb-android:R58:1', kind: 'usb-android', deviceId: 'R58M123ABC', reason: 'wipe failed' };
    await hub.onDeviceAlert(ws, 'h1', alert);
    await hub.onDeviceAlert(ws, 'h1', alert); // re-send after a reconnect: acked again, not notified twice
    await hub.onDeviceAlert(ws, 'h1', { ...alert, id: '../bad', deviceId: '' }); // malformed: ignored
    const notices = (await db.query("SELECT user_id,kind,body FROM notifications")).rows as { user_id: string; kind: string; body: string }[];
    assert.equal(notices.length, 1);
    assert.equal(notices[0]!.user_id, '11111111-1111-4111-8111-111111111111');
    assert.equal(notices[0]!.kind, 'device.quarantined');
    assert.match(notices[0]!.body, /wipe failed/);
    assert.equal((await db.query("SELECT 1 FROM audit_events WHERE action='device.quarantined'")).rows.length, 1);
    assert.deepEqual(sent.map(s => JSON.parse(s)), [{ type: 'alert-ack', id: alert.id }, { type: 'alert-ack', id: alert.id }]);
  } finally { await db.close(); }
});
