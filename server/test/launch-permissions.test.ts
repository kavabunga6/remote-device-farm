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
import { registerAdminRoutes } from '../src/routes/admin-routes.js';
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
  await db.query("INSERT INTO users(id,provider,subject,username,display_name,role) VALUES($1,'local','qa','qa','QA','user')", [OWNER]);
  await db.query("INSERT INTO profiles(id,name,android_version,image,cpu,memory_mb,guest_cores,guest_memory_mb,disk_gb) VALUES('test-profile','Test','11',$1,4,6144,2,2048,16)", [IMAGE]);
  await db.query(`INSERT INTO hosts(id,name,slots,status,last_seen_at,manual_slots,slot_cpu,slot_memory_mb,metrics) VALUES
    ('a-default','Default',8,'online',now(),8,4,4096,'{}'),
    ('z-allowed','Allowed',8,'online',now(),8,8,16384,'{"privilegedEmulatorsAllowed":true}')`);
  for (const host of ['a-default', 'z-allowed']) for (let slot = 0; slot < 8; slot++) await db.query('INSERT INTO host_slots(host_id,slot_index) VALUES($1,$2)', [host, slot]);
  let role = 'user';
  const auth = { authenticate: async () => (role === 'anonymous' ? null : { user: { id: OWNER, username: 'qa', role }, via: 'cookie' }) } as unknown as AuthService;
  const launches: Array<{ host: string; id: string; profile: Record<string, unknown> }> = [];
  const hub = { hasAgent: () => true, supportsNodePolicy: () => true, onSessionClosed: () => {}, command: async (host: string, id: string, action: string, params: { profile: Record<string, unknown> }) => {
    if (action === 'start') { launches.push({ host, id, profile: params.profile }); return new Promise(() => {}); }
    return {};
  } } as unknown as AgentHub;
  const config = { maxSessionsPerUser: 0, queueTtlMinutes: 30, idleTimeoutMinutes: 0, maxSessionHours: 0 } as Config;
  const context = createServerContext(pool, config, auth, undefined, hub);
  const app = express(); app.use(express.json());
  registerAdminRoutes(app, context); registerSessionRoutes(app, context); registerQueueRoutes(app, context, { startDispatcher: false }); app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(error instanceof ApiError ? error.status : 500).json({ error: { code: error instanceof ApiError ? error.code : 'internal', message: String(error) } }));
  const server = createServer(app); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const request = (path: string, body?: unknown, method?: string) => fetch('http://127.0.0.1:' + address.port + '/api/' + path, { method: method ?? (body === undefined ? 'GET' : 'POST'), headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const as = async (value: string) => { role = value; if (value !== 'anonymous') await db.query('UPDATE users SET role=$2 WHERE id=$1', [OWNER, value]); };
  const dispatch = () => runQueuePass({ pool, hub, config, policy: { idleMinutes: 0, maxHours: 0 } });
  const close = async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await db.close(); };
  return { db, request, launches, as, dispatch, close, context };
}

const start = { hostId: 'z-allowed', profileId: 'test-profile' };

test('deny by default protects resources, storage and emulator arguments through direct and queue APIs', async () => {
  const f = await fixture();
  try {
    await f.db.query("UPDATE profiles SET sdcard_gb=1,sdcard_max_gb=4 WHERE id='test-profile'");
    for (const launchOptions of [{ cpu: 2 }, { memoryMb: 5120 }, { guestCores: 1 }, { guestMemoryMb: 1024 }, { diskGb: 8 }, { sdCardMb: 0 }, { emulatorParams: '-no-boot-anim' }]) {
      for (const path of ['sessions', 'queue']) {
        const response = await f.request(path, { ...start, launchOptions });
        assert.equal(response.status, 403, await response.clone().text());
        assert.equal((await response.json()).error.code, 'launch_overrides_forbidden');
      }
    }
    const legacy = await f.request('sessions', { ...start, diskGb: 8 }); assert.equal(legacy.status, 403);
    assert.equal(f.launches.length, 0);
    assert.equal((await f.db.query('SELECT count(*)::integer AS n FROM host_slots WHERE session_id IS NOT NULL')).rows[0]?.n, 0);
    const plain = await f.request('sessions', start); assert.equal(plain.status, 202, await plain.clone().text());
    const snapshot = (await plain.json()).session.launchOptions;
    const repeated = await f.request('queue', { ...start, launchOptions: snapshot }); assert.equal(repeated.status, 201, await repeated.clone().text());
    await f.dispatch(); assert.equal(f.launches.length, 2);
  } finally { await f.close(); }
});

test('profile allow/deny overrides the farm default, and administrators retain bounded launch access', async () => {
  const f = await fixture();
  try {
    for (const [farm, profile, expected] of [[false, null, false], [true, null, true], [false, true, true], [true, false, false]] as const) {
      await f.db.query('UPDATE launch_settings SET allow_launch_overrides=$1', [farm]);
      await f.db.query("UPDATE profiles SET allow_launch_overrides=$1 WHERE id='test-profile'", [profile]);
      const inventory = await (await f.request('profiles')).json();
      const device = inventory.profiles.find((item: { id: string }) => item.id === 'test-profile');
      assert.equal(device.allowLaunchOverrides, profile); assert.equal(device.launchOverridesAllowed, expected);
      for (const path of ['sessions', 'queue']) {
        const response = await f.request(path, { ...start, launchOptions: { guestCores: 1 } });
        assert.equal(response.status, expected ? path === 'sessions' ? 202 : 201 : 403, await response.clone().text());
      }
      await f.db.query('DELETE FROM queue_entries');
    }
    await f.as('admin');
    const admin = await f.request('sessions', { ...start, launchOptions: { cpu: 6, guestCores: 3 } }); assert.equal(admin.status, 202, await admin.clone().text());
    await f.as('user'); await f.db.query("UPDATE profiles SET allow_launch_overrides=true WHERE id='test-profile'");
    const excessive = await f.request('sessions', { ...start, launchOptions: { cpu: 8 } });
    assert.equal(excessive.status, 403); assert.equal((await excessive.json()).error.code, 'resource_limit_forbidden');
    const privileged = await f.request('sessions', { ...start, launchOptions: { privileged: true } });
    assert.equal(privileged.status, 403); assert.equal((await privileged.json()).error.code, 'privileged_launch_forbidden');
  } finally { await f.close(); }
});

test('only administrators change farm/profile permissions; manifest round trips preserve the override', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.request('admin/launch-settings')).status, 403);
    assert.equal((await f.request('admin/launch-settings', { allowLaunchOverrides: true }, 'PATCH')).status, 403);
    await f.as('anonymous'); assert.equal((await f.request('admin/launch-settings')).status, 401);
    await f.as('admin');
    assert.deepEqual(await (await f.request('admin/launch-settings')).json(), { allowLaunchOverrides: false });
    assert.equal((await f.request('admin/launch-settings', { allowLaunchOverrides: 'true' }, 'PATCH')).status, 400);
    assert.deepEqual(await (await f.request('admin/launch-settings', { allowLaunchOverrides: true }, 'PATCH')).json(), { allowLaunchOverrides: true });
    const body = { id: 'permission-qa', name: 'Permission QA', androidVersion: '11', image: IMAGE, cpu: 4, memoryMb: 6144, diskGb: 16, allowLaunchOverrides: false };
    const created = await f.request('admin/profiles', body); assert.equal(created.status, 201, await created.clone().text());
    assert.equal((await created.json()).profile.allowLaunchOverrides, false);
    assert.equal((await f.request('admin/profiles/permission-qa', { allowLaunchOverrides: 'deny' }, 'PATCH')).status, 400);
    const manifest = await (await f.request('admin/profiles/export')).json();
    assert.equal(manifest.profiles.find((item: { id: string }) => item.id === body.id).allowLaunchOverrides, false);
    const updated = await f.request('admin/profiles/permission-qa', { allowLaunchOverrides: true }, 'PATCH'); assert.equal(updated.status, 200);
    const imported = await f.request('admin/profiles/import', { manifest, apply: true, update: true }); assert.equal(imported.status, 200, await imported.clone().text());
    assert.equal((await imported.json()).applied, true);
    assert.equal((await f.db.query("SELECT allow_launch_overrides FROM profiles WHERE id='permission-qa'")).rows[0]?.allow_launch_overrides, false);
    assert.equal((await f.request('admin/profiles/permission-qa', { allowLaunchOverrides: null }, 'PATCH')).status, 200);
    assert.equal((await f.request('me/profile-presets')).status, 404);
    assert.equal((await f.request('profiles/frequent')).status, 404);
  } finally { await f.close(); }
});

test('queue assignment rechecks revoked permissions without blocking default launches', async () => {
  const f = await fixture();
  try {
    await f.db.query('UPDATE launch_settings SET allow_launch_overrides=true');
    const plain = await f.request('queue', start); assert.equal(plain.status, 201);
    const changed = await f.request('queue', { ...start, launchOptions: { guestCores: 1 } }); assert.equal(changed.status, 201);
    const changedId = (await changed.json()).id;
    await f.db.query('UPDATE launch_settings SET allow_launch_overrides=false');
    await f.dispatch();
    assert.equal(f.launches.length, 1);
    const rejected = (await f.db.query('SELECT state,error_code FROM queue_entries WHERE id=$1', [changedId])).rows[0];
    assert.deepEqual(rejected, { state: 'cancelled', error_code: 'launch_overrides_forbidden' });
  } finally { await f.close(); }
});
