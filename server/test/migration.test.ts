import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import type { Pool } from 'pg';
import type WebSocket from 'ws';
import { AgentHub } from '../src/agent.js';

test('fresh PostgreSQL schema includes sessions, network state and a published Google profile', async () => {
  const database = new PGlite();
  try {
    const sql = await readFile(new URL('../migrations/001_init.sql', import.meta.url), 'utf8');
    await database.exec(sql);
    await database.exec(await readFile(new URL('../migrations/002_gpu_mode.sql', import.meta.url), 'utf8'));
    await database.exec(await readFile(new URL('../migrations/003_default_profile_resources.sql', import.meta.url), 'utf8'));
    await database.exec(await readFile(new URL('../migrations/004_guest_resources.sql', import.meta.url), 'utf8'));
    await database.exec(await readFile(new URL('../migrations/005_host_settings.sql', import.meta.url), 'utf8'));
    await database.exec(await readFile(new URL('../migrations/006_adb_port_access.sql', import.meta.url), 'utf8'));
    await database.exec(await readFile(new URL('../migrations/007_purge_finished_sessions.sql', import.meta.url), 'utf8'));
    await database.exec(await readFile(new URL('../migrations/008_user_adb_keys.sql', import.meta.url), 'utf8'));
    await database.exec(await readFile(new URL('../migrations/009_uploaded_adb_public_keys.sql', import.meta.url), 'utf8'));
    await database.exec(await readFile(new URL('../migrations/010_user_settings_audit.sql', import.meta.url), 'utf8'));
    await database.exec(await readFile(new URL('../migrations/011_node_management.sql', import.meta.url), 'utf8'));
    const profile = await database.query<{ id: string; image: string; gpu_mode: string; guest_memory_mb: number | null; guest_cores: number | null }>(
      'SELECT id,image,gpu_mode,guest_memory_mb,guest_cores FROM profiles');
    assert.equal(profile.rows.length, 1);
    assert.equal(profile.rows[0]?.id, 'android-30');
    assert.equal(profile.rows[0]?.gpu_mode, 'software');
    assert.equal(profile.rows[0]?.guest_memory_mb, null);
    assert.equal(profile.rows[0]?.guest_cores, null);
    assert.match(profile.rows[0]?.image || '', /android-emulator-268719\/images\/30-google-x64-no-metrics:30\.1\.2/);
    const columns = await database.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name='sessions'`,
    );
    assert.ok(columns.rows.some(row => row.column_name === 'network_enabled'));
    assert.ok(columns.rows.some(row => row.column_name === 'owner_user_id'));
    assert.ok(columns.rows.some(row => row.column_name === 'state'));
    assert.ok(columns.rows.some(row => row.column_name === 'adb_key_id'));
    const hostColumns = await database.query<{ column_name: string }>(
      'SELECT column_name FROM information_schema.columns WHERE table_name=' + "'hosts'",
    );
    assert.ok(hostColumns.rows.some(row => row.column_name === 'display_name'));
    assert.ok(hostColumns.rows.some(row => row.column_name === 'slot_cap'));
    assert.ok(hostColumns.rows.some(row => row.column_name === 'slot_mode'));
    assert.ok(hostColumns.rows.some(row => row.column_name === 'agent_policy_version'));
  } finally {
    await database.close();
  }
});

test('a missing start releases its reserved slot only after the RPC deadline', async () => {
  const database = new PGlite();
  try {
    await database.exec(await readFile(new URL('../migrations/001_init.sql', import.meta.url), 'utf8'));
    await database.exec(await readFile(new URL('../migrations/006_adb_port_access.sql', import.meta.url), 'utf8'));
    const userId = '11111111-1111-4111-8111-111111111111';
    const youngId = '22222222-2222-4222-8222-222222222222';
    const staleId = '33333333-3333-4333-8333-333333333333';
    await database.query(
      `INSERT INTO users(id,provider,subject,username,display_name) VALUES($1,'local','owner','owner','Owner')`, [userId],
    );
    await database.query(`INSERT INTO hosts(id,name,slots) VALUES('host-1','Host',2)`);
    await database.query(
      `INSERT INTO sessions(id,owner_user_id,host_id,profile_id,state,created_at)
       VALUES($1,$3,'host-1','android-30','starting',now()),
             ($2,$3,'host-1','android-30','starting',now() - interval '17 minutes')`,
      [youngId, staleId, userId],
    );
    await database.query(
      `INSERT INTO host_slots(host_id,slot_index,session_id) VALUES('host-1',0,$1),('host-1',1,$2)`,
      [youngId, staleId],
    );
    const client = { query: database.query.bind(database), release: () => {} };
    const pool = { connect: async () => client, query: database.query.bind(database) } as unknown as Pool;
    await database.exec(await readFile(new URL('../migrations/005_host_settings.sql', import.meta.url), 'utf8'));
    await database.exec(await readFile(new URL('../migrations/011_node_management.sql', import.meta.url), 'utf8'));
    const hub = new AgentHub(pool);
    await database.exec("ALTER TABLE sessions ADD COLUMN startup_progress jsonb; ALTER TABLE sessions ADD COLUMN startup_deadline_at timestamptz");
    const releaseStale = hub as unknown as { releaseStaleStartingSession(id: string): Promise<void> };
    await releaseStale.releaseStaleStartingSession(youngId);
    await releaseStale.releaseStaleStartingSession(staleId);
    const result = await database.query<{ id: string; state: string; session_id: string | null }>(
      `SELECT s.id,s.state,h.session_id FROM sessions s JOIN host_slots h ON h.host_id=s.host_id
       AND (h.slot_index=0 AND s.id=$1 OR h.slot_index=1 AND s.id=$2) ORDER BY s.id`,
      [youngId, staleId],
    );
    assert.deepEqual(result.rows.map(row => [row.id, row.state, row.session_id]), [
      [youngId, 'starting', youngId],
    ]);
    const slots = await database.query<{ slot_index: number; session_id: string | null }>(
      "SELECT slot_index,session_id FROM host_slots WHERE host_id='host-1' ORDER BY slot_index",
    );
    assert.deepEqual(slots.rows.map(row => [row.slot_index, row.session_id]), [[0, youngId], [1, null]]);
  } finally {
    await database.close();
  }
});

test('heartbeat recovers a container that appeared after reconnect while start was pending', async () => {
  const database = new PGlite();
  try {
    await database.exec(await readFile(new URL('../migrations/001_init.sql', import.meta.url), 'utf8'));
    const userId = '44444444-4444-4444-8444-444444444444';
    const sessionId = '55555555-5555-4555-8555-555555555555';
    await database.query(
      `INSERT INTO users(id,provider,subject,username,display_name) VALUES($1,'local','owner','owner','Owner')`, [userId],
    );
    await database.query(`INSERT INTO hosts(id,name,slots) VALUES('host-1','Host',1)`);
    await database.query(
      `INSERT INTO sessions(id,owner_user_id,host_id,profile_id,state) VALUES($1,$2,'host-1','android-30','starting')`,
      [sessionId, userId],
    );
    const client = { query: database.query.bind(database), release: () => {} };
    const pool = { connect: async () => client, query: database.query.bind(database) } as unknown as Pool;
    await database.exec(await readFile(new URL('../migrations/005_host_settings.sql', import.meta.url), 'utf8'));
    await database.exec(await readFile(new URL('../migrations/011_node_management.sql', import.meta.url), 'utf8'));
    await database.exec("ALTER TABLE sessions ADD COLUMN startup_progress jsonb; ALTER TABLE sessions ADD COLUMN startup_deadline_at timestamptz");
    const hub = new AgentHub(pool);
    const fakeSocket = { send: () => {}, close: () => {} } as unknown as WebSocket;
    const receive = hub as unknown as {
      onAgentMessage(ws: WebSocket, hostId: string, message: Record<string, unknown>, setLink: () => void): Promise<void>;
    };
    await receive.onAgentMessage(fakeSocket, 'host-1', {
      type: 'hello', hostId: 'host-1', name: 'Host', slots: 1, metrics: {}, activeSessions: [],
    }, () => {});
    await receive.onAgentMessage(fakeSocket, 'host-1', {
      type: 'heartbeat', hostId: 'host-1', slots: 1, metrics: {},
      activeSessions: [{ sessionId, containerId: 'container-1', networkEnabled: false }],
    }, () => {});
    const result = await database.query<{ state: string; container_id: string; network_enabled: boolean }>(
      'SELECT state,container_id,network_enabled FROM sessions WHERE id=$1', [sessionId],
    );
    assert.deepEqual(result.rows[0], { state: 'running', container_id: 'container-1', network_enabled: false });
  } finally {
    await database.close();
  }
});

test('confirmed release deletes session data and frees its slot', async () => {
  const database = new PGlite();
  try {
    await database.exec(await readFile(new URL('../migrations/001_init.sql', import.meta.url), 'utf8'));
    await database.exec(await readFile(new URL('../migrations/006_adb_port_access.sql', import.meta.url), 'utf8'));
    const userId = '66666666-6666-4666-8666-666666666666';
    const sessionId = '77777777-7777-4777-8777-777777777777';
    await database.query(
      "INSERT INTO users(id,provider,subject,username,display_name) VALUES($1,'local','owner','owner','Owner')", [userId],
    );
    await database.query("INSERT INTO hosts(id,name,slots) VALUES('host-1','Host',1)");
    await database.query(
      "INSERT INTO sessions(id,owner_user_id,host_id,profile_id,state) VALUES($1,$2,'host-1','android-30','running')",
      [sessionId, userId],
    );
    await database.query("INSERT INTO host_slots(host_id,slot_index,session_id) VALUES('host-1',0,$1)", [sessionId]);
    await database.query(
      "INSERT INTO adb_access_tokens(token_hash,session_id,owner_user_id,expires_at) VALUES('hash',$1,$2,now() + interval '1 hour')",
      [sessionId, userId],
    );
    await database.query(
      "INSERT INTO adb_port_access(session_id,owner_user_id,port,public_key,fingerprint,expires_at) " +
      "VALUES($1,$2,15555,'public-key',$3,now() + interval '1 hour')",
      [sessionId, userId, 'a'.repeat(64)],
    );
    const client = { query: database.query.bind(database), release: () => {} };
    const pool = { connect: async () => client, query: database.query.bind(database) } as unknown as Pool;
    await database.exec(await readFile(new URL('../migrations/005_host_settings.sql', import.meta.url), 'utf8'));
    await database.exec(await readFile(new URL('../migrations/011_node_management.sql', import.meta.url), 'utf8'));
    const hub = new AgentHub(pool);
    await hub.releaseSession(sessionId);
    const state = await database.query<{ sessions: number; slots: number; tokens: number; ports: number }>(
      "SELECT (SELECT count(*)::integer FROM sessions WHERE id=$1) AS sessions, " +
      "(SELECT count(*)::integer FROM host_slots WHERE session_id=$1) AS slots, " +
      "(SELECT count(*)::integer FROM adb_access_tokens WHERE session_id=$1) AS tokens, " +
      "(SELECT count(*)::integer FROM adb_port_access WHERE session_id=$1) AS ports",
      [sessionId],
    );
    assert.deepEqual(state.rows[0], { sessions: 0, slots: 0, tokens: 0, ports: 0 });
    await hub.releaseSession(sessionId);
  } finally {
    await database.close();
  }
});

test('migration removes finished sessions but preserves a running session', async () => {
  const database = new PGlite();
  try {
    await database.exec(await readFile(new URL('../migrations/001_init.sql', import.meta.url), 'utf8'));
    const userId = '88888888-8888-4888-8888-888888888888';
    const doneId = '99999999-9999-4999-8999-999999999999';
    const activeId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    await database.query(
      "INSERT INTO users(id,provider,subject,username,display_name) VALUES($1,'local','owner','owner','Owner')", [userId],
    );
    await database.query("INSERT INTO hosts(id,name,slots) VALUES('host-1','Host',2)");
    await database.query(
      "INSERT INTO sessions(id,owner_user_id,host_id,profile_id,state) " +
      "VALUES($1,$3,'host-1','android-30','stopped'),($2,$3,'host-1','android-30','running')",
      [doneId, activeId, userId],
    );
    await database.query(
      "INSERT INTO host_slots(host_id,slot_index,session_id) VALUES('host-1',0,$1),('host-1',1,$2)",
      [doneId, activeId],
    );
    await database.exec(await readFile(new URL('../migrations/007_purge_finished_sessions.sql', import.meta.url), 'utf8'));
    const sessions = await database.query<{ id: string }>("SELECT id FROM sessions ORDER BY id");
    assert.deepEqual(sessions.rows.map(row => row.id), [activeId]);
    const slots = await database.query<{ slot_index: number; session_id: string | null }>(
      "SELECT slot_index,session_id FROM host_slots WHERE host_id='host-1' ORDER BY slot_index",
    );
    assert.deepEqual(slots.rows.map(row => [row.slot_index, row.session_id]), [[0, null], [1, activeId]]);
  } finally {
    await database.close();
  }
});

test('node migration preserves existing capacity but new nodes default to one manual slot', async () => {
  const database = new PGlite();
  try {
    await database.exec(await readFile(new URL('../migrations/001_init.sql', import.meta.url), 'utf8'));
    await database.exec(await readFile(new URL('../migrations/005_host_settings.sql', import.meta.url), 'utf8'));
    await database.exec("INSERT INTO hosts(id,name,slots,slot_cap) VALUES('old-1','Old',6,NULL),('old-2','Limited',8,3)");
    await database.exec(await readFile(new URL('../migrations/011_node_management.sql', import.meta.url), 'utf8'));
    await database.exec("INSERT INTO hosts(id,name) VALUES('new-1','New')");
    const { rows } = await database.query<{ id: string; manual_slots: number }>(
      'SELECT id,manual_slots FROM hosts ORDER BY id');
    assert.deepEqual(rows.map(row => [row.id, row.manual_slots]), [
      ['new-1', 1], ['old-1', 6], ['old-2', 3],
    ]);
  } finally { await database.close(); }
});
