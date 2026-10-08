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
import type { AdbPortBroker } from '../src/adb-port.js';
import { ApiError } from '../src/http-common.js';
import { createServerContext } from '../src/server-context.js';
import { registerAdbPortRoutes } from '../src/routes/adb-port-routes.js';
import { registerSessionRoutes } from '../src/routes/session-routes.js';

test('ADB key API returns the secret once, revokes old port on rotation, and accepts the replacement', async () => {
  const database = new PGlite();
  const userId = '11111111-1111-4111-8111-111111111111';
  const otherUserId = '33333333-3333-4333-8333-333333333333';
  let actorId = userId;
  const sessionId = '22222222-2222-4222-8222-222222222222';
  const closed: string[] = [];
  let server: ReturnType<typeof createServer> | null = null;
  try {
    await database.exec(await readFile(new URL('../migrations/001_init.sql', import.meta.url), 'utf8'));
    await database.exec(await readFile(new URL('../migrations/005_host_settings.sql', import.meta.url), 'utf8'));
    await database.exec(await readFile(new URL('../migrations/006_adb_port_access.sql', import.meta.url), 'utf8'));
    await database.exec(await readFile(new URL('../migrations/008_user_adb_keys.sql', import.meta.url), 'utf8'));
    await database.exec(await readFile(new URL('../migrations/009_uploaded_adb_public_keys.sql', import.meta.url), 'utf8'));
    await database.exec(await readFile(new URL('../migrations/010_user_settings_audit.sql', import.meta.url), 'utf8'));
    await database.exec(await readFile(new URL('../migrations/011_node_management.sql', import.meta.url), 'utf8'));
    await database.exec(await readFile(new URL('../migrations/012_session_lifecycle.sql', import.meta.url), 'utf8'));
    await database.exec(await readFile(new URL('../migrations/018_teams.sql', import.meta.url), 'utf8'));
    for (const file of ['002_gpu_mode.sql', '004_guest_resources.sql', '013_queue_notifications.sql', '020_profile_metadata.sql', '021_profile_gpu_variants.sql', '022_profile_gpu_memory.sql', '026_session_startup_progress.sql', '029_storage_limits.sql', '038_profile_secrets_docker_options.sql', '025_physical_devices.sql', '023_user_profile_presets.sql', '030_preset_storage.sql', '033_launch_options.sql', '040_emulator_image_registry.sql', '046_session_diagnostics.sql', '048_user_removal.sql', '049_access_roles.sql']) {
      await database.exec(await readFile(new URL('../migrations/' + file, import.meta.url), 'utf8'));
    }
    await database.query(
      "INSERT INTO users(id,provider,subject,username,display_name) VALUES($1,'local','owner','owner','Owner')",
      [userId],
    );
    await database.query(
      "INSERT INTO users(id,provider,subject,username,display_name) VALUES($1,'local','other','other','Other')",
      [otherUserId],
    );
    await database.query("INSERT INTO hosts(id,name,slots) VALUES('host-1','Host',1)");
    await database.query(
      "INSERT INTO sessions(id,owner_user_id,host_id,profile_id,state) VALUES($1,$2,'host-1','android-30','running')",
      [sessionId, userId],
    );
    const client = { query: database.query.bind(database), release: () => {} };
    const pool = { query: database.query.bind(database), connect: async () => client } as unknown as Pool;
    const config = { adbPorts: { host: '127.0.0.1', start: 15555, count: 2 } } as Config;
    const auth = { authenticate: async () => ({ user: {
      id: actorId, username: 'owner', displayName: 'Owner', role: 'user', provider: 'local',
    }, via: 'cookie' }) } as unknown as AuthService;
    const hub = { hasAgent: () => true, command: async () => ({ containerId: 'mock' }),
      refreshStream: () => {} } as unknown as AgentHub;
    const context = createServerContext(pool, config, auth, undefined, hub);
    const broker = { closeSession: (id: string) => closed.push(id) } as unknown as AdbPortBroker;
    const app = express();
    app.use(express.json());
    registerSessionRoutes(app, context);
    registerAdbPortRoutes(app, context, broker);
    app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      if (error instanceof ApiError) res.status(error.status).json({ code: error.code });
      else { console.error(error); res.status(500).json({ code: 'internal_error' }); }
    });
    server = createServer(app);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const base = 'http://127.0.0.1:' + address.port;
    const request = (path: string, method = 'GET') => fetch(base + path, {
      method, headers: method === 'GET' ? undefined : { 'Content-Type': 'application/json' },
      body: method === 'GET' ? undefined : '{}',
    });

    const missing = await request('/api/me/adb-key');
    assert.deepEqual(await missing.json(), { key: null });
    const created = await request('/api/me/adb-key', 'POST');
    assert.equal(created.status, 201);
    assert.match(created.headers.get('cache-control') || '', /no-store/);
    const first = await created.json() as { privateKey: string; publicKey: string; fingerprint: string };
    assert.match(first.privateKey, /BEGIN PRIVATE KEY/);
    assert.match(first.publicKey, /rdf@farm/);
    const metadata = await request('/api/me/adb-key');
    const info = await metadata.json() as Record<string, unknown>;
    assert.equal(JSON.stringify(info).includes('PRIVATE KEY'), false);
    assert.equal((info.key as Record<string, unknown>).fingerprint, first.fingerprint);
    const duplicate = await request('/api/me/adb-key', 'POST');
    assert.equal(duplicate.status, 409);
    const opened = await request('/api/sessions/' + sessionId + '/adb-port-access', 'POST');
    assert.equal(opened.status, 201);
    const firstPort = await opened.json() as { port: number; expiresAt: string | null; fingerprint: string };
    assert.equal(firstPort.port, 15555);
    assert.equal(firstPort.expiresAt, null);
    assert.equal(firstPort.fingerprint, first.fingerprint);
    const repeated = await request('/api/sessions/' + sessionId + '/adb-port-access', 'POST');
    assert.equal((await repeated.json() as { port: number }).port, 15555);
    assert.deepEqual(closed, [sessionId]);

    const rotated = await request('/api/me/adb-key/rotate', 'POST');
    assert.equal(rotated.status, 201);
    const replacement = await rotated.json() as { privateKey: string; fingerprint: string };
    assert.notEqual(replacement.fingerprint, first.fingerprint);
    assert.deepEqual(closed, [sessionId, sessionId]);
    const afterRotation = await request('/api/sessions/' + sessionId + '/adb-port-access');
    assert.deepEqual(await afterRotation.json(), { access: null });
    const reopened = await request('/api/sessions/' + sessionId + '/adb-port-access', 'POST');
    assert.equal(reopened.status, 201);
    assert.equal((await reopened.json() as { fingerprint: string }).fingerprint, replacement.fingerprint);
    await database.query("UPDATE hosts SET status='online',slots=2,manual_slots=2,last_seen_at=now() WHERE id='host-1'");
    await database.query(
      "INSERT INTO host_slots(host_id,slot_index,session_id) VALUES('host-1',0,$1),('host-1',1,NULL)",
      [sessionId],
    );
    const nextSession = await fetch(base + '/api/sessions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hostId: 'host-1', profileId: 'android-30' }),
    });
    assert.equal(nextSession.status, 202);
    const createdSession = await nextSession.json() as { session: { id: string } };
    const autoLease = await database.query<{ owner_user_id: string; fingerprint: string; expires_at: Date | null }>(
      'SELECT owner_user_id,fingerprint,expires_at FROM adb_port_access WHERE session_id=$1',
      [createdSession.session.id],
    );
    assert.equal(autoLease.rows[0]?.owner_user_id, userId);
    assert.equal(autoLease.rows[0]?.fingerprint, replacement.fingerprint);
    assert.equal(autoLease.rows[0]?.expires_at, null);
    actorId = otherUserId;
    const hidden = await request('/api/sessions/' + sessionId + '/adb-port-access');
    assert.equal(hidden.status, 404);
    const forbiddenOpen = await request('/api/sessions/' + sessionId + '/adb-port-access', 'POST');
    assert.equal(forbiddenOpen.status, 404);
    assert.deepEqual(await (await request('/api/me/adb-key')).json(), { key: null });
  } finally {
    if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
    await database.close();
  }
});
