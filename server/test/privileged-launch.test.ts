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
  await db.query("INSERT INTO users(id,provider,subject,username,display_name,role) VALUES($1,'local','qa','qa','QA','user')", [OWNER]);
  await db.query("INSERT INTO profiles(id,name,android_version,image,cpu,memory_mb,disk_gb) VALUES('test-profile','Test','11',$1,2,4096,16)", [IMAGE]);
  await db.query(`INSERT INTO hosts(id,name,slots,status,last_seen_at,manual_slots,slot_cpu,slot_memory_mb,metrics) VALUES
    ('a-default','Default',8,'online',now(),8,4,4096,'{}'),
    ('z-allowed','Allowed',8,'online',now(),8,4,4096,'{"privilegedEmulatorsAllowed":true}')`);
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
  const request = (path: string, body: unknown) => fetch('http://127.0.0.1:' + address.port + '/api/' + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const as = async (value: string) => { role = value; await db.query('UPDATE users SET role=$2 WHERE id=$1', [OWNER, value]); };
  const dispatch = () => runQueuePass({ pool, hub, config, policy: { idleMinutes: 0, maxHours: 0 } });
  const close = async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await db.close(); };
  return { db, request, launches, as, dispatch, close, context };
}
const options = { privileged: true, diskGb: 16, sdCardMb: 0 };
const start = { hostId: 'z-allowed', profileId: 'test-profile', launchOptions: options };

test('privileged containers require both administrator access and node opt-in across launch and queue', async () => {
  const f = await fixture();
  try {
    for (const [path, body] of [['sessions', start], ['queue', start]] as const) {
      const rejected = await f.request(path, body); assert.equal(rejected.status, 403); assert.equal((await rejected.json()).error.code, 'privileged_launch_forbidden');
    }
    assert.equal(f.launches.length, 0);
    const regular = await f.request('sessions', { ...start, hostId: 'a-default', launchOptions: { privileged: false } });
    assert.equal(regular.status, 202); assert.equal(Object.hasOwn(f.launches[0]?.profile ?? {}, 'privileged'), false);
    await f.as('admin');
    for (const path of ['sessions', 'queue']) {
      const rejected = await f.request(path, { ...start, hostId: 'a-default' });
      assert.equal(rejected.status, 409); assert.equal((await rejected.json()).error.code, 'privileged_launch_unavailable');
    }
    const allowed = await f.request('sessions', start); assert.equal(allowed.status, 202, await allowed.clone().text());
    const session = (await allowed.json()).session;
    assert.deepEqual(session.launchOptions, { ...options, cpu: 2, memoryMb: 4096, guestCores: null, guestMemoryMb: null, emulatorParams: '' }); assert.equal(f.launches[1]?.profile.privileged, true);
    await assert.rejects(createSession(f.context, { id: OWNER, role: 'admin' }, { ...start, sessionId: session.id, launchOptions: { privileged: false } }), (error: unknown) => error instanceof ApiError && error.code === 'session_conflict');
    await f.as('user');
    const reused = await f.request('sessions', { ...start, launchOptions: options });
    assert.equal(reused.status, 403); assert.equal(f.launches.length, 2);
  } finally { await f.close(); }
});

test('queued privileged launches select opted-in nodes and recheck user role and node policy at assignment', async () => {
  const f = await fixture();
  try {
    await f.as('admin');
    const queued = await f.request('queue', { profileId: start.profileId, launchOptions: options });
    assert.equal(queued.status, 201); const entry = await queued.json(); assert.deepEqual(entry.launchOptions, { ...options, cpu: 2, memoryMb: 4096, guestCores: null, guestMemoryMb: null, emulatorParams: '' });
    await f.dispatch(); assert.equal(f.launches.length, 1); assert.equal(f.launches[0]?.host, 'z-allowed'); assert.equal(f.launches[0]?.profile.privileged, true);
    const demoted = await f.request('queue', { profileId: start.profileId, launchOptions: options }); assert.equal(demoted.status, 201); const demotedEntry = await demoted.json();
    await f.as('user'); await f.dispatch();
    const cancelled = (await f.db.query<{ state: string; error_code: string }>('SELECT state,error_code FROM queue_entries WHERE id=$1', [demotedEntry.id])).rows[0];
    assert.equal(cancelled?.state, 'cancelled'); assert.equal(cancelled?.error_code, 'privileged_launch_forbidden'); assert.equal(f.launches.length, 1);
    await f.as('admin');
    const changed = await f.request('queue', { profileId: start.profileId, launchOptions: options }); assert.equal(changed.status, 201); const changedEntry = await changed.json();
    await f.db.query("UPDATE hosts SET metrics='{}' WHERE id='z-allowed'"); await f.dispatch();
    assert.equal(f.launches.length, 1); assert.equal((await f.db.query<{ state: string }>('SELECT state FROM queue_entries WHERE id=$1', [changedEntry.id])).rows[0]?.state, 'waiting');
    await f.db.query(`UPDATE hosts SET metrics='{"privilegedEmulatorsAllowed":true}' WHERE id='z-allowed'`); await f.dispatch();
    assert.equal(f.launches.length, 2); assert.equal(f.launches[1]?.host, 'z-allowed');
  } finally { await f.close(); }
});
