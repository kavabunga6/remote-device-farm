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
import { envParams, registerEnvRoutes } from '../src/routes/env-routes.js';

const MIGRATIONS = ['001_init', '002_gpu_mode', '003_default_profile_resources', '004_guest_resources', '005_host_settings',
  '006_adb_port_access', '008_user_adb_keys', '009_uploaded_adb_public_keys', '010_user_settings_audit', '011_node_management',
  '012_session_lifecycle', '016_env_tools'];
const OWNER = '11111111-1111-4111-8111-111111111111';
const STRANGER = '22222222-2222-4222-8222-222222222222';
const ADMIN = '44444444-4444-4444-8444-444444444444';
const SESSION = 'a0000000-0000-4000-8000-000000000001';
const STOPPED = 'a0000000-0000-4000-8000-000000000002';

test('params are bounded before they reach the agent', () => {
  assert.deepEqual(envParams(undefined), {});
  assert.deepEqual(envParams({ lat: 1.5, mode: 'yes', enabled: true }), { lat: 1.5, mode: 'yes', enabled: true });
  for (const bad of [[], 'x', { lat: null }, { lat: {} }, { lat: [1] }, { lat: Infinity }, { uri: 'a'.repeat(2001) },
    { a: 1, b: 1, c: 1, d: 1, e: 1, f: 1, g: 1 }, { 'x; id': 1 }]) {
    assert.throws(() => envParams(bad), (error: unknown) => error instanceof ApiError && error.status === 400);
  }
});

test('env API: owner and admin operate, strangers get 404, audit event is written', async () => {
  const db = await PGlite.create();
  let actor = OWNER;
  let server: ReturnType<typeof createServer> | null = null;
  const commands: Array<{ action: string; params: Record<string, unknown> }> = [];
  let agentError: Error | null = null;
  try {
    for (const file of MIGRATIONS) await db.exec(await readFile(new URL(`../migrations/${file}.sql`, import.meta.url), 'utf8'));
    for (const [id, name, role] of [[OWNER, 'owner', 'user'], [STRANGER, 'stranger', 'user'], [ADMIN, 'root', 'admin']]) {
      await db.query('INSERT INTO users(id,provider,subject,username,display_name,role) VALUES($1,$2,$3,$3,$3,$4)', [id, 'local', name, role]);
    }
    await db.query("INSERT INTO hosts(id,name,slots) VALUES('host-1','Host',3)");
    await db.query("INSERT INTO sessions(id,owner_user_id,host_id,profile_id,state) VALUES($1,$3,'host-1','android-30','running'),($2,$3,'host-1','android-30','stopped')", [SESSION, STOPPED, OWNER]);
    const pool = { query: db.query.bind(db) } as unknown as Pool;
    const users: Record<string, { id: string; username: string; displayName: string; role: string; provider: string }> = {
      [OWNER]: { id: OWNER, username: 'owner', displayName: 'owner', role: 'user', provider: 'local' },
      [STRANGER]: { id: STRANGER, username: 'stranger', displayName: 'stranger', role: 'user', provider: 'local' },
      [ADMIN]: { id: ADMIN, username: 'root', displayName: 'root', role: 'admin', provider: 'local' },
    };
    const auth = { authenticate: async () => ({ user: users[actor], via: 'cookie' }) } as unknown as AuthService;
    const hub = { hasAgent: () => true, command: async (_h: string, _s: string, action: string, params: Record<string, unknown>) => {
      commands.push({ action, params });
      if (agentError) throw agentError;
      return params.op === 'read' ? { darkMode: 'no' } : { op: params.op, applied: true };
    } } as unknown as AgentHub;
    const context = createServerContext(pool, { maxSessionsPerUser: 5, idleTimeoutMinutes: 0, maxSessionHours: 0 } as Config, auth, undefined, hub);
    const app = express();
    app.use(express.json());
    registerEnvRoutes(app, context);
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
    const post = (id: string, body: unknown) => fetch(`${base}/api/sessions/${id}/env`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

    const read = await fetch(`${base}/api/sessions/${SESSION}/env`);
    assert.equal(read.status, 200);
    assert.deepEqual(((await read.json()) as { env: { darkMode: string } }).env.darkMode, 'no');

    const applied = await post(SESSION, { op: 'dark_mode', params: { mode: 'yes' } });
    assert.equal(applied.status, 200);
    assert.deepEqual(commands.at(-1), { action: 'env', params: { op: 'dark_mode', params: { mode: 'yes' } } });
    const audit = await db.query("SELECT actor_username,subject_user_id,target_id,detail FROM audit_events WHERE action='session.env_changed'");
    assert.deepEqual(audit.rows, [{ actor_username: 'owner', subject_user_id: OWNER, target_id: SESSION, detail: 'dark_mode' }]);

    // Unknown ops and malformed params never reach the agent.
    const before = commands.length;
    assert.equal((await post(SESSION, { op: 'shell', params: { cmd: 'id' } })).status, 400);
    assert.equal((await post(SESSION, { op: 'read', params: {} })).status, 400);
    for (const op of ['snapshot_save', 'snapshot_load', 'snapshot_delete']) {
      assert.equal((await post(SESSION, { op, params: { name: 'clean' } })).status, 400);
    }
    assert.equal((await post(SESSION, { params: {} })).status, 400);
    assert.equal((await post(SESSION, { op: 'geo', params: [1, 2] })).status, 400);
    assert.equal((await post(SESSION, { op: 'geo', params: { lat: { $ne: 1 } } })).status, 400);
    assert.equal(commands.length, before);
    assert.equal((await db.query("SELECT 1 FROM audit_events WHERE action='session.env_changed'")).rows.length, 1);

    // Agent-side validation errors surface as 422 and write no audit event.
    agentError = new Error('Unsupported time zone');
    const rejected = await post(SESSION, { op: 'timezone', params: { zone: 'Mars/Base' } });
    assert.equal(rejected.status, 422);
    assert.equal(((await rejected.json()) as { error: { code: string; message: string } }).error.message, 'Unsupported time zone');
    agentError = new Error('agent offline');
    assert.equal((await post(SESSION, { op: 'dark_mode', params: { mode: 'no' } })).status, 503);
    agentError = null;
    assert.equal((await db.query("SELECT 1 FROM audit_events WHERE action='session.env_changed'")).rows.length, 1);

    // A stopped session is not active.
    assert.equal((await post(STOPPED, { op: 'dark_mode', params: { mode: 'no' } })).status, 409);

    // Strangers see 404 for both verbs and nothing is sent.
    actor = STRANGER;
    const sent = commands.length;
    assert.equal((await post(SESSION, { op: 'dark_mode', params: { mode: 'no' } })).status, 404);
    assert.equal((await fetch(`${base}/api/sessions/${SESSION}/env`)).status, 404);
    assert.equal(commands.length, sent);

    // Admins may operate on any session; the actor is recorded.
    actor = ADMIN;
    assert.equal((await post(SESSION, { op: 'network', params: { profile: 'edge' } })).status, 200);
    const adminAudit = await db.query("SELECT actor_username,detail FROM audit_events WHERE action='session.env_changed' ORDER BY id DESC LIMIT 1");
    assert.deepEqual(adminAudit.rows, [{ actor_username: 'root', detail: 'network' }]);
  } finally {
    if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
    await db.close();
  }
});
