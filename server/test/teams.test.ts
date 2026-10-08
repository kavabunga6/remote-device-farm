import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import express from 'express';
import { PGlite } from '@electric-sql/pglite';
import type { Pool } from 'pg';
import type { Config } from '../src/config.js';
import type { AuthService } from '../src/auth.js';
import type { AgentHub } from '../src/agent.js';
import { ApiError } from '../src/http-common.js';
import { createServerContext } from '../src/server-context.js';
import { registerSessionRoutes } from '../src/routes/session-routes.js';
import { registerTeamRoutes } from '../src/routes/team-routes.js';
import { registerAdminRoutes } from '../src/routes/admin-routes.js';
import { createSession } from '../src/session-create.js';
import { allowedProfileIds, combineAllowlists, combineLimits, teamLimitFor } from '../src/teams.js';

const MIGRATIONS = ['001_init', '002_gpu_mode', '003_default_profile_resources', '004_guest_resources', '005_host_settings',
  '006_adb_port_access', '008_user_adb_keys', '009_uploaded_adb_public_keys', '010_user_settings_audit', '011_node_management',
  '012_session_lifecycle', '013_queue_notifications', '014_session_sharing', '018_teams', '021_profile_gpu_variants', '022_profile_gpu_memory', '026_session_startup_progress', '029_storage_limits', '038_profile_secrets_docker_options', '025_physical_devices', '023_user_profile_presets', '030_preset_storage', '033_launch_options', '040_emulator_image_registry', '036_profile_removal', '045_launch_permissions', '046_session_diagnostics', '048_user_removal', '049_access_roles'];

const ANNA = '11111111-1111-4111-8111-111111111111';
const BORIS = '22222222-2222-4222-8222-222222222222';
const CARA = '33333333-3333-4333-8333-333333333333';
const ADMIN = '44444444-4444-4444-8444-444444444444';
const TEAM_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TEAM_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

async function database(): Promise<PGlite> {
  const db = new PGlite();
  for (const file of MIGRATIONS) await db.exec(await readFile(new URL(`../migrations/${file}.sql`, import.meta.url), 'utf8'));
  for (const [id, name, role] of [[ANNA, 'anna', 'user'], [BORIS, 'boris', 'user'], [CARA, 'cara', 'user'], [ADMIN, 'root', 'admin']]) {
    await db.query("INSERT INTO users(id,provider,subject,username,display_name,role) VALUES($1,'local',$2,$2,$2,$3)", [id, name, role]);
  }
  await db.query("INSERT INTO hosts(id,name,slots,status,manual_slots,last_seen_at) VALUES('host-1','Host',6,'online',6,now())");
  await db.query("UPDATE hosts SET slot_cpu=8,slot_memory_mb=32768 WHERE id='host-1'");
  await db.query("INSERT INTO host_slots(host_id,slot_index) VALUES('host-1',0),('host-1',1),('host-1',2),('host-1',3),('host-1',4),('host-1',5)");
  await db.query("INSERT INTO profiles(id,name,android_version,image,cpu,memory_mb,disk_gb) VALUES('p-extra','Extra','11','us-docker.pkg.dev/android-emulator-268719/images/30-google-x64-no-metrics:30.1.2',2,2048,8)");
  return db;
}

const asPool = (db: PGlite) => {
  const client = { query: db.query.bind(db), release: () => {} };
  return { query: db.query.bind(db), connect: async () => client } as unknown as Pool;
};
const hub = { hasAgent: () => true, command: async () => ({ containerId: 'c' }), refreshStream: () => {} } as unknown as AgentHub;
const config = { maxSessionsPerUser: 2, idleTimeoutMinutes: 0, maxSessionHours: 0 } as Config;
const user = (id: string, role = 'user') => ({ id, role });

test('limits and allowlists combine across teams', () => {
  assert.equal(combineLimits([], 3), 3);
  assert.equal(combineLimits([null], 3), 3);
  assert.equal(combineLimits([1, 5], 3), 5);
  assert.equal(combineLimits([1, null], 3), 3);
  assert.equal(combineLimits([1, 0], 3), 0);
  assert.equal(combineAllowlists([]), null);
  assert.equal(combineAllowlists([['a'], []]), null);
  assert.deepEqual(combineAllowlists([['a', 'b'], ['b', 'c']])?.sort(), ['a', 'b', 'c']);
});

test('effective limit and allowlist are read from the database', async () => {
  const db = await database();
  try {
    await db.query("INSERT INTO teams(id,name,max_sessions) VALUES($1,'A',1),($2,'B',4)", [TEAM_A, TEAM_B]);
    await db.query("INSERT INTO team_members VALUES($1,$3,'member'),($2,$3,'member'),($1,$4,'member'),($1,$5,'lead')", [TEAM_A, TEAM_B, ANNA, BORIS, CARA]);
    await db.query("INSERT INTO team_profiles VALUES($1,'android-30')", [TEAM_A]);
    const client = asPool(db);
    assert.equal(await teamLimitFor(client, user(ANNA), 2), 4, 'most generous team wins');
    assert.equal(await teamLimitFor(client, user(BORIS), 2), 1);
    assert.equal(await teamLimitFor(client, user('99999999-9999-4999-8999-999999999999'), 2), 2, 'no team keeps the default');
    assert.equal(await teamLimitFor(client, user(ADMIN, 'admin'), 2), 0);
    assert.equal(await allowedProfileIds(client, user(ANNA)), null, 'team B has an empty list, so everything is allowed');
    assert.deepEqual(await allowedProfileIds(client, user(BORIS)), ['android-30']);
    assert.equal(await allowedProfileIds(client, user(ADMIN, 'admin')), null);
  } finally { await db.close(); }
});

test('createSession enforces team limit and allowlist', async () => {
  const db = await database();
  try {
    await db.query("INSERT INTO teams(id,name,max_sessions) VALUES($1,'A',3)", [TEAM_A]);
    await db.query("INSERT INTO team_members VALUES($1,$2,'member')", [TEAM_A, ANNA]);
    await db.query("INSERT INTO team_profiles VALUES($1,'android-30')", [TEAM_A]);
    const context = { pool: asPool(db), hub, config };
    await assert.rejects(createSession(context, user(ANNA), { hostId: 'host-1', profileId: 'p-extra' }),
      (error: unknown) => error instanceof ApiError && error.status === 403 && error.code === 'profile_not_allowed');
    for (let i = 0; i < 3; i++) await createSession(context, user(ANNA), { hostId: 'host-1', profileId: 'android-30' });
    await assert.rejects(createSession(context, user(ANNA), { hostId: 'host-1', profileId: 'android-30' }),
      (error: unknown) => error instanceof ApiError && error.code === 'session_limit', 'team limit 3 beats the default 2');
    // Outside any team the default applies and every profile is allowed.
    await createSession(context, user(BORIS), { hostId: 'host-1', profileId: 'p-extra' });
    await db.query('UPDATE teams SET max_sessions=0 WHERE id=$1', [TEAM_A]);
    await createSession(context, user(ANNA), { hostId: 'host-1', profileId: 'android-30' });
    // Let the background start-confirmation updates finish before the database closes.
    await new Promise(resolve => setTimeout(resolve, 100));
  } finally { await db.close(); }
});

test('team routes: admin only, validation, leads see metadata only', async () => {
  const db = await database();
  let actor = ADMIN;
  let server: ReturnType<typeof createServer> | null = null;
  try {
    const auth = { authenticate: async () => ({ user: { id: actor, username: 'x', displayName: 'x', role: actor === ADMIN ? 'admin' : 'user', provider: 'local' }, via: 'cookie' }) } as unknown as AuthService;
    const context = createServerContext(asPool(db), config, auth, undefined, hub);
    const app = express();
    app.use(express.json());
    registerAdminRoutes(app, context);
    registerSessionRoutes(app, context);
    registerTeamRoutes(app, context);
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
    const send = (path: string, method = 'GET', body?: unknown) => fetch(base + path, {
      method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = async (response: Response) => await response.json() as Record<string, any>;

    const created = await send('/api/admin/teams', 'POST', { name: 'QA', maxSessions: 1 });
    assert.equal(created.status, 201);
    const teamId = (await json(created)).team.id as string;
    assert.equal((await send('/api/admin/teams', 'POST', { name: 'qa' })).status, 409, 'names are unique ignoring case');
    assert.equal((await send('/api/admin/teams', 'POST', { name: 'X', maxSessions: -1 })).status, 400);
    assert.equal((await send('/api/admin/teams', 'POST', { name: '' })).status, 400);
    assert.equal((await send(`/api/admin/teams/${teamId}/members`, 'PUT', { members: [{ userId: ANNA, role: 'lead' }, { userId: BORIS }] })).status, 200);
    assert.equal((await send(`/api/admin/teams/${teamId}/members`, 'PUT', { members: [{ userId: ANNA }, { userId: ANNA }] })).status, 400);
    assert.equal((await send(`/api/admin/teams/${teamId}/members`, 'PUT', { members: [{ userId: ANNA, role: 'boss' }] })).status, 400);
    assert.equal((await send(`/api/admin/teams/${teamId}/members`, 'PUT', { members: [{ userId: '55555555-5555-4555-8555-555555555555' }] })).status, 400);
    assert.equal((await send(`/api/admin/teams/${teamId}/profiles`, 'PUT', { profileIds: ['nope'] })).status, 400);
    assert.equal((await send(`/api/admin/teams/${teamId}/profiles`, 'PUT', { profileIds: ['android-30'] })).status, 200);
    const patched = await json(await send(`/api/admin/teams/${teamId}`, 'PATCH', { maxSessions: null }));
    assert.equal(patched.team.maxSessions, null);
    const list = await json(await send('/api/admin/teams'));
    assert.equal(list.teams[0].members.length, 2);
    assert.deepEqual(list.teams[0].profileIds, ['android-30']);

    // Profile list is filtered for members, not for administrators.
    await db.query("UPDATE profiles SET enabled=true");
    actor = BORIS;
    assert.deepEqual((await json(await send('/api/profiles'))).profiles.map((p: { id: string }) => p.id), ['android-30']);
    assert.deepEqual(await json(await send('/api/me/limits')), { maxSessions: 2, allowedProfileIds: ['android-30'] });
    const denied = await send('/api/sessions', 'POST', { hostId: 'host-1', profileId: 'p-extra' });
    assert.equal(denied.status, 403);
    assert.equal((await json(denied)).error.code, 'profile_not_allowed');
    actor = ADMIN;
    assert.ok((await json(await send('/api/profiles'))).profiles.length >= 2);

    // Normal users cannot use admin routes.
    actor = ANNA;
    for (const [path, method, body] of [['/api/admin/teams', 'GET'], ['/api/admin/teams', 'POST', { name: 'Z' }],
      [`/api/admin/teams/${teamId}`, 'PATCH', { name: 'Z' }], [`/api/admin/teams/${teamId}`, 'DELETE'],
      [`/api/admin/teams/${teamId}/members`, 'PUT', { members: [] }], [`/api/admin/teams/${teamId}/profiles`, 'PUT', { profileIds: [] }]] as const) {
      assert.equal((await send(path, method, body)).status, 403, method + ' ' + path);
    }

    // Lead sees metadata of members' sessions; a plain member and an outsider do not.
    const sid = 'c0000000-0000-4000-8000-000000000001';
    const other = 'c0000000-0000-4000-8000-000000000002';
    await db.query("INSERT INTO sessions(id,owner_user_id,host_id,profile_id,state,label) VALUES($1,$2,'host-1','android-30','running','bug-1'),($3,$4,'host-1','android-30','running',NULL)", [sid, BORIS, other, CARA]);
    const seen = await json(await send(`/api/teams/${teamId}/sessions`));
    assert.deepEqual(seen.sessions.map((s: { id: string }) => s.id), [sid]);
    assert.deepEqual(Object.keys(seen.sessions[0]).sort(), ['ageSeconds', 'createdAt', 'hostName', 'id', 'label', 'lastActivityAt', 'ownerId', 'ownerName', 'profileId', 'profileName', 'state']);
    const mine = await json(await send('/api/teams/mine'));
    assert.equal(mine.teams[0].myRole, 'lead');
    // The lead still cannot reach any session endpoint of another user.
    for (const suffix of ['', '/stream', '/screenshot', '/keepalive']) {
      const method = suffix === '/keepalive' ? 'POST' : 'GET';
      assert.ok([403, 404].includes((await send(`/api/sessions/${sid}${suffix}`, method)).status), 'lead blocked on ' + suffix);
    }
    assert.equal((await send(`/api/sessions/${sid}`, 'DELETE')).status, 404);
    actor = BORIS;
    assert.equal((await send(`/api/teams/${teamId}/sessions`)).status, 404, 'members are not leads');
    actor = CARA;
    assert.equal((await send(`/api/teams/${teamId}/sessions`)).status, 404);

    // Deleting a team keeps users and sessions.
    actor = ADMIN;
    assert.equal((await send(`/api/admin/teams/${teamId}`, 'DELETE')).status, 200);
    assert.equal(Number((await db.query('SELECT count(*)::integer AS n FROM team_members')).rows[0]?.n), 0);
    assert.equal(Number((await db.query('SELECT count(*)::integer AS n FROM users')).rows[0]?.n), 4);
    assert.equal(Number((await db.query('SELECT count(*)::integer AS n FROM sessions')).rows[0]?.n), 2);
  } finally {
    if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
    await db.close();
  }
});
