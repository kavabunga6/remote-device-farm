import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import type { Pool } from 'pg';
import { migrate } from '../src/db.js';

const DIR = new URL('../migrations/', import.meta.url);
const OWNER = '11111111-1111-4111-8111-111111111111';
const SESSION = '22222222-2222-4222-8222-222222222222';
const QUEUE = '33333333-3333-4333-8333-333333333333';
const PRESET = '44444444-4444-4444-8444-444444444444';
const KEY = '55555555-5555-4555-8555-555555555555';
async function fixture(through: number) {
  const db = new PGlite();
  const query = async (sql: string, values?: unknown[]) => {
    const result = values === undefined ? (await db.exec(sql)).at(-1) : await db.query(sql, values);
    return { ...result, rowCount: result?.rows?.length || result?.affectedRows || 0 };
  };
  const pool = { query, connect: async () => ({ query, release() {} }) } as unknown as Pool;
  await db.exec('CREATE TABLE schema_migrations(version integer PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())');
  for (const file of (await readdir(DIR)).filter(file => /^\d+.*\.sql$/.test(file) && Number(file.slice(0, 3)) <= through).sort()) {
    await db.exec(await readFile(new URL(file, DIR), 'utf8'));
    await db.query('INSERT INTO schema_migrations(version) VALUES($1)', [Number(file.slice(0, 3))]);
  }
  await db.query("INSERT INTO users(id,provider,subject,username,display_name) VALUES($1,'local','qa','qa','QA')", [OWNER]);
  await db.query("INSERT INTO hosts(id,name,slots) VALUES('host','Host',1)");
  await db.query("INSERT INTO sessions(id,owner_user_id,host_id,profile_id,state) VALUES($1,$2,'host','android-30','running')", [SESSION, OWNER]);
  await db.query("INSERT INTO queue_entries(id,user_id,profile_id,expires_at) VALUES($1,$2,'android-30',now()+interval '1 hour')", [QUEUE, OWNER]);
  await db.query("INSERT INTO user_profile_presets(id,owner_user_id,name,profile_id,gpu_mode) VALUES($1,$2,'Saved','android-30','software')", [PRESET, OWNER]);
  return { db, pool };
}

test('main version 30 upgrades storage snapshots and remains idempotent', async () => {
  const { db, pool } = await fixture(30);
  try {
    await db.query('UPDATE sessions SET launch_disk_gb=16,launch_sdcard_gb=2 WHERE id=$1', [SESSION]);
    await db.query('UPDATE queue_entries SET disk_gb=12,sdcard_gb=0 WHERE id=$1', [QUEUE]);
    await db.query('UPDATE user_profile_presets SET disk_gb=12,sdcard_gb=2 WHERE id=$1', [PRESET]);
    await migrate(pool); await migrate(pool);
    assert.deepEqual((await db.query('SELECT launch_options FROM sessions WHERE id=$1', [SESSION])).rows[0]?.launch_options, { diskGb: 16, sdCardMb: 2048 });
    assert.deepEqual((await db.query('SELECT launch_options FROM queue_entries WHERE id=$1', [QUEUE])).rows[0]?.launch_options, { diskGb: 12, sdCardMb: 0 });
    assert.equal((await db.query("SELECT to_regclass('user_profile_presets') AS presets")).rows[0]?.presets, null);
    assert.deepEqual((await db.query('SELECT allow_launch_overrides FROM launch_settings')).rows, [{ allow_launch_overrides: false }]);
  } finally { await db.close(); }
});

test('legacy catalog 27 and lease/queue/options 29–31 upgrade without losing selections or lease state', async () => {
  const { db, pool } = await fixture(26);
  try {
    await db.exec(await readFile(new URL('031_client_leases.sql', DIR), 'utf8'));
    await db.exec(await readFile(new URL('032_queue_integration.sql', DIR), 'utf8'));
    for (const table of ['sessions', 'queue_entries', 'user_profile_presets']) await db.exec(`ALTER TABLE ${table} ADD COLUMN launch_options jsonb NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(launch_options)='object')`);
    await db.exec(`ALTER TABLE user_profile_presets DROP CONSTRAINT user_profile_presets_owner_user_id_profile_id_gpu_mode_key;
      CREATE UNIQUE INDEX user_profile_presets_launch_variant ON user_profile_presets(owner_user_id,profile_id,gpu_mode,launch_options);
      INSERT INTO schema_migrations(version,applied_at) VALUES(27,'2026-10-01T00:00:00Z'),(28,'2026-10-01T00:00:00Z'),(29,'2026-10-02T00:00:00Z'),(30,'2026-10-03T00:00:00Z'),(31,'2026-10-04T00:00:00Z')`);
    const choice = { diskGb: 24, sdCardMb: 129, emulatorParams: '-verbose' };
    await db.query("UPDATE sessions SET launch_options=$2,lease_ttl_seconds=120,lease_expires_at=now()+interval '2 minutes' WHERE id=$1", [SESSION, choice]);
    await db.query("UPDATE queue_entries SET launch_options=$2,adb_key_id=$3,request_key='old-build',request_fingerprint='same',lease_ttl_seconds=120 WHERE id=$1", [QUEUE, choice, KEY]);
    await db.query('UPDATE user_profile_presets SET launch_options=$2 WHERE id=$1', [PRESET, choice]);
    const oldLease = (await db.query('SELECT lease_expires_at FROM sessions WHERE id=$1', [SESSION])).rows[0]?.lease_expires_at;
    await migrate(pool); await migrate(pool);
    for (const table of ['sessions', 'queue_entries']) assert.deepEqual((await db.query(`SELECT launch_options FROM ${table}`)).rows[0]?.launch_options, choice);
    const queue = (await db.query('SELECT * FROM queue_entries WHERE id=$1', [QUEUE])).rows[0]!;
    assert.equal(queue.adb_key_id, KEY); assert.equal(queue.request_key, 'old-build'); assert.equal(queue.request_fingerprint, 'same');
    assert.equal(Number(queue.sdcard_gb), 129 / 1024); assert.equal(queue.disk_gb, 24);
    const session = (await db.query('SELECT * FROM sessions WHERE id=$1', [SESSION])).rows[0]!;
    assert.deepEqual(session.lease_expires_at, oldLease); assert.equal(session.lease_ttl_seconds, 120);
    assert.equal(Number(session.launch_sdcard_gb), 129 / 1024);
    const profile = (await db.query("SELECT * FROM profiles WHERE id='android-30'")).rows[0]!;
    assert.equal('image_status' in profile, false); assert.deepEqual(profile.container_env, {});
    const versions = (await db.query('SELECT version,applied_at FROM schema_migrations WHERE version>=27 ORDER BY version')).rows;
    assert.deepEqual(versions.map(row => row.version), [27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51]);
    assert.equal(new Date(String(versions.find(row => row.version === 31)?.applied_at)).toISOString(), '2026-10-02T00:00:00.000Z');
    assert.equal(new Date(String(versions.find(row => row.version === 32)?.applied_at)).toISOString(), '2026-10-03T00:00:00.000Z');
  } finally { await db.close(); }
});


test('incomplete legacy schema leaves data and migration bookkeeping untouched', async () => {
  const { db, pool } = await fixture(26);
  try {
    await db.exec("ALTER TABLE sessions ADD COLUMN lease_ttl_seconds integer; INSERT INTO schema_migrations(version) VALUES(27),(28),(29)");
    const before = (await db.query('SELECT * FROM schema_migrations ORDER BY version')).rows;
    await assert.rejects(migrate(pool), /Incomplete legacy development schema/);
    assert.deepEqual((await db.query('SELECT * FROM schema_migrations ORDER BY version')).rows, before);
    assert.equal((await db.query('SELECT id FROM sessions WHERE id=$1', [SESSION])).rows.length, 1);
    assert.equal((await db.query("SELECT column_name FROM information_schema.columns WHERE table_name='profiles' AND column_name='container_env'")).rows.length, 0);
  } finally { await db.close(); }
});


test('registered diagnostic migration upgrades existing service logs and remains idempotent', async () => {
  const { db, pool } = await fixture(30);
  try {
    await db.query("INSERT INTO service_logs(service,severity,code,host_id,session_id) VALUES('agent','info','session.starting','host',$1)", [SESSION]);
    await migrate(pool); await migrate(pool);
    assert.equal((await db.query('SELECT max(version) AS version FROM schema_migrations')).rows[0]?.version, 51);
    assert.equal((await db.query("SELECT message FROM service_logs WHERE code='session.starting'")).rows[0]?.message, '');
    await db.query("INSERT INTO service_logs(service,severity,code,host_id,session_id,message) VALUES('emulator','error','container.stderr','host',$1,$2)", [SESSION, 'Vulkan initialization failed']);
    await db.query('DELETE FROM sessions WHERE id=$1', [SESSION]);
    assert.equal((await db.query("SELECT message FROM service_logs WHERE code='container.stderr'")).rows[0]?.message, 'Vulkan initialization failed');
    assert.ok((await db.query("SELECT to_regclass('service_logs_session_idx') AS idx")).rows[0]?.idx);
    await assert.rejects(db.query("UPDATE service_logs SET message=$1 WHERE code='container.stderr'", ['x'.repeat(4097)]));
  } finally { await db.close(); }
});
