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
import { installAuditTrail } from '../src/audit.js';
import { generateAdbKeyPair } from '../src/adb-key.js';
import { createServerContext } from '../src/server-context.js';
import { registerAdbPortRoutes } from '../src/routes/adb-port-routes.js';
import { registerSessionRoutes } from '../src/routes/session-routes.js';

test('uploaded ADB public keys stay private to an account and select the broker key at creation', async () => {
  const database = new PGlite();
  const owner = '11111111-1111-4111-8111-111111111111';
  const stranger = '33333333-3333-4333-8333-333333333333';
  const system = '44444444-4444-4444-8444-444444444444';
  let actorId = owner;
  const closed: string[] = [];
  let server: ReturnType<typeof createServer> | null = null;
  try {
    for (const file of ['001_init.sql', '005_host_settings.sql', '006_adb_port_access.sql',
      '008_user_adb_keys.sql', '009_uploaded_adb_public_keys.sql', '010_user_settings_audit.sql', '011_node_management.sql', '012_session_lifecycle.sql', '018_teams.sql',
      '002_gpu_mode.sql', '004_guest_resources.sql', '013_queue_notifications.sql', '020_profile_metadata.sql', '021_profile_gpu_variants.sql', '022_profile_gpu_memory.sql', '026_session_startup_progress.sql', '029_storage_limits.sql', '038_profile_secrets_docker_options.sql', '025_physical_devices.sql', '023_user_profile_presets.sql', '030_preset_storage.sql', '033_launch_options.sql', '040_emulator_image_registry.sql', '046_session_diagnostics.sql', '048_user_removal.sql', '049_access_roles.sql']) {
      await database.exec(await readFile(new URL('../migrations/' + file, import.meta.url), 'utf8'));
    }
    await database.query(
      "INSERT INTO users(id,provider,subject,username,display_name) VALUES " +
      "($1,'local','owner','owner','Owner'),($2,'local','stranger','stranger','Stranger')," +
      "($3,'system','system','system','System administrator')",
      [owner, stranger, system],
    );
    await database.query(
      "INSERT INTO hosts(id,name,status,slots,last_seen_at) VALUES('host-1','Host','online',2,now())",
    );
    await database.query(
      "INSERT INTO host_slots(host_id,slot_index) VALUES('host-1',0),('host-1',1)",
    );
    const client = { query: database.query.bind(database), release: () => {} };
    const pool = { query: database.query.bind(database), connect: async () => client } as unknown as Pool;
    const config = { adbPorts: { host: '127.0.0.1', start: 15555, count: 2 } } as Config;
    const auth = { authenticate: async () => ({ user: {
      id: actorId, username: 'user', displayName: 'User',
      role: actorId === system ? 'admin' : 'user',
      provider: actorId === system ? 'system' : 'local',
    }, via: actorId === system ? 'admin-token' : 'cookie' }) } as unknown as AuthService;
    const hub = { hasAgent: () => true, supportsNodePolicy: () => true,
      command: async () => ({ containerId: 'mock' }),
      refreshStream: () => {} } as unknown as AgentHub;
    const context = createServerContext(pool, config, auth, undefined, hub);
    const broker = { closeSession: (id: string) => closed.push(id) } as unknown as AdbPortBroker;
    const app = express();
    app.use(express.json());
    installAuditTrail(app, pool);
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
    const request = (path: string, method = 'GET', body?: unknown) => fetch(base + path, {
      method, headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    await database.query("UPDATE hosts SET disabled=true WHERE id='host-1'");
    assert.equal((await request('/api/sessions', 'POST',
      { hostId: 'host-1', profileId: 'android-30' })).status, 409);
    await database.query("UPDATE hosts SET disabled=false,removed_at=now() WHERE id='host-1'");
    assert.equal((await request('/api/sessions', 'POST',
      { hostId: 'host-1', profileId: 'android-30' })).status, 409);
    await database.query("UPDATE hosts SET removed_at=NULL,slot_cpu=1 WHERE id='host-1'");
    assert.equal((await request('/api/sessions', 'POST',
      { hostId: 'host-1', profileId: 'android-30' })).status, 409);
    await database.query("UPDATE hosts SET slot_cpu=4,slot_memory_mb=1024 WHERE id='host-1'");
    assert.equal((await request('/api/sessions', 'POST',
      { hostId: 'host-1', profileId: 'android-30' })).status, 409);
    await database.query("UPDATE hosts SET slot_memory_mb=4096,slot_cap=1 WHERE id='host-1'");
    const occupiedId = '55555555-5555-4555-8555-555555555555';
    await database.query(
      "INSERT INTO sessions(id,owner_user_id,host_id,profile_id,state) VALUES($1,$2,'host-1','android-30','running')",
      [occupiedId, owner],
    );
    await database.query(
      "UPDATE host_slots SET session_id=$1 WHERE host_id='host-1' AND slot_index=1", [occupiedId],
    );
    await database.query("UPDATE hosts SET slots=1 WHERE id='host-1'");
    assert.equal((await request('/api/sessions', 'POST',
      { hostId: 'host-1', profileId: 'android-30' })).status, 409);
    await database.query("UPDATE host_slots SET session_id=NULL WHERE host_id='host-1' AND slot_index=1");
    await database.query('DELETE FROM sessions WHERE id=$1', [occupiedId]);
    await database.query("UPDATE hosts SET slots=2 WHERE id='host-1'");

    const farm = await request('/api/me/adb-key', 'POST');
    assert.equal(farm.status, 201);
    const farmKey = await farm.json() as { fingerprint: string };
    const uploaded = await generateAdbKeyPair();
    assert.equal((await request('/api/me/adb-public-keys', 'POST',
      { name: 'Developer laptop', publicKey: uploaded.privateKey })).status, 400);
    const added = await request('/api/me/adb-public-keys', 'POST',
      { name: 'Developer laptop', publicKey: uploaded.publicKey });
    assert.equal(added.status, 201);
    const { key } = await added.json() as { key: { id: string; name: string; fingerprint: string } };
    assert.equal(key.name, 'Developer laptop');
    assert.equal(key.fingerprint, uploaded.fingerprint);
    assert.equal(JSON.stringify(key).includes('publicKey'), false);
    assert.equal((await request('/api/me/adb-public-keys', 'POST',
      { name: 'Duplicate', publicKey: uploaded.publicKey })).status, 409);
    assert.equal((await request('/api/sessions', 'POST',
      { hostId: 'host-1', profileId: 'android-30', adbKeyId: 'farm' })).status, 400);
    await database.query(
      'INSERT INTO user_preferences(user_id,default_adb_key_id) VALUES($1,$2)', [owner, key.id],
    );

    for (const name of [undefined, null, '', '   ', 123, {}, 'x'.repeat(81), 'Bad\nname', 'Bad\u007fname']) {
      const rejected = await request('/api/me/adb-public-keys/' + key.id, 'PATCH', { name });
      assert.equal(rejected.status, 400);
      assert.deepEqual(await rejected.json(), { code: 'invalid_adb_key_name' });
    }
    assert.equal((await request('/api/me/adb-public-keys/not-a-uuid', 'PATCH', { name: 'Laptop' })).status, 404);
    assert.equal((await request('/api/me/adb-public-keys/99999999-9999-4999-8999-999999999999', 'PATCH', { name: 'Laptop' })).status, 404);

    actorId = stranger;
    assert.deepEqual(await (await request('/api/me/adb-public-keys')).json(), { keys: [] });
    assert.equal((await request('/api/me/adb-public-keys/' + key.id, 'DELETE')).status, 404);
    assert.equal((await request('/api/me/adb-public-keys/' + key.id, 'PATCH', { name: 'Not mine' })).status, 404);
    assert.equal((await request('/api/sessions', 'POST',
      { hostId: 'host-1', profileId: 'android-30', adbKeyId: key.id })).status, 404);
    const slots = await database.query<{ total: number }>('SELECT count(*)::integer AS total FROM host_slots WHERE session_id IS NOT NULL');
    assert.equal(slots.rows[0]?.total, 0);

    // System tokens have administrator rights but still cannot select a key
    // owned by another account when they create their own emulator.
    actorId = system;
    assert.deepEqual(await (await request('/api/me/adb-public-keys')).json(), { keys: [] });
    assert.equal((await request('/api/me/adb-public-keys/' + key.id, 'PATCH', { name: 'Not mine either' })).status, 404);
    assert.equal((await request('/api/sessions', 'POST',
      { hostId: 'host-1', profileId: 'android-30', adbKeyId: key.id })).status, 404);
    const systemSlots = await database.query<{ total: number }>(
      'SELECT count(*)::integer AS total FROM host_slots WHERE session_id IS NOT NULL',
    );
    assert.equal(systemSlots.rows[0]?.total, 0);

    actorId = owner;
    const created = await request('/api/sessions', 'POST',
      { hostId: 'host-1', profileId: 'android-30' });
    assert.equal(created.status, 202);
    const { session } = await created.json() as { session: { id: string; adbKeyId: string } };
    assert.equal(session.adbKeyId, key.id);
    const lease = await database.query<{ owner_user_id: string; public_key: string; fingerprint: string }>(
      'SELECT owner_user_id,public_key,fingerprint FROM adb_port_access WHERE session_id=$1',
      [session.id],
    );
    assert.equal(lease.rows[0]?.owner_user_id, owner);
    assert.equal(lease.rows[0]?.public_key, uploaded.publicKey);
    assert.equal(lease.rows[0]?.fingerprint, uploaded.fingerprint);

    const storedBefore = (await database.query('SELECT * FROM user_adb_public_keys WHERE id=$1', [key.id])).rows[0];
    const renamed = await request('/api/me/adb-public-keys/' + key.id, 'PATCH', { name: '  Personal laptop  ', publicKey: 'must not replace the key' });
    assert.equal(renamed.status, 200);
    const updatedKey = (await renamed.json() as { key: { id: string; name: string; fingerprint: string; createdAt: string } }).key;
    assert.deepEqual(updatedKey, { ...key, name: 'Personal laptop' });
    const storedAfter = (await database.query('SELECT * FROM user_adb_public_keys WHERE id=$1', [key.id])).rows[0];
    assert.deepEqual(storedAfter, { ...storedBefore, name: 'Personal laptop' });
    assert.deepEqual(await (await request('/api/me/adb-public-keys')).json(), { keys: [updatedKey] });
    assert.equal((await database.query('SELECT default_adb_key_id FROM user_preferences WHERE user_id=$1', [owner])).rows[0]?.default_adb_key_id, key.id);
    assert.deepEqual((await database.query('SELECT owner_user_id,public_key,fingerprint FROM adb_port_access WHERE session_id=$1', [session.id])).rows, lease.rows);
    const audit = await database.query('SELECT * FROM audit_events WHERE action=$1', ['account.adb_public_key_renamed']);
    assert.ok(audit.rows.some(row => row.actor_user_id === owner && row.outcome === 'success' && row.target_id === key.id));
    assert.ok(audit.rows.some(row => row.actor_user_id === stranger && row.outcome === 'failed'));
    assert.equal(JSON.stringify(audit.rows).includes('Personal laptop'), false);
    assert.deepEqual(closed, []);

    const rotated = await request('/api/me/adb-key/rotate', 'POST');
    assert.equal(rotated.status, 201);
    const rotatedKey = await rotated.json() as { fingerprint: string };
    assert.notEqual(rotatedKey.fingerprint, farmKey.fingerprint);
    assert.deepEqual(closed, []);
    assert.equal((await request('/api/me/adb-public-keys/' + key.id, 'DELETE')).status, 409);
    const reopened = await request('/api/sessions/' + session.id + '/adb-port-access', 'POST', {});
    assert.equal(reopened.status, 201);
    assert.equal((await reopened.json() as { fingerprint: string }).fingerprint, uploaded.fingerprint);
    assert.deepEqual(closed, []);
    const forcedFarm = await request('/api/sessions', 'POST',
      { hostId: 'host-1', profileId: 'android-30', adbKeyId: null });
    assert.equal(forcedFarm.status, 202);
    const farmSession = await forcedFarm.json() as { session: { id: string; adbKeyId: string | null } };
    assert.equal(farmSession.session.adbKeyId, null);
    const farmLease = await database.query<{ fingerprint: string }>(
      'SELECT fingerprint FROM adb_port_access WHERE session_id=$1', [farmSession.session.id],
    );
    assert.equal(farmLease.rows[0]?.fingerprint, rotatedKey.fingerprint);

    await database.query('DELETE FROM sessions WHERE id=$1', [farmSession.session.id]);
    await database.query('DELETE FROM sessions WHERE id=$1', [session.id]);
    const removed = await request('/api/me/adb-public-keys/' + key.id, 'DELETE');
    assert.equal(removed.status, 200);
    assert.deepEqual(await (await request('/api/me/adb-public-keys')).json(), { keys: [] });
    const columns = await database.query<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_name='user_adb_public_keys'",
    );
    assert.equal(columns.rows.some(row => row.column_name === 'private_key'), false);
    for (let index = 0; index < 20; index++) {
      await database.query(
        'INSERT INTO user_adb_public_keys(id,owner_user_id,name,public_key,fingerprint) VALUES($1,$2,$3,$4,$5)',
        ['40000000-0000-4000-8000-' + index.toString(16).padStart(12, '0'),
          owner, 'Key ' + index, uploaded.publicKey, index.toString(16).padStart(64, '0')],
      );
    }
    const overLimit = await request('/api/me/adb-public-keys', 'POST',
      { name: 'Too many', publicKey: uploaded.publicKey });
    assert.equal(overLimit.status, 409);
    assert.deepEqual(await overLimit.json(), { code: 'adb_key_limit' });
  } finally {
    if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
    await database.close();
  }
});
