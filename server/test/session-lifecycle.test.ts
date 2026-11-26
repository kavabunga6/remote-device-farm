import { testPool } from './support/api-fixture.js';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import express from 'express';
import { PGlite } from '@electric-sql/pglite';
import type { Config } from '../src/config.js';
import { loadConfig } from '../src/config.js';
import type { AuthService } from '../src/auth.js';
import { AgentHub } from '../src/agent.js';
import { ApiError } from '../src/http-common.js';
import { initializeSessionLease, parseLeaseTtlSeconds, renewSessionLease } from '../src/session-lease.js';
import { createServerContext } from '../src/server-context.js';
import { registerSessionRoutes } from '../src/routes/session-routes.js';
import { ActivityTracker, findExpiredSessions, releaseExpired, sessionDeadlines } from '../src/session-lifecycle.js';

const MIGRATIONS = ['001_init', '002_gpu_mode', '003_default_profile_resources', '004_guest_resources', '005_host_settings',
  '006_adb_port_access', '008_user_adb_keys', '009_uploaded_adb_public_keys', '010_user_settings_audit', '011_node_management',
  '012_session_lifecycle', '013_queue_notifications', '014_session_sharing', '018_teams', '021_profile_gpu_variants', '022_profile_gpu_memory', '026_session_startup_progress', '029_storage_limits', '038_profile_secrets_docker_options', '025_physical_devices', '031_client_leases', '023_user_profile_presets', '030_preset_storage', '033_launch_options', '040_emulator_image_registry', '046_session_diagnostics', '048_user_removal', '049_access_roles', '052_session_device_metadata', '053_device_provider_status'];
const TIMEOUT_REASON_MIGRATION = '057_rental_timeout_reason';

async function migrate(db: PGlite, file: string): Promise<void> {
  await db.exec(await readFile(new URL(`../migrations/${file}.sql`, import.meta.url), 'utf8'));
}

async function database(migrations = [...MIGRATIONS, TIMEOUT_REASON_MIGRATION]): Promise<PGlite> {
  const db = new PGlite();
  for (const file of migrations) await migrate(db, file);
  return db;
}

const OWNER = '11111111-1111-4111-8111-111111111111';
const MEMBER = '22222222-2222-4222-8222-222222222222';
const ADMIN = '44444444-4444-4444-8444-444444444444';

test('deadlines follow the policy and disappear when it is off', () => {
  const session = { state: 'running', createdAt: '2026-10-02T10:00:00.000Z', lastActivityAt: '2026-10-02T10:30:00.000Z' };
  assert.deepEqual(sessionDeadlines(session, { idleMinutes: 60, maxHours: 8 }), {
    idleExpiresAt: '2026-10-02T11:30:00.000Z', expiresAt: '2026-10-02T18:00:00.000Z',
  });
  assert.deepEqual(sessionDeadlines(session, { idleMinutes: 0, maxHours: 0 }), { idleExpiresAt: null, expiresAt: null });
  assert.deepEqual(sessionDeadlines({ ...session, state: 'stopping' }, { idleMinutes: 60, maxHours: 8 }), { idleExpiresAt: null, expiresAt: null });
});

test('activity writes are throttled but a keep-alive always lands', async () => {
  const writes: string[] = [];
  const tracker = new ActivityTracker({ query: async (_sql: string, values?: unknown[]) => { writes.push(String(values?.[0])); return { rows: [] }; } } as never, 30_000);
  tracker.touch('a', 0);
  tracker.touch('a', 10_000);
  tracker.touch('b', 10_000);
  tracker.touch('a', 31_000);
  await tracker.force('a');
  assert.deepEqual(writes, ['a', 'b', 'a', 'a']);
});

test('the reaper respects ADB activity and rechecks idle and lifetime deadlines before stopping', async () => {
  const db = await database();
  try {
    await db.query("INSERT INTO users(id,provider,subject,username,display_name) VALUES($1,'local','owner','owner','Owner')", [OWNER]);
    await db.query("INSERT INTO hosts(id,name,slots) VALUES('host-1','Host',3)");
    const ids = ['a0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000003', 'a0000000-0000-4000-8000-000000000004'];
    await db.query("INSERT INTO sessions(id,owner_user_id,host_id,profile_id,state,last_activity_at) VALUES($1,$5,'host-1','android-30','running',now() - interval '90 minutes')," +
      "($2,$5,'host-1','android-30','running',now() - interval '5 minutes')," +
      "($3,$5,'host-1','android-30','running',now() - interval '90 minutes')," +
      "($4,$5,'host-1','android-30','stopping',now() - interval '90 minutes')", [...ids, OWNER]);
    await db.query("UPDATE sessions SET created_at=now() - interval '30 hours' WHERE id=$1", [ids[1]]);
    const pool = testPool(db);
    const policy = { idleMinutes: 60, maxHours: 24 };
    const found = await findExpiredSessions(pool, policy, id => id === ids[2]);
    assert.deepEqual(found.map(item => [item.id, item.reason]).sort(), [[ids[0], 'idle'], [ids[1], 'max_lifetime']].sort());
    assert.deepEqual(await findExpiredSessions(pool, { idleMinutes: 0, maxHours: 0 }, () => false), []);

    await new ActivityTracker(pool).force(ids[0]);
    const shouldStayRunning = { command: async () => { assert.fail('no stop is due'); } } as unknown as AgentHub;
    assert.equal(await releaseExpired(pool, shouldStayRunning, found.find(item => item.id === ids[0])!, policy), false);
    assert.equal(await releaseExpired(pool, shouldStayRunning, found.find(item => item.id === ids[1])!, { ...policy, maxHours: 48 }), false);
    const { rows } = await db.query(`SELECT s.state,r.timeout_reason FROM sessions s JOIN rental_history r ON r.session_id=s.id
      WHERE s.id IN ($1,$2) ORDER BY s.id`, ids.slice(0, 2));
    assert.deepEqual(rows, [{ state: 'running', timeout_reason: null }, { state: 'running', timeout_reason: null }]);
  } finally { await db.close(); }
});

test('limits, keep-alive and labels work through the session API', async () => {
  const db = await database();
  let actor = OWNER;
  let server: ReturnType<typeof createServer> | null = null;
  try {
    await db.query("INSERT INTO users(id,provider,subject,username,display_name) VALUES($1,'local','owner','owner','Owner')", [OWNER]);
    await db.query("INSERT INTO users(id,provider,subject,username,display_name,role) VALUES($1,'local','root','root','Root','admin')", [ADMIN]);
    await db.query("INSERT INTO hosts(id,name,slots,status,manual_slots,last_seen_at) VALUES('host-1','Host',4,'online',4,now())");
    await db.query("UPDATE hosts SET slot_cpu=8,slot_memory_mb=32768 WHERE id='host-1'");
    await db.query("INSERT INTO host_slots(host_id,slot_index) VALUES('host-1',0),('host-1',1),('host-1',2),('host-1',3)");
    const pool = testPool(db);
    const auth = { authenticate: async () => ({ user: actor === ADMIN
      ? { id: ADMIN, username: 'root', displayName: 'Root', role: 'admin', provider: 'local' }
      : { id: OWNER, username: 'owner', displayName: 'Owner', role: 'user', provider: 'local' }, via: 'cookie' }) } as unknown as AuthService;
    const hub = { hasAgent: () => true, command: async () => ({ containerId: 'c' }), refreshStream: () => {} } as unknown as AgentHub;
    const config = { maxSessionsPerUser: 1, idleTimeoutMinutes: 60, maxSessionHours: 0 } as Config;
    const context = createServerContext(pool, config, auth, undefined, hub);
    const app = express();
    app.use(express.json());
    registerSessionRoutes(app, context);
    app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      if (error instanceof ApiError) res.status(error.status).json({ error: { code: error.code, message: error.message } });
      else { console.error(error); res.status(500).json({ error: { code: 'internal_error' } }); }
    });
    server = createServer(app);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const base = 'http://127.0.0.1:' + address.port;
    const send = (path: string, method: string, body?: unknown) => fetch(base + path, {
      method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
    });
    const create = () => send('/api/sessions', 'POST', { hostId: 'host-1', profileId: 'android-30', leaseTtlSeconds: 120 });
    assert.equal((await send('/api/sessions', 'POST', { hostId: 'host-1', profileId: 'android-30', leaseTtlSeconds: 0 })).status, 400);

    const first = await create();
    assert.equal(first.status, 202, JSON.stringify(await first.clone().json()));
    const created = await first.json() as { session: { id: string; idleExpiresAt: string | null; leaseTtlSeconds: number; leaseExpiresAt: string } };
    assert.ok(created.session.idleExpiresAt, 'the idle deadline is reported');
    assert.equal(created.session.leaseTtlSeconds, 120);
    assert.ok(new Date(created.session.leaseExpiresAt).getTime() > Date.now());

    const second = await create();
    assert.equal(second.status, 409);
    assert.equal(((await second.json()) as { error: { code: string } }).error.code, 'session_limit');

    actor = ADMIN;
    const adminCreate = await create();
    assert.equal(adminCreate.status, 202, 'administrators are not limited: ' + JSON.stringify(await adminCreate.clone().json()));
    actor = OWNER;

    const id = created.session.id;
    await context.pool.query("UPDATE sessions SET last_activity_at=now() - interval '50 minutes' WHERE id=$1", [id]);
    const kept = await (await send(`/api/sessions/${id}/keepalive`, 'POST')).json() as { session: { lastActivityAt: string } };
    assert.ok(Date.now() - new Date(kept.session.lastActivityAt).getTime() < 60_000);

    const renamed = await (await send(`/api/sessions/${id}`, 'PATCH', { label: '  баг-1423\n' })).json() as { session: { label: string } };
    assert.equal(renamed.session.label, 'баг-1423');
    assert.equal((await send(`/api/sessions/${id}`, 'PATCH', { label: 5 })).status, 400);
    const cleared = await (await send(`/api/sessions/${id}`, 'PATCH', { label: null })).json() as { session: { label: string | null } };
    assert.equal(cleared.session.label, null);

    actor = ADMIN;
    assert.equal((await send(`/api/sessions/${id}`, 'PATCH', { label: 'x' })).status, 403, 'only the owner can rename');
    assert.equal((await send(`/api/sessions/${id}/keepalive`, 'POST')).status, 403, 'only the owner can extend');
    actor = OWNER;
    await context.pool.query("UPDATE sessions SET lease_expires_at=now()-interval '1 second' WHERE id=$1", [id]);
    const expired = await send(`/api/sessions/${id}/keepalive`, 'POST');
    assert.equal(expired.status, 409);
    assert.equal((await expired.json() as { error: { code: string } }).error.code, 'session_lease_expired');
  } finally {
    if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
    await db.close();
  }
});

test('lifecycle settings are validated', () => {
  const base = { DATABASE_URL: 'postgres://x', AGENT_TOKEN: 'a'.repeat(32), BOOTSTRAP_AGENT_ID: 'agent-1',
    LOCAL_ADMIN_USERNAME: 'admin', LOCAL_ADMIN_PASSWORD: 'p'.repeat(12) };
  const defaults = loadConfig(base);
  assert.deepEqual([defaults.maxSessionsPerUser, defaults.idleTimeoutMinutes, defaults.maxSessionHours], [3, 0, 0]);
  const custom = loadConfig({ ...base, MAX_SESSIONS_PER_USER: '2', IDLE_TIMEOUT_MINUTES: '60', MAX_SESSION_HOURS: '12', TRUST_PROXY: '1' });
  assert.deepEqual([custom.maxSessionsPerUser, custom.idleTimeoutMinutes, custom.maxSessionHours, custom.trustProxy], [2, 60, 12, 1]);
  assert.throws(() => loadConfig({ ...base, IDLE_TIMEOUT_MINUTES: '-5' }));
  assert.throws(() => loadConfig({ ...base, TRUST_PROXY: 'yes' }));
});


test('lease TTL accepts only bounded integer seconds', () => {
  assert.equal(parseLeaseTtlSeconds(undefined), undefined);
  for (const value of [30, 120, 3600]) assert.equal(parseLeaseTtlSeconds(value), value);
  for (const value of [null, '120', 0, 29, 3601, 60.5, NaN, Infinity]) {
    assert.throws(() => parseLeaseTtlSeconds(value), (error: unknown) => error instanceof ApiError && error.code === 'invalid_lease_ttl');
  }
});

test('leases reclaim abandoned startup and running sessions, survive renewal races, and retain unconfirmed slots', async () => {
  const db = await database();
  try {
    await db.query("INSERT INTO users(id,provider,subject,username,display_name) VALUES($1,'local','owner','owner','Owner')", [OWNER]);
    await db.query("INSERT INTO hosts(id,name,slots) VALUES('host-1','Host',3)");
    const starting = 'b0000000-0000-4000-8000-000000000001';
    const running = 'b0000000-0000-4000-8000-000000000002';
    const ordinary = 'b0000000-0000-4000-8000-000000000003';
    for (const [index, id] of [starting, running, ordinary].entries()) {
      await db.query("INSERT INTO sessions(id,owner_user_id,host_id,profile_id,state) VALUES($1,$2,'host-1','android-30',$3)", [id, OWNER, index === 0 ? 'starting' : 'running']);
      await db.query("INSERT INTO host_slots(host_id,slot_index,session_id) VALUES('host-1',$1,$2)", [index, id]);
    }
    const pool = testPool(db);
    const policy = { idleMinutes: 0, maxHours: 0 };
    await initializeSessionLease(pool, starting, 120);
    await initializeSessionLease(pool, running, 120);
    await initializeSessionLease(pool, ordinary, undefined);
    await db.query("UPDATE sessions SET lease_expires_at=now()+interval '5 seconds' WHERE id=$1", [running]);
    await renewSessionLease(pool, running);
    const renewed = await db.query<{ remaining: number }>("SELECT extract(epoch FROM lease_expires_at-now()) AS remaining FROM sessions WHERE id=$1", [running]);
    assert.ok(Number(renewed.rows[0]?.remaining) > 100);
    await db.query("UPDATE sessions SET lease_expires_at=now()-interval '1 second' WHERE lease_ttl_seconds IS NOT NULL");
    const found = await findExpiredSessions(pool, policy, () => true);
    assert.deepEqual(found.map(item => [item.id, item.reason]).sort(), [[starting, 'lease_expired'], [running, 'lease_expired']]);
    await assert.rejects(() => renewSessionLease(pool, starting), (e: unknown) => e instanceof ApiError && e.code === 'session_lease_expired');

    const commands: string[] = [];
    const hub = {
      command: async (_host: string, _id: string, command: string) => { commands.push(command); },
      releaseSession: async (id: string) => {
        await db.query('UPDATE host_slots SET session_id=NULL WHERE session_id=$1', [id]);
        await db.query('DELETE FROM sessions WHERE id=$1', [id]);
      },
    } as unknown as AgentHub;
    await db.query("UPDATE sessions SET lease_expires_at=now()+interval '120 seconds' WHERE id=$1", [running]);
    assert.equal(await releaseExpired(pool, hub, found.find(item => item.id === running)!, policy), false);
    assert.deepEqual(commands, []);
    assert.equal(await releaseExpired(pool, hub, found.find(item => item.id === starting)!, policy), true);
    assert.deepEqual(commands, ['kill']);
    assert.equal((await db.query('SELECT id FROM sessions WHERE id=$1', [starting])).rows.length, 0);
    assert.equal((await db.query('SELECT session_id FROM host_slots WHERE slot_index=0')).rows[0]?.session_id, null);

    await db.query("UPDATE sessions SET lease_expires_at=now()-interval '1 second' WHERE id=$1", [running]);
    const offlineHub = { command: async () => { throw new Error('agent offline'); }, releaseSession: async () => { assert.fail('unconfirmed device must remain reserved'); } } as unknown as AgentHub;
    assert.equal(await releaseExpired(pool, offlineHub, found.find(item => item.id === running)!, policy), false);
    assert.equal((await db.query('SELECT state FROM sessions WHERE id=$1', [running])).rows[0]?.state, 'stopping');
    assert.equal((await db.query('SELECT session_id FROM host_slots WHERE slot_index=1')).rows[0]?.session_id, running);
    await assert.rejects(() => renewSessionLease(pool, running));
    assert.deepEqual(await findExpiredSessions(pool, policy, () => false), []);
  } finally { await db.close(); }
});

test('migration 057 backfills only ended rentals with a recognized session timeout audit', async () => {
  const db = await database(MIGRATIONS);
  try {
    await db.query("INSERT INTO users(id,provider,subject,username,display_name) VALUES($1,'local','owner','owner','Owner')", [OWNER]);
    await db.query("INSERT INTO hosts(id,name,slots) VALUES('host-1','Host',1)");
    const cases = [
      { action: 'session.released_idle', reason: 'idle' },
      { action: 'session.released_expired', reason: 'max_lifetime' },
      { action: 'session.released_lease', reason: 'lease_expired' },
      { reason: null },
      { action: 'session.released_unknown', reason: null },
      { action: 'session.released_idle', targetType: 'host', reason: null },
      { action: 'session.released_idle', active: true, reason: null },
    ];
    const expected = [];
    for (const [index, { action, targetType, active, reason }] of cases.entries()) {
      const id = `d0000000-0000-4000-8000-00000000000${index + 1}`;
      await db.query("INSERT INTO sessions(id,owner_user_id,host_id,profile_id,state) VALUES($1,$2,'host-1','android-30','running')", [id, OWNER]);
      if (!active) await db.query('DELETE FROM sessions WHERE id=$1', [id]);
      if (action) await db.query('INSERT INTO audit_events(action,target_type,target_id) VALUES($1,$2,$3)', [action, targetType ?? 'session', id]);
      expected.push({ session_id: id, timeout_reason: reason });
    }

    await migrate(db, TIMEOUT_REASON_MIGRATION);
    const { rows } = await db.query('SELECT session_id,timeout_reason FROM rental_history WHERE owner_user_id=$1 ORDER BY session_id', [OWNER]);
    assert.deepEqual(rows, expected);
  } finally { await db.close(); }
});

test('only the owner receives a timeout reason after the stopped session is removed', async () => {
  const db = await database();
  const pool = testPool(db);
  const hub = new AgentHub(pool);
  let online = true;
  hub.command = async () => {
    if (!online) throw new Error('agent offline');
    return {};
  };
  let actor = OWNER;
  let server: ReturnType<typeof createServer> | null = null;
  try {
    await db.query(`INSERT INTO users(id,provider,subject,username,display_name,role) VALUES
      ($1,'local','owner','owner','Owner','user'),($2,'local','member','member','Member','user'),
      ($3,'local','admin','admin','Admin','admin')`, [OWNER, MEMBER, ADMIN]);
    await db.query("INSERT INTO hosts(id,name,slots) VALUES('host-1','Host',4)");
    const [idle, lifetime, lease, manual] = [1, 2, 3, 4].map(n => `c0000000-0000-4000-8000-00000000000${n}`);
    for (const [slot, id] of [idle, lifetime, lease, manual].entries()) {
      await db.query("INSERT INTO sessions(id,owner_user_id,host_id,profile_id,state) VALUES($1,$2,'host-1','android-30','running')", [id, OWNER]);
      await db.query("INSERT INTO host_slots(host_id,slot_index,session_id) VALUES('host-1',$1,$2)", [slot, id]);
    }
    await db.query("UPDATE sessions SET last_activity_at=now()-interval '90 minutes' WHERE id=$1", [idle]);
    await db.query("UPDATE sessions SET created_at=now()-interval '30 hours' WHERE id=$1", [lifetime]);
    await initializeSessionLease(pool, lease, 120);
    await db.query("UPDATE sessions SET lease_expires_at=now()-interval '1 second' WHERE id=$1", [lease]);

    const auth = { authenticate: async () => ({ user: {
      id: actor, role: actor === ADMIN ? 'admin' : 'user', username: 'reader', displayName: 'Reader', provider: 'local',
    }, via: 'cookie' }) } as unknown as AuthService;
    const policy = { idleMinutes: 60, maxHours: 24 };
    const config = { idleTimeoutMinutes: policy.idleMinutes, maxSessionHours: policy.maxHours } as Config;
    const app = express();
    registerSessionRoutes(app, createServerContext(pool, config, auth, undefined, hub));
    app.use((error: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
      if (error instanceof ApiError) res.status(error.status).json({ error: { code: error.code, message: error.message } });
      else next(error);
    });
    server = createServer(app);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const read = async (id: string) => {
      const result = await fetch(`http://127.0.0.1:${address.port}/api/sessions/${id}`);
      return { status: result.status, body: await result.json() };
    };
    const missing = await read('c0000000-0000-4000-8000-000000000009');
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error.code, 'not_found');
    assert.ok(!('sessionEndReason' in missing.body));
    const expired = await findExpiredSessions(pool, policy, () => false);
    assert.equal(expired.length, 3);
    const timeoutCases = [[idle, 'idle'], [lifetime, 'max_lifetime'], [lease, 'lease_expired']] as const;
    for (const [id, reason] of timeoutCases) {
      const candidate = expired.find(item => item.id === id);
      assert.equal(candidate?.reason, reason);
      assert.ok(candidate);
      online = id !== lease;
      assert.equal(await releaseExpired(pool, hub, candidate, policy), online);
      if (!online) {
        const pending = await read(id);
        assert.equal(pending.status, 200);
        assert.equal(pending.body.session.state, 'stopping');
        assert.ok(!('sessionEndReason' in pending.body) && !('sessionEndReason' in pending.body.session));
        assert.equal((await db.query("SELECT session_id FROM host_slots WHERE host_id='host-1' AND slot_index=2")).rows[0]?.session_id, id);
        // Reconciliation confirms removal later, independently of the reaper request.
        await hub.releaseSession(id);
      }
    }
    await hub.releaseSession(manual);
    await db.query('UPDATE notifications SET read_at=now() WHERE user_id=$1', [OWNER]);
    for (const [id, reason] of timeoutCases) {
      assert.deepEqual(await read(id), { ...missing, body: { ...missing.body, sessionEndReason: reason } });
    }
    assert.deepEqual(await read(manual), missing);
    for (const reader of [MEMBER, ADMIN]) {
      actor = reader;
      for (const [id] of timeoutCases) assert.deepEqual(await read(id), missing);
    }
  } finally {
    if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
    await hub.dispose();
    await pool.end();
  }
});
