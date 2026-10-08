import { notifySessionReady } from '../src/notifications.js';
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
import { registerQueueRoutes } from '../src/routes/queue-routes.js';
import { assignWaiting, queuePosition, runNotificationPass, runQueuePass } from '../src/queue-dispatcher.js';

const MIGRATIONS = ['001_init', '002_gpu_mode', '003_default_profile_resources', '004_guest_resources', '005_host_settings',
  '006_adb_port_access', '008_user_adb_keys', '009_uploaded_adb_public_keys', '010_user_settings_audit', '011_node_management',
  '012_session_lifecycle', '013_queue_notifications', '018_teams', '020_profile_metadata', '021_profile_gpu_variants', '022_profile_gpu_memory', '029_storage_limits', '038_profile_secrets_docker_options', '032_queue_integration', '023_user_profile_presets', '030_preset_storage', '033_launch_options', '040_emulator_image_registry', '045_launch_permissions', '048_user_removal', '049_access_roles'];

async function database(): Promise<PGlite> {
  const db = new PGlite();
  for (const file of MIGRATIONS) await db.exec(await readFile(new URL(`../migrations/${file}.sql`, import.meta.url), 'utf8'));
  await db.query('UPDATE launch_settings SET allow_launch_overrides=true');
  return db;
}

const U1 = '11111111-1111-4111-8111-111111111111';
const U2 = '22222222-2222-4222-8222-222222222222';
const U3 = '33333333-3333-4333-8333-333333333333';

async function seed(db: PGlite): Promise<void> {
  for (const [id, name] of [[U1, 'one'], [U2, 'two'], [U3, 'three']]) {
    await db.query("INSERT INTO users(id,provider,subject,username,display_name) VALUES($1,'local',$2,$2,$2)", [id, name]);
  }
  await db.query("INSERT INTO hosts(id,name,slots,status,last_seen_at,slot_cpu,slot_memory_mb) VALUES('h1','H1',1,'online',now(),4,6144),('h2','H2',1,'online',now(),4,6144)");
  await db.query("INSERT INTO host_slots(host_id,slot_index) VALUES('h1',0),('h2',0)");
}

const entry = (id: string, userId: string, hostId: string | null) =>
  ({ id, userId, role: 'user', username: userId, profileId: 'android-30', hostId, label: null });

test('position counts only older entries that compete for the same host', () => {
  const waiting = [{ id: 'a', hostId: 'h1' }, { id: 'b', hostId: 'h2' }, { id: 'c', hostId: null }, { id: 'd', hostId: 'h2' }];
  assert.equal(queuePosition(waiting, 'a'), 1);
  assert.equal(queuePosition(waiting, 'b'), 1);
  assert.equal(queuePosition(waiting, 'c'), 3);
  assert.equal(queuePosition(waiting, 'd'), 3);
  assert.equal(queuePosition(waiting, 'missing'), 0);
});

test('a younger entry cannot take a host that an older entry is waiting for', async () => {
  const created: string[] = [];
  // h1 is full; h2 has a free slot.
  const tryCreate = async (e: { id: string }, host: string) => {
    if (host === 'h1') throw new ApiError(409, 'no_free_slots', 'full');
    created.push(`${e.id}@${host}`); return 'session-' + e.id;
  };
  const results: string[] = [];
  await assignWaiting([entry('old-h1', U1, 'h1'), entry('young-h1', U2, 'h1'), entry('any', U3, null)], ['h1', 'h2'], tryCreate,
    async (e, d) => { results.push(`${e.id}:${d.kind}`); });
  assert.deepEqual(created, ['any@h2'], 'the younger h1 entry is not even tried, the any-host entry uses h2');
  assert.deepEqual(results, ['any:assigned']);
});

test('an entry whose user is over the limit is skipped without blocking others, and its other entries too', async () => {
  const tried: string[] = [];
  const tryCreate = async (e: { id: string; }, host: string) => {
    tried.push(e.id);
    if (e.id.startsWith('limited')) throw new ApiError(409, 'session_limit', 'limit');
    return 's-' + e.id + host;
  };
  const results: string[] = [];
  await assignWaiting([entry('limited-1', U1, null), entry('limited-2', U1, null), entry('fine', U2, null)], ['h1'], tryCreate,
    async (e, d) => { results.push(`${e.id}:${d.kind}`); });
  assert.deepEqual(tried, ['limited-1', 'fine']);
  assert.deepEqual(results, ['fine:assigned']);
});

test('a profile that no longer exists cancels the entry; a host that cannot fit it falls through to the next host', async () => {
  const results: string[] = [];
  await assignWaiting([entry('gone', U1, null), entry('fits-h2', U2, null)], ['h1', 'h2'],
    async (e, host) => {
      if (e.id === 'gone') throw new ApiError(404, 'profile_not_found', 'x');
      if (host === 'h1') throw new ApiError(409, 'profile_too_large', 'x');
      return 's';
    }, async (e, d) => { results.push(`${e.id}:${d.kind}`); });
  assert.deepEqual(results, ['gone:cancel', 'fits-h2:assigned']);
});

test('the dispatcher serves the oldest entry, expires stale ones and reverts a failed claim', async () => {
  const db = await database();
  try {
    await seed(db);
    await db.exec("UPDATE hosts SET status='online'");
    const pool = { query: db.query.bind(db) } as unknown as Pool;
    const insert = (id: string, user: string, host: string | null, age: string, ttl = '30 minutes') => db.query(
      `INSERT INTO queue_entries(id,user_id,profile_id,host_id,created_at,expires_at) VALUES($1,$2,'android-30',$3,now() - $4::interval, now() + $5::interval)`,
      [id, user, host, age, ttl]);
    const E1 = 'e0000000-0000-4000-8000-000000000001', E2 = 'e0000000-0000-4000-8000-000000000002', E3 = 'e0000000-0000-4000-8000-000000000003';
    await insert(E1, U1, 'h1', '10 minutes');
    await insert(E2, U2, 'h1', '5 minutes');
    await insert(E3, U3, null, '20 minutes', '-1 minute');
    let free = false;
    const calls: string[] = [];
    const deps = {
      pool, hub: { hasAgent: () => true, onSessionClosed: () => {} } as never,
      config: { queueTtlMinutes: 30, maxSessionsPerUser: 3 } as Config, policy: { idleMinutes: 0, maxHours: 0 },
      create: async (user: { id: string }, input: { hostId: string; sessionId: string }) => {
        calls.push(user.id + '@' + input.hostId);
        if (!free) throw new ApiError(409, 'no_free_slots', 'full');
        await db.query(
          "INSERT INTO sessions(id,owner_user_id,host_id,profile_id,state) VALUES($1,$2,$3,'android-30','starting')",
          [input.sessionId, user.id, input.hostId],
        );
        return input.sessionId;
      },
    };
    await runQueuePass(deps);
    const state = async () => Object.fromEntries((await db.query('SELECT id,state FROM queue_entries')).rows.map((r: any) => [r.id, r.state]));
    assert.deepEqual(await state(), { [E1]: 'waiting', [E2]: 'waiting', [E3]: 'expired' });
    assert.deepEqual(calls, [U1 + '@h1'], 'only the oldest entry asks for the full host');
    free = true;
    await runQueuePass(deps);
    const after = await state();
    assert.equal(after[E1], 'assigned');
    assert.equal(after[E2], 'assigned', 'the next entry also gets served while slots are free (stubbed)');
    const notices = (await db.query("SELECT user_id,kind FROM notifications WHERE kind='queue.assigned' ORDER BY user_id")).rows;
    assert.equal(notices.length, 2);
    const audit = (await db.query("SELECT action FROM audit_events WHERE action='queue.assigned'")).rows;
    assert.equal(audit.length, 2);
  } finally { await db.close(); }
});

test('a crash after claim or session creation recovers once without a second launch', async () => {
  const db = await database();
  try {
    await seed(db);
    const missing = 'e0000000-0000-4000-8000-000000000010';
    const created = 'e0000000-0000-4000-8000-000000000011';
    await db.query(
      `INSERT INTO queue_entries(id,user_id,profile_id,host_id,state,session_id,claimed_at,expires_at)
       VALUES($1,$3,'android-30','h1','assigned',$1,now()-interval '3 minutes',now()+interval '30 minutes'),
             ($2,$4,'android-30','h2','assigned',$2,now()-interval '3 minutes',now()+interval '30 minutes')`,
      [missing, created, U1, U2],
    );
    await db.query(
      "INSERT INTO sessions(id,owner_user_id,host_id,profile_id,state) VALUES($1,$2,'h2','android-30','starting')",
      [created, U2],
    );
    const pool = { query: db.query.bind(db) } as unknown as Pool;
    let online = false;
    let launches = 0;
    const deps = {
      pool, hub: { hasAgent: () => online, onSessionClosed: () => {} } as never,
      config: { queueTtlMinutes: 30, maxSessionsPerUser: 3 } as Config,
      policy: { idleMinutes: 0, maxHours: 0 },
      create: async (user: { id: string }, input: { hostId: string; sessionId: string }) => {
        launches++;
        assert.equal(input.sessionId, missing, 'the retry keeps the original session UUID');
        await db.query(
          "INSERT INTO sessions(id,owner_user_id,host_id,profile_id,state) VALUES($1,$2,$3,'android-30','starting')",
          [input.sessionId, user.id, input.hostId],
        );
        return input.sessionId;
      },
    };
    await runQueuePass(deps);
    const recovered = (await db.query('SELECT id,state,session_id,resolved_at FROM queue_entries ORDER BY id')).rows;
    assert.equal(recovered[0]?.state, 'waiting', 'a claimed entry with no session is retried');
    assert.equal(recovered[0]?.session_id, null);
    assert.equal(recovered[1]?.state, 'assigned', 'a committed session keeps its claim');
    assert.ok(recovered[1]?.resolved_at);
    assert.equal((await db.query("SELECT id FROM notifications WHERE kind='queue.assigned'")).rows.length, 1);
    online = true;
    await runQueuePass(deps);
    await runQueuePass(deps);
    assert.equal(launches, 1);
    assert.equal((await db.query('SELECT id FROM sessions')).rows.length, 2);
    assert.equal((await db.query("SELECT id FROM notifications WHERE kind='queue.assigned'")).rows.length, 2);
  } finally { await db.close(); }
});

test('ready and expiring notifications are written once', async () => {
  const db = await database();
  try {
    await seed(db);
    const S1 = 'a0000000-0000-4000-8000-000000000001', S2 = 'a0000000-0000-4000-8000-000000000002';
    await db.query("INSERT INTO sessions(id,owner_user_id,host_id,profile_id,state,started_at,last_activity_at) VALUES($1,$3,'h1','android-30','running',now(),now() - interval '57 minutes')," +
      "($2,$4,'h2','android-30','running',now(),now())", [S1, S2, U1, U2]);
    const pool = { query: db.query.bind(db) } as unknown as Pool;
    const policy = { idleMinutes: 60, maxHours: 0 };
    await Promise.all([notifySessionReady(pool, S1), notifySessionReady(pool, S1), runNotificationPass(pool, policy)]);
    await runNotificationPass(pool, policy);
    const rows = (await db.query('SELECT kind,session_id FROM notifications ORDER BY kind,session_id')).rows as Array<{ kind: string; session_id: string }>;
    assert.deepEqual(rows.map(r => `${r.kind}:${r.session_id.slice(-1)}`), ['session.expiring:1', 'session.ready:1', 'session.ready:2']);
    await db.query("UPDATE sessions SET last_activity_at=now() - interval '58 minutes' WHERE id=$1", [S1]);
    await runNotificationPass(pool, policy);
    assert.equal((await db.query("SELECT 1 FROM notifications WHERE kind='session.expiring'")).rows.length, 1, 'still the same warning');
  } finally { await db.close(); }
});

test('queue API: join, limit of three, position, cancel, ownership', async () => {
  const db = await database();
  let actor = U1;
  let server: ReturnType<typeof createServer> | null = null;
  try {
    await seed(db);
    const client = { query: db.query.bind(db), release: () => {} };
    const pool = { query: db.query.bind(db), connect: async () => client } as unknown as Pool;
    const auth = { authenticate: async () => ({ user: { id: actor, username: actor, displayName: actor, role: 'user', provider: 'local' }, via: 'cookie' }) } as unknown as AuthService;
    const hub = { hasAgent: () => true, onSessionClosed: () => {} } as unknown as AgentHub;
    const config = { maxSessionsPerUser: 3, idleTimeoutMinutes: 0, maxSessionHours: 0, queueTtlMinutes: 30, webhookAllowHttp: false, webhookAllowPrivate: false } as Config;
    const context = createServerContext(pool, config, auth, undefined, hub);
    const app = express();
    app.use(express.json());
    registerQueueRoutes(app, context, { startDispatcher: false });
    app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      if (error instanceof ApiError) res.status(error.status).json({ error: { code: error.code, message: error.message } });
      else { console.error(error); res.status(500).json({ error: { code: 'internal_error' } }); }
    });
    server = createServer(app);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const send = (path: string, method: string, body?: unknown) => fetch(`http://127.0.0.1:${address.port}${path}`, {
      method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
    });
    actor = U2;
    assert.equal((await send('/api/queue', 'POST', { profileId: 'android-30', hostId: 'h1' })).status, 201);
    actor = U1;
    assert.equal((await send('/api/queue', 'POST', { profileId: 'android-30', hostId: 'h1', label: 'x'.repeat(60) })).status, 201);
    assert.equal((await send('/api/queue', 'POST', { profileId: 'android-30' })).status, 201);
    assert.equal((await send('/api/queue', 'POST', { profileId: 'android-30' })).status, 201);
    const fourth = await send('/api/queue', 'POST', { profileId: 'android-30' });
    assert.equal(fourth.status, 409);
    assert.equal(((await fourth.json()) as { error: { code: string } }).error.code, 'queue_full');
    assert.equal((await send('/api/queue', 'POST', { profileId: 'nope' })).status, 404);
    assert.equal((await send('/api/queue', 'POST', { profileId: 'android-30', hostId: 'missing' })).status, 404);
    assert.equal((await send('/api/queue', 'POST', { hostId: 'h1' })).status, 400);
    assert.equal((await send('/api/queue', 'POST', { profileId: 'android-30', label: 'x'.repeat(61) })).status, 400);
    const list = await (await send('/api/queue', 'GET')).json() as { entries: Array<{ id: string; position: number; label: string | null }> };
    assert.equal(list.entries.length, 3);
    assert.deepEqual(list.entries.map(e => e.position), [2, 3, 4], 'U2 is first on h1; any-host entries wait behind earlier entries');
    actor = U3;
    assert.equal((await send(`/api/queue/${list.entries[0]!.id}`, 'DELETE')).status, 404, 'foreign entries answer 404');
    actor = U1;
    assert.equal((await send(`/api/queue/${list.entries[0]!.id}`, 'DELETE')).status, 200);
    assert.equal((await send(`/api/queue/${list.entries[0]!.id}`, 'DELETE')).status, 200, 'cancellation retries are idempotent');
    const actions = (await db.query("SELECT action FROM audit_events WHERE action LIKE 'queue.%' ORDER BY id")).rows.map((r: any) => r.action);
    assert.deepEqual(actions, ['queue.joined', 'queue.joined', 'queue.joined', 'queue.joined', 'queue.cancelled']);
  } finally {
    if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
    await db.close();
  }
});


async function queueFixture() {
  const db = await database();
  await seed(db);
  let actor = U1;
  const client = { query: db.query.bind(db), release: () => {} };
  const pool = { query: db.query.bind(db), connect: async () => client } as unknown as Pool;
  const auth = { authenticate: async () => ({ user: { id: actor, username: actor, displayName: actor, role: 'user', provider: 'local' }, via: 'cookie' }) } as unknown as AuthService;
  const hub = { hasAgent: () => true, onSessionClosed: () => {} } as unknown as AgentHub;
  const config = { maxSessionsPerUser: 3, idleTimeoutMinutes: 0, maxSessionHours: 0, queueTtlMinutes: 30 } as Config;
  const app = express(); app.use(express.json());
  registerQueueRoutes(app, createServerContext(pool, config, auth, undefined, hub), { startDispatcher: false });
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(error instanceof ApiError ? error.status : 500).json({ error: { code: error instanceof ApiError ? error.code : 'internal_error', message: String(error) } });
  });
  const server = createServer(app); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const send = (method: string, path = '/api/queue', body?: unknown, key?: string) => fetch(`http://127.0.0.1:${address.port}${path}`, {
    method, headers: { 'Content-Type': 'application/json', ...(key === undefined ? {} : { 'Idempotency-Key': key }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { db, pool, hub, config, send, as: (id: string) => { actor = id; }, close: async () => {
    await new Promise<void>(resolve => server.close(() => resolve())); await db.close();
  } };
}

test('queue fixes the chosen ADB key at enqueue, checks its ownership, and carries lease options to assignment', async () => {
  const f = await queueFixture();
  try {
    const K1 = 'a0000000-0000-4000-8000-000000000001', K2 = 'a0000000-0000-4000-8000-000000000002';
    await f.db.query(`INSERT INTO user_adb_public_keys(id,owner_user_id,name,public_key,fingerprint)
      VALUES($1,$3,'First','public-1',$5),($2,$4,'Second','public-2',$6)`, [K1,K2,U1,U2,'a'.repeat(64),'b'.repeat(64)]);
    await f.db.query('INSERT INTO user_preferences(user_id,default_adb_key_id) VALUES($1,$2)', [U1,K1]);
    const invalid = await f.send('POST','/api/queue',{ profileId:'android-30', adbKeyId:K2 });
    assert.equal(invalid.status,404); assert.equal((await invalid.json()).error.code,'adb_key_not_found');
    assert.equal((await f.send('POST','/api/queue',{profileId:'android-30',adbKeyId:'bad'})).status,400);
    const response = await f.send('POST','/api/queue',{profileId:'android-30',leaseTtlSeconds:90});
    assert.equal(response.status,201,await response.clone().text());
    const queued = await response.json(); assert.equal(queued.adbKeyId,K1); assert.equal(queued.leaseTtlSeconds,90);
    await f.db.query('UPDATE user_preferences SET default_adb_key_id=NULL WHERE user_id=$1',[U1]);
    const explicit = await f.send('POST','/api/queue',{profileId:'android-30',adbKeyId:K1});
    assert.equal(explicit.status,201); assert.equal((await explicit.json()).adbKeyId,K1);
    const seen: Array<{adbKeyId?:string|null;leaseTtlSeconds?:number}> = [];
    await runQueuePass({ ...f, policy:{idleMinutes:0,maxHours:0}, create:async(user,input)=>{
      seen.push(input);
      await f.db.query("INSERT INTO sessions(id,owner_user_id,host_id,profile_id,state) VALUES($1,$2,$3,$4,'starting')",[input.sessionId,user.id,input.hostId,input.profileId]);
      return input.sessionId;
    } });
    assert.equal(seen.length,2); assert.equal(seen[0]?.adbKeyId,K1); assert.equal(seen[0]?.leaseTtlSeconds,90);
    const assigned=await (await f.send('GET','/api/queue/'+queued.id)).json();
    assert.equal(assigned.state,'assigned'); assert.equal(assigned.sessionId,queued.id); assert.equal(assigned.sessionState,'starting');
    f.as(U2); assert.equal((await f.send('GET','/api/queue/'+queued.id)).status,404);
    assert.equal((await f.send('DELETE','/api/queue/'+queued.id)).status,404);
  } finally { await f.close(); }
});

test('queue retries reuse one request, reject changed parameters, and preserve the completed result', async () => {
  const f=await queueFixture();
  try {
    await f.db.query("UPDATE profiles SET disk_max_gb=32,sdcard_max_gb=4 WHERE id='android-30'");
    const body={profileId:'android-30',leaseTtlSeconds:120,launchOptions:{diskGb:32,sdCardMb:2048,emulatorParams:'-no-snapshot'}};
    const first=await f.send('POST','/api/queue',body,'ci:build-42'); assert.equal(first.status,201);
    const entry=await first.json();
    const repeat=await f.send('POST','/api/queue',body,'ci:build-42'); assert.equal(repeat.status,200); assert.equal((await repeat.json()).id,entry.id);
    const alias=await f.send('POST','/api/queue',{profileId:body.profileId,leaseTtlSeconds:120,diskGb:32,sdcardGb:2,launchOptions:{emulatorParams:'-no-snapshot'}},'ci:build-42'); assert.equal(alias.status,200); assert.equal((await alias.json()).id,entry.id);
    const conflict=await f.send('POST','/api/queue',{...body,leaseTtlSeconds:180},'ci:build-42');
    assert.equal(conflict.status,409); assert.equal((await conflict.json()).error.code,'idempotency_conflict');
    const optionsConflict=await f.send('POST','/api/queue',{...body,launchOptions:{...body.launchOptions,sdCardMb:0}},'ci:build-42');
    assert.equal(optionsConflict.status,409);assert.equal((await optionsConflict.json()).error.code,'idempotency_conflict');
    assert.deepEqual(entry.launchOptions,{...body.launchOptions,cpu:4,memoryMb:6144,guestCores:null,guestMemoryMb:null});
    assert.equal((await f.send('POST','/api/queue',body,'bad key')).status,400);
    assert.equal((await f.send('POST','/api/queue',{...body,leaseTtlSeconds:0})).status,400);
    assert.equal((await f.send('POST','/api/queue',{...body,leaseTtlSeconds:3601})).status,400);
    const cancelled=await f.send('DELETE','/api/queue/'+entry.id); assert.equal(cancelled.status,200); assert.equal((await cancelled.json()).state,'cancelled');
    assert.equal((await f.send('DELETE','/api/queue/'+entry.id)).status,200);
    const completed=await f.send('POST','/api/queue',body,'ci:build-42'); assert.equal(completed.status,200); assert.equal((await completed.json()).state,'cancelled');
    f.as(U2); const other=await f.send('POST','/api/queue',body,'ci:build-42'); assert.equal(other.status,201); assert.notEqual((await other.json()).id,entry.id);
    assert.equal((await f.db.query('SELECT id FROM queue_entries')).rows.length,2);
  } finally {await f.close();}
});

test('cancellation during assignment returns the stable session id instead of losing an allocated device', async () => {
  const f=await queueFixture();
  try {
    const queued=await (await f.send('POST','/api/queue',{profileId:'android-30'})).json();
    let entered!:()=>void; const assigning=new Promise<void>(resolve=>{entered=resolve;});
    let resume!:()=>void; const proceed=new Promise<void>(resolve=>{resume=resolve;});
    const pass=runQueuePass({...f,policy:{idleMinutes:0,maxHours:0},create:async(user,input)=>{
      entered(); await proceed;
      await f.db.query("INSERT INTO sessions(id,owner_user_id,host_id,profile_id,state) VALUES($1,$2,$3,$4,'starting')",[input.sessionId,user.id,input.hostId,input.profileId]);
      return input.sessionId;
    }});
    await assigning;
    try {
      const during=await (await f.send('GET','/api/queue/'+queued.id)).json();
      assert.equal(during.state,'assigning'); assert.equal(during.sessionId,queued.id); assert.equal(during.sessionState,null);
      const cancel=await f.send('DELETE','/api/queue/'+queued.id); assert.equal(cancel.status,409);
      const result=await cancel.json(); assert.equal(result.error.code,'queue_already_assigned'); assert.equal(result.entry.sessionId,queued.id);
    } finally {resume();await pass;}
    const after=await (await f.send('GET','/api/queue/'+queued.id)).json();assert.equal(after.state,'assigned');assert.equal(after.sessionId,queued.id);
    await f.db.query('DELETE FROM sessions WHERE id=$1',[queued.id]);
    const released=await (await f.send('GET','/api/queue/'+queued.id)).json();assert.equal(released.sessionState,'released');assert.equal(released.sessionId,queued.id);
    await f.db.query("UPDATE queue_entries SET claimed_at=now()-interval '3 minutes',resolved_at=NULL WHERE id=$1",[queued.id]);
    let unexpected=0;await runQueuePass({...f,policy:{idleMinutes:0,maxHours:0},create:async()=>{unexpected++;return 'unexpected';}});
    assert.equal(unexpected,0,'a released session in rental history must never be launched again after a crash');
    const final=await (await f.send('GET','/api/queue/'+queued.id)).json();assert.equal(final.state,'assigned');assert.equal(final.sessionState,'released');
  } finally {await f.close();}
});


test('queued storage snapshots preserve defaults and cancel when profile limits are reduced', async () => {
  const f = await queueFixture();
  try {
    await f.db.query("UPDATE profiles SET disk_max_gb=32,sdcard_gb=2,sdcard_max_gb=4 WHERE id='android-30'");
    const response = await f.send('POST', '/api/queue', { profileId: 'android-30', launchOptions: { diskGb: 24, sdCardMb: 129 } });
    assert.equal(response.status, 201); const entry = await response.json();
    assert.equal(entry.launchOptions.sdCardMb, 129); assert.equal(entry.sdcardGb, 129 / 1024);
    await f.db.query("UPDATE profiles SET disk_max_gb=16,sdcard_gb=NULL WHERE id='android-30'");
    await runQueuePass({ ...f, policy: { idleMinutes: 0, maxHours: 0 } });
    const saved = (await f.db.query('SELECT state,error_code,launch_options FROM queue_entries WHERE id=$1', [entry.id])).rows[0];
    assert.equal(saved?.state, 'cancelled'); assert.equal(saved?.error_code, 'storage_out_of_range');
    assert.equal((saved?.launch_options as { sdCardMb: number }).sdCardMb, 129);
  } finally { await f.close(); }
});
