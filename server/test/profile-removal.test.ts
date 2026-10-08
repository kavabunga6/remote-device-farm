import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';
import express from 'express';
import { PGlite } from '@electric-sql/pglite';
import type { Pool } from 'pg';
import type { AuthService } from '../src/auth.js';
import type { AgentHub } from '../src/agent.js';
import type { Config } from '../src/config.js';
import { installAuditTrail } from '../src/audit.js';
import { migrate } from '../src/db.js';
import { ApiError } from '../src/http-common.js';
import { createServerContext } from '../src/server-context.js';
import { registerAdminRoutes } from '../src/routes/admin-routes.js';
import { registerQueueRoutes } from '../src/routes/queue-routes.js';
import { createSession } from '../src/session-create.js';
import { allowedProfileIds } from '../src/teams.js';

const ADMIN = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const IMAGE = 'us-docker.pkg.dev/android-emulator-268719/images/30-google-x64-no-metrics:30.1.2';
const BODY = { id: 'alpha', name: 'Android alpha', androidVersion: '11', image: IMAGE, cpu: 2, memoryMb: 4096, diskGb: 16 };

async function fixture() {
  const db = new PGlite();
  const query = async (sql: string, values?: unknown[]) => {
    const result = values === undefined ? (await db.exec(sql)).at(-1) : await db.query(sql, values);
    return { ...result, rowCount: result?.rows?.length || result?.affectedRows || 0 };
  };
  const pool = { query, connect: async () => ({ query, release() {} }) } as unknown as Pool;
  await migrate(pool);
  for (const [id, role] of [[ADMIN, 'admin'], [USER, 'user']]) {
    await db.query("INSERT INTO users(id,provider,subject,username,display_name,role) VALUES($1::uuid,'local',$1::text,$1::text,$1::text,$2)", [id, role]);
  }
  await db.query('DELETE FROM profiles');
  for (const id of ['alpha', 'beta', 'device-phone']) {
    await db.query("INSERT INTO profiles(id,name,android_version,image,cpu,memory_mb,disk_gb,recommended) VALUES($1,$1,'11',$2,2,4096,16,true)", [id, IMAGE]);
  }
  await db.query("INSERT INTO hosts(id,name,status,slots,last_seen_at) VALUES('node','Node','online',1,now())");
  let actor: string | null = ADMIN;
  const auth = { authenticate: async () => actor ? { user: { id: actor, username: actor, role: actor === ADMIN ? 'admin' : 'user' }, via: 'cookie' } : null } as unknown as AuthService;
  const hub = { hasAgent: () => true, command: () => assert.fail('Profile deletion must not contact an agent') } as unknown as AgentHub;
  const context = createServerContext(pool, { maxSessionsPerUser: 3, queueTtlMinutes: 30 } as Config, auth, undefined, hub);
  const app = express(); app.use(express.json()); installAuditTrail(app, pool);
  registerAdminRoutes(app, context); registerQueueRoutes(app, context, { startDispatcher: false }); app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (!(error instanceof ApiError)) console.error(error);
    res.status(error instanceof ApiError ? error.status : 500).json({ error: { code: error instanceof ApiError ? error.code : 'internal_error' } });
  });
  const server = createServer(app); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const request = (path: string, method = 'GET', body?: unknown) => fetch(`http://127.0.0.1:${address.port}/api${path}`, {
    method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const remove = () => request('/admin/profiles/alpha/permanent', 'DELETE');
  const close = async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await db.close(); };
  return { db, pool, context, request, remove, close, actor: (id: string | null) => { actor = id; } };
}

test('profile removal requires admin, keeps legacy disable reversible and hides internal device profiles', async () => {
  const f = await fixture();
  try {
    f.actor(null); assert.equal((await f.remove()).status, 401);
    f.actor(USER); assert.equal((await f.remove()).status, 403);
    f.actor(ADMIN);
    assert.equal((await f.request('/admin/profiles/alpha', 'DELETE')).status, 200);
    const disabled = (await f.db.query<{ enabled: boolean; removed_at: unknown }>("SELECT enabled,removed_at FROM profiles WHERE id='alpha'")).rows[0]!;
    assert.equal(disabled.enabled, false); assert.equal(disabled.removed_at, null);
    const catalog = await (await f.request('/admin/profiles')).json() as { profiles: Array<{ id: string }> };
    assert.deepEqual(catalog.profiles.map(p => p.id).sort(), ['alpha', 'beta']);
    assert.equal((await f.request('/admin/profiles/alpha', 'PATCH', { enabled: true })).status, 200);
    assert.equal((await f.request('/admin/profiles/device-phone/permanent', 'DELETE')).status, 404);
  } finally { await f.close(); }
});

test('removed profiles disappear and cannot be revived while history and team restrictions remain intact', async () => {
  const f = await fixture();
  try {
    const session = randomUUID(), queue = randomUUID(), team = randomUUID();
    await f.db.query("INSERT INTO sessions(id,owner_user_id,host_id,profile_id,state,started_at) VALUES($1,$2,'node','alpha','stopped',now())", [session, USER]);
    const history = (await f.db.query('SELECT * FROM rental_history WHERE session_id=$1', [session])).rows;
    await f.db.query("INSERT INTO queue_entries(id,user_id,profile_id,state,expires_at,resolved_at) VALUES($1,$2,'alpha','cancelled',now(),now())", [queue, USER]);
    await f.db.query("INSERT INTO teams(id,name) VALUES($1,'Restricted')", [team]);
    await f.db.query('INSERT INTO team_members(team_id,user_id) VALUES($1,$2)', [team, USER]);
    await f.db.query("INSERT INTO team_profiles(team_id,profile_id) VALUES($1,'alpha')", [team]);
    assert.equal((await f.remove()).status, 200);
    const stored = (await f.db.query<Record<string, unknown>>("SELECT * FROM profiles WHERE id='alpha'")).rows[0]!;
    assert.ok(stored.removed_at); assert.equal(stored.enabled, false); assert.equal(stored.recommended, false); assert.equal(stored.image, IMAGE);
    assert.deepEqual((await f.db.query('SELECT * FROM rental_history WHERE session_id=$1', [session])).rows, history);
    assert.equal((await f.db.query('SELECT id FROM sessions WHERE id=$1', [session])).rows.length, 1);
    assert.equal((await f.db.query('SELECT id FROM queue_entries WHERE id=$1', [queue])).rows.length, 1);
    assert.deepEqual(await allowedProfileIds(f.pool, { id: USER, role: 'user' }), ['alpha']);
    for (const path of ['/admin/profiles', '/profiles']) {
      const data = await (await f.request(path)).json() as { profiles: Array<{ id?: string; profileId?: string }> };
      assert.ok(data.profiles.every(p => (p.id ?? p.profileId) !== 'alpha'), path);
    }
    for (const [path, method, body] of [
      ['/admin/profiles/alpha', 'PATCH', { enabled: true }], ['/admin/profiles/alpha', 'DELETE', undefined],
      ['/admin/profiles/alpha/permanent', 'DELETE', undefined],
    ] as const) assert.equal((await f.request(path, method, body)).status, 404);
    const duplicate = await f.request('/admin/profiles', 'POST', BODY); assert.equal(duplicate.status, 409);
    assert.deepEqual(await duplicate.json(), { error: { code: 'profile_exists' } });
    await assert.rejects(createSession(f.context, { id: ADMIN, role: 'admin' }, { hostId: 'node', profileId: 'alpha' }),
      (error: unknown) => error instanceof ApiError && error.code === 'profile_not_found');
    assert.equal((await f.request('/queue', 'POST', { profileId: 'alpha' })).status, 404);
    assert.equal((await f.request('/me/profile-presets', 'POST', { name: 'Removed', profileId: 'alpha', gpuMode: 'software', isFavorite: true })).status, 404);
    f.actor(USER);
    assert.deepEqual(await (await f.request('/profiles')).json(), { profiles: [] });
    const audit = await f.db.query<{ action: string; target_id: string }>("SELECT action,target_id FROM audit_events WHERE action='admin.profile_deleted' AND outcome='success'");
    assert.deepEqual(audit.rows, [{ action: 'admin.profile_deleted', target_id: 'alpha' }]);
    await assert.rejects(f.db.query("UPDATE profiles SET enabled=true WHERE id='alpha'"), (error: unknown) => (error as { code?: string }).code === '23514');
  } finally { await f.close(); }
});

test('active sessions, occupied slots and pending queue claims block removal without side effects', async () => {
  const f = await fixture();
  try {
    const session = randomUUID(), queue = randomUUID();
    await f.db.query("INSERT INTO sessions(id,owner_user_id,host_id,profile_id,state) VALUES($1,$2,'node','alpha','starting')", [session, USER]);
    const expectInUse = async () => {
      const response = await f.remove(); assert.equal(response.status, 409);
      assert.deepEqual(await response.json(), { error: { code: 'profile_in_use' } });
      assert.deepEqual((await f.db.query("SELECT enabled,removed_at FROM profiles WHERE id='alpha'")).rows, [{ enabled: true, removed_at: null }]);
    };
    for (const state of ['starting', 'running', 'stopping']) {
      await f.db.query('UPDATE sessions SET state=$2 WHERE id=$1', [session, state]); await expectInUse();
    }
    await f.db.query("UPDATE sessions SET state='failed' WHERE id=$1", [session]);
    await f.db.query("INSERT INTO host_slots(host_id,slot_index,session_id) VALUES('node',0,$1)", [session]);
    await expectInUse();
    await f.db.query("DELETE FROM host_slots WHERE host_id='node'");
    await f.db.query('DELETE FROM sessions WHERE id=$1', [session]);
    await f.db.query("INSERT INTO queue_entries(id,user_id,profile_id,state,expires_at) VALUES($1,$2,'alpha','waiting',now()+interval '1 hour')", [queue, USER]);
    await expectInUse();
    await f.db.query("UPDATE queue_entries SET state='assigned',session_id=id,claimed_at=now() WHERE id=$1", [queue]);
    await expectInUse();
    await f.db.query('UPDATE queue_entries SET resolved_at=now() WHERE id=$1', [queue]);
    assert.equal((await f.remove()).status, 200);
    assert.equal((await f.db.query('SELECT id FROM queue_entries WHERE id=$1', [queue])).rows.length, 1);
  } finally { await f.close(); }
});
