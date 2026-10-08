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

test('logcat and device information are served to the session owner only', async () => {
  const database = new PGlite();
  const ownerId = '11111111-1111-4111-8111-111111111111';
  const otherId = '33333333-3333-4333-8333-333333333333';
  const sessionId = '22222222-2222-4222-8222-222222222222';
  let actorId = ownerId;
  const commands: Array<{ action: string; params: Record<string, unknown> }> = [];
  let server: ReturnType<typeof createServer> | null = null;
  try {
    for (const file of ['001_init', '002_gpu_mode', '003_default_profile_resources', '004_guest_resources', '005_host_settings', '006_adb_port_access', '008_user_adb_keys',
      '009_uploaded_adb_public_keys', '010_user_settings_audit', '011_node_management', '013_queue_notifications', '029_storage_limits', '038_profile_secrets_docker_options']) {
      await database.exec(await readFile(new URL(`../migrations/${file}.sql`, import.meta.url), 'utf8'));
    }
    await database.query("INSERT INTO users(id,provider,subject,username,display_name) VALUES($1,'local','owner','owner','Owner')", [ownerId]);
    await database.query("INSERT INTO users(id,provider,subject,username,display_name) VALUES($1,'local','other','other','Other')", [otherId]);
    await database.query("INSERT INTO hosts(id,name,slots) VALUES('host-1','Host',1)");
    await database.query("INSERT INTO sessions(id,owner_user_id,host_id,profile_id,state) VALUES($1,$2,'host-1','android-30','running')", [sessionId, ownerId]);
    const client = { query: database.query.bind(database), release: () => {} };
    const pool = { query: database.query.bind(database), connect: async () => client } as unknown as Pool;
    const auth = { authenticate: async () => ({ user: {
      id: actorId, username: 'owner', displayName: 'Owner', role: 'user', provider: 'local',
    }, via: 'cookie' }) } as unknown as AuthService;
    const hub = {
      hasAgent: () => true,
      command: async (_host: string, _session: string, action: string, params: Record<string, unknown>) => {
        commands.push({ action, params });
        if (action === 'logcat') return { entries: [{ ts: '10-02 20:57:22.101', pid: 1, tid: 1, level: 'E', tag: 'T', message: 'boom' }], cursor: { since: '10-02 20:57:22.101', skip: 1 } };
        if (action === 'logcat-apps') return { apps: [{ packageName: 'com.example.app', uid: 10123 }] };
        if (action === 'device-info') return { device: { model: 'Pixel' }, android: { sdk: 30 } };
        return {};
      },
    } as unknown as AgentHub;
    const context = createServerContext(pool, {} as Config, auth, undefined, hub);
    const app = express();
    app.use(express.json());
    registerSessionRoutes(app, context);
    app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      if (error instanceof ApiError) res.status(error.status).json({ code: error.code });
      else { console.error(error); res.status(500).json({ code: 'internal_error' }); }
    });
    server = createServer(app);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const base = 'http://127.0.0.1:' + address.port + '/api/sessions/' + sessionId;

    const logs = await fetch(base + '/logcat?level=W&lines=200&buffers=main,crash&since=10-02%2020:57:22.101&skip=1');
    assert.equal(logs.status, 200);
    const body = await logs.json() as { entries: Array<{ message: string }>; cursor: { skip: number } };
    assert.equal(body.entries[0]?.message, 'boom');
    assert.equal(body.cursor.skip, 1);
    assert.deepEqual(commands[0], { action: 'logcat', params: {
      lines: 200, minLevel: 'W', buffers: ['main', 'crash'], since: '10-02 20:57:22.101', skip: 1,
    } });

    for (const bad of ['level=X', 'lines=0', 'lines=9999', 'buffers=main;reboot', 'since=now', 'buffers=main,main', 'packageName=com.app%3Breboot', 'packageName=-x', 'packageName=bad', 'packageName[uid]=1', 'packageName=com.a&packageName=com.b']) {
      assert.equal((await fetch(base + '/logcat?' + bad)).status, 400, bad);
    }
    assert.equal(commands.length, 1, 'invalid queries never reach the agent');

    assert.equal((await fetch(base + '/logcat/clear', { method: 'POST' })).status, 200);
    assert.equal(commands[1]?.action, 'logcat-clear');

    const info = await (await fetch(base + '/device-info')).json() as {
      device: { model: string }; profile: { id: string; image: string } | null; session: { id: string; hostName: string };
    };
    assert.equal(info.device.model, 'Pixel');
    assert.equal(info.profile?.id, 'android-30');
    assert.equal(info.session.id, sessionId);

    const apps = await (await fetch(base + '/logcat/apps')).json() as { apps: Array<{ packageName: string }> };
    assert.equal(apps.apps[0]?.packageName, 'com.example.app');
    assert.equal((await fetch(base + '/logcat?packageName=com.example.app')).status, 200);
    assert.deepEqual(commands[4], { action: 'logcat', params: { packageName: 'com.example.app' } });
    actorId = otherId;
    assert.equal((await fetch(base + '/logcat')).status, 404);
    assert.equal((await fetch(base + '/device-info')).status, 404);
    assert.equal((await fetch(base + '/logcat/apps')).status, 404);
    assert.equal((await fetch(base + '/logcat?packageName=com.example.app')).status, 404);
    assert.equal(commands.length, 5);
  } finally {
    if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
    await database.close();
  }
});

test('an administrator opening another user session is audited once per window and shown to the owner', async () => {
  const { shouldRecordAdminAccess } = await import('../src/server-context.js');
  const seen = new Map<string, number>();
  assert.equal(shouldRecordAdminAccess('a', 's', 0, seen), true);
  assert.equal(shouldRecordAdminAccess('a', 's', 5 * 60_000, seen), false);
  assert.equal(shouldRecordAdminAccess('b', 's', 5 * 60_000, seen), true);
  assert.equal(shouldRecordAdminAccess('a', 's', 11 * 60_000, seen), true);

  const database = new PGlite();
  const ownerId = '11111111-1111-4111-8111-111111111111';
  const adminId = '44444444-4444-4444-8444-444444444444';
  const sessionId = '22222222-2222-4222-8222-222222222222';
  let actorId = adminId;
  let server: ReturnType<typeof createServer> | null = null;
  try {
    for (const file of ['001_init', '002_gpu_mode', '003_default_profile_resources', '004_guest_resources', '005_host_settings',
      '006_adb_port_access', '008_user_adb_keys', '009_uploaded_adb_public_keys', '010_user_settings_audit', '011_node_management', '013_queue_notifications', '029_storage_limits', '038_profile_secrets_docker_options']) {
      await database.exec(await readFile(new URL(`../migrations/${file}.sql`, import.meta.url), 'utf8'));
    }
    await database.query("INSERT INTO users(id,provider,subject,username,display_name) VALUES($1,'local','owner','owner','Owner')", [ownerId]);
    await database.query("INSERT INTO users(id,provider,subject,username,display_name,role) VALUES($1,'local','root','root','Root','admin')", [adminId]);
    await database.query("INSERT INTO hosts(id,name,slots) VALUES('host-1','Host',1)");
    await database.query("INSERT INTO sessions(id,owner_user_id,host_id,profile_id,state) VALUES($1,$2,'host-1','android-30','running')", [sessionId, ownerId]);
    const client = { query: database.query.bind(database), release: () => {} };
    const pool = { query: database.query.bind(database), connect: async () => client } as unknown as Pool;
    const auth = { authenticate: async () => ({ user: actorId === adminId
      ? { id: adminId, username: 'root', displayName: 'Root', role: 'admin', provider: 'local' }
      : { id: ownerId, username: 'owner', displayName: 'Owner', role: 'user', provider: 'local' }, via: 'cookie' }) } as unknown as AuthService;
    const hub = { hasAgent: () => true, command: async () => ({}) } as unknown as AgentHub;
    const context = createServerContext(pool, {} as Config, auth, undefined, hub);
    const app = express();
    app.use(express.json());
    registerSessionRoutes(app, context);
    server = createServer(app);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const url = 'http://127.0.0.1:' + address.port + '/api/sessions/' + sessionId;

    assert.equal((await fetch(url)).status, 200);
    await new Promise(resolve => setTimeout(resolve, 100));
    const events = await database.query("SELECT actor_username,subject_user_id FROM audit_events WHERE action='session.admin_access'");
    assert.equal(events.rows.length, 1);
    assert.equal(events.rows[0]?.actor_username, 'root');

    actorId = ownerId;
    const seenByOwner = await (await fetch(url)).json() as { session: { adminAccess: { username: string } | null } };
    assert.equal(seenByOwner.session.adminAccess?.username, 'root');
    const eventsAfter = await database.query("SELECT 1 FROM audit_events WHERE action='session.admin_access'");
    assert.equal(eventsAfter.rows.length, 1, 'the owner opening their own session is not an admin access');
  } finally {
    if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
    await database.close();
  }
});
