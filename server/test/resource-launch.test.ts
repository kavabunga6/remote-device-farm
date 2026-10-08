import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import express from 'express';
import { PGlite } from '@electric-sql/pglite';
import type { Pool } from 'pg';
import type { AgentHub } from '../src/agent.js';
import type { Config } from '../src/config.js';
import type { AuthService } from '../src/auth.js';
import { ApiError } from '../src/http-common.js';
import { migrate } from '../src/db.js';
import { createServerContext } from '../src/server-context.js';
import { createSession } from '../src/session-create.js';
import { registerSessionRoutes } from '../src/routes/session-routes.js';
import { registerQueueRoutes } from '../src/routes/queue-routes.js';
import { runQueuePass } from '../src/queue-dispatcher.js';

const OWNER = '11111111-1111-4111-8111-111111111111';
const IMAGE = 'us-docker.pkg.dev/android-emulator-268719/images/30-google-x64-no-metrics:30.1.2';
async function fixture() {
  const db = new PGlite();
  const query = async (sql: string, values?: unknown[]) => {
    const result = values === undefined ? (await db.exec(sql)).at(-1) : await db.query(sql, values);
    return { ...result, rowCount: result?.rows?.length || result?.affectedRows || 0 };
  };
  const pool = { query, connect: async () => ({ query, release() {} }) } as unknown as Pool;
  await migrate(pool);
  await db.query("UPDATE launch_settings SET allow_launch_overrides=true");
  await db.query("INSERT INTO users(id,provider,subject,username,display_name,role) VALUES($1,'local','qa','qa','QA','user')", [OWNER]);
  await db.query("INSERT INTO profiles(id,name,android_version,image,cpu,memory_mb,guest_cores,guest_memory_mb,disk_gb) VALUES('test-profile','Test','11',$1,4,6144,2,2048,16)", [IMAGE]);
  await db.query(`INSERT INTO hosts(id,name,slots,status,last_seen_at,manual_slots,slot_cpu,slot_memory_mb,metrics) VALUES
    ('a-default','Default',8,'online',now(),8,4,4096,'{}'),
    ('z-allowed','Allowed',8,'online',now(),8,8,16384,'{"privilegedEmulatorsAllowed":true}')`);
  for (const host of ['a-default', 'z-allowed']) for (let slot = 0; slot < 8; slot++) await db.query('INSERT INTO host_slots(host_id,slot_index) VALUES($1,$2)', [host, slot]);
  let role = 'user';
  const auth = { authenticate: async () => ({ user: { id: OWNER, username: 'qa', role }, via: 'cookie' }) } as unknown as AuthService;
  const launches: Array<{ host: string; id: string; profile: Record<string, unknown> }> = [];
  const hub = { hasAgent: () => true, supportsNodePolicy: () => true, onSessionClosed: () => {}, command: async (host: string, id: string, action: string, params: { profile: Record<string, unknown> }) => {
    if (action === 'start') { launches.push({ host, id, profile: params.profile }); return new Promise(() => {}); }
    return {};
  } } as unknown as AgentHub;
  const config = { maxSessionsPerUser: 0, queueTtlMinutes: 30, idleTimeoutMinutes: 0, maxSessionHours: 0 } as Config;
  const context = createServerContext(pool, config, auth, undefined, hub);
  const app = express(); app.use(express.json());
  registerSessionRoutes(app, context); registerQueueRoutes(app, context, { startDispatcher: false }); app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(error instanceof ApiError ? error.status : 500).json({ error: { code: error instanceof ApiError ? error.code : 'internal', message: String(error) } }));
  const server = createServer(app); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const request = (path: string, body?: unknown) => fetch('http://127.0.0.1:' + address.port + '/api/' + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const as = async (value: string) => { role = value; await db.query('UPDATE users SET role=$2 WHERE id=$1', [OWNER, value]); };
  const dispatch = () => runQueuePass({ pool, hub, config, policy: { idleMinutes: 0, maxHours: 0 } });
  const close = async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await db.close(); };
  return { db, request, launches, as, dispatch, close, context };
}

const RESOURCE_FIELDS = ['cpu', 'memoryMb', 'guestCores', 'guestMemoryMb'] as const;
const selected = (value: Record<string, unknown>) => Object.fromEntries(RESOURCE_FIELDS.map(key => [key, value[key]]));
const reduced = { cpu: 2, memoryMb: 3072, guestCores: 1, guestMemoryMb: 2048 };
const start = { hostId: 'a-default', profileId: 'test-profile' };

test('session resources override actual launch limits, preserve profile defaults, and survive later profile edits', async () => {
  const f = await fixture();
  try {
    const response = await f.request('sessions', { ...start, launchOptions: reduced });
    assert.equal(response.status, 202, await response.clone().text());
    const session = (await response.json()).session;
    assert.deepEqual(selected(session.launchOptions), reduced);
    assert.deepEqual(selected(f.launches[0]!.profile), reduced);
    assert.equal(session.launchMemoryMb, reduced.memoryMb);
    const profile = (await f.db.query("SELECT cpu,memory_mb,guest_cores,guest_memory_mb FROM profiles WHERE id='test-profile'")).rows[0];
    assert.deepEqual(profile, { cpu: 4, memory_mb: 6144, guest_cores: 2, guest_memory_mb: 2048 });
    const occupied = (await f.db.query('SELECT count(*)::integer AS n FROM host_slots WHERE session_id IS NOT NULL')).rows[0]?.n;
    for (const [launchOptions, code, status] of [
      [{ cpu: 5 }, 'resource_limit_forbidden', 403],
      [{ memoryMb: 8192 }, 'resource_limit_forbidden', 403],
      [{ cpu: 1 }, 'resources_out_of_range', 409],
      [{ memoryMb: 2048 }, 'resources_out_of_range', 409],
      [{ guestCores: 5 }, 'resources_out_of_range', 409],
      [{ guestMemoryMb: 6144 }, 'resources_out_of_range', 409],
      [{ cpu: '2' }, 'invalid_launch_options', 400],
    ] as const) {
      for (const path of ['sessions', 'queue']) {
        const rejected = await f.request(path, { ...start, launchOptions });
        assert.equal(rejected.status, status); assert.equal((await rejected.json()).error.code, code);
      }
    }
    assert.equal((await f.db.query('SELECT count(*)::integer AS n FROM host_slots WHERE session_id IS NOT NULL')).rows[0]?.n, occupied);
    assert.equal(f.launches.length, 1);
    await assert.rejects(createSession(f.context, { id: OWNER, role: 'user' }, { ...start, sessionId: session.id, launchOptions: { ...reduced, cpu: 3 } }), { code: 'session_conflict' });
    await f.db.query("UPDATE profiles SET cpu=8,memory_mb=12288,guest_cores=6,guest_memory_mb=8192 WHERE id='test-profile'");
    const info = await f.request('sessions/' + session.id + '/device-info'); assert.equal(info.status, 200);
    assert.deepEqual(selected((await info.json()).profile), reduced);
    const listed = await (await f.request('sessions')).json();
    assert.deepEqual(selected(listed.sessions.find((item: { id: string }) => item.id === session.id).launchOptions), reduced);
  } finally { await f.close(); }
});

test('administrators may raise per-session limits but every launch still fits its node slot', async () => {
  const f = await fixture();
  try {
    await f.as('admin');
    const raised = { cpu: 8, memoryMb: 12288, guestCores: 6, guestMemoryMb: 8192 };
    for (const path of ['sessions', 'queue']) {
      const rejected = await f.request(path, { ...start, launchOptions: raised });
      assert.equal(rejected.status, 409); assert.equal((await rejected.json()).error.code, 'profile_too_large');
    }
    const response = await f.request('sessions', { ...start, hostId: 'z-allowed', launchOptions: raised });
    assert.equal(response.status, 202, await response.clone().text());
    assert.deepEqual(selected(f.launches[0]!.profile), raised);
    assert.equal((await f.db.query("SELECT cpu FROM profiles WHERE id='test-profile'")).rows[0]?.cpu, 4);
    await f.as('user');
    const reused = await f.request('sessions', { ...start, hostId: 'z-allowed', launchOptions: (await response.json()).session.launchOptions });
    assert.equal(reused.status, 403); assert.equal((await reused.json()).error.code, 'resource_limit_forbidden');
  } finally { await f.close(); }
});

test('queued resources are frozen at enqueue, including image defaults, and rechecked before allocation', async () => {
  const f = await fixture();
  try {
    const queued = await f.request('queue', { profileId: start.profileId, launchOptions: reduced });
    assert.equal(queued.status, 201); const entry = await queued.json();
    assert.deepEqual(selected(entry.launchOptions), reduced);
    await f.db.query("UPDATE profiles SET guest_cores=4,guest_memory_mb=4096 WHERE id='test-profile'");
    await f.dispatch();
    assert.equal(f.launches[0]?.id, entry.id); assert.deepEqual(selected(f.launches[0]!.profile), reduced);
    assert.equal(f.launches[0]?.host, 'a-default', 'admission uses the smaller selected allocation');
    await f.db.query("UPDATE profiles SET guest_cores=NULL,guest_memory_mb=NULL WHERE id='test-profile'");
    const imageQueued = await f.request('queue', { profileId: start.profileId });
    assert.equal(imageQueued.status, 201); const imageEntry = await imageQueued.json();
    assert.equal(imageEntry.launchOptions.guestCores, null); assert.equal(imageEntry.launchOptions.guestMemoryMb, null);
    await f.db.query("UPDATE profiles SET guest_cores=4,guest_memory_mb=4096 WHERE id='test-profile'");
    await f.dispatch();
    assert.equal(f.launches[1]?.id, imageEntry.id);
    assert.deepEqual(selected(f.launches[1]!.profile), { cpu: 4, memoryMb: 6144, guestCores: null, guestMemoryMb: null });
    const capped = await f.request('queue', { profileId: start.profileId, launchOptions: reduced });
    assert.equal(capped.status, 201); const cappedEntry = await capped.json();
    await f.db.query("UPDATE profiles SET cpu=1,memory_mb=2048,guest_cores=1,guest_memory_mb=1024 WHERE id='test-profile'");
    await f.dispatch();
    const saved = (await f.db.query('SELECT state,error_code FROM queue_entries WHERE id=$1', [cappedEntry.id])).rows[0];
    assert.deepEqual(saved, { state: 'cancelled', error_code: 'resource_limit_forbidden' });
    assert.equal(f.launches.length, 2);
  } finally { await f.close(); }
});
