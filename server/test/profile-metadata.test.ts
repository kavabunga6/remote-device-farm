import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import express from 'express';
import { PGlite } from '@electric-sql/pglite';
import type { Pool } from 'pg';
import { ApiError, parseProfile } from '../src/http-common.js';
import type { ServerContext } from '../src/server-context.js';
import { registerAdminRoutes } from '../src/routes/admin-routes.js';
import { migrate } from '../src/db.js';

const input = { id: 'custom-android', name: 'Custom Android', androidVersion: '15', image: 'us-docker.pkg.dev/android-emulator-268719/images/30-google-x64-no-metrics:30.1.2', cpu: 4, memoryMb: 4096, guestMemoryMb: 2048, guestCores: 2, diskGb: 16, gpuMode: 'software' };

test('optional profile metadata is strictly validated and empty fields stay unknown', () => {
  const legacy = parseProfile(input);
  assert.deepEqual([legacy.apiLevel, legacy.abi, legacy.deviceModel, legacy.resolution], [null, null, null, null]);
  assert.equal(parseProfile({ ...input, resolution: '720 × 1280' }).resolution, '720x1280');
  for (const metadata of [{ apiLevel: true }, { apiLevel: [30] }, { apiLevel: 0 }, { apiLevel: 30.5 }, { apiLevel: 1000 }, { abi: {} }, { abi: 'x86_64; run' }, { deviceModel: 'bad\nmodel' }, { deviceModel: 'x'.repeat(121) }, { resolution: '1280' }, { resolution: '0x720' }, { imageFlavor: ['aosp'] }, { deviceType: ['tv'] }, { recommended: 'true' }, { recommended: 1 }, { recommended: null }]) {
    assert.throws(() => parseProfile({ ...input, ...metadata }), (error: unknown) => error instanceof ApiError && error.code === 'invalid_profile');
  }
});

test('profile GPU fields are ignored and are absent from the parsed profile', () => {
  for (const gpuSupport of ['none', 'cuda', 'gpu', ['cuda']]) {
    const parsed = parseProfile({ ...input, gpuSupport, gpuImage: 'registry.example/alternate:1', gpuMemoryMb: 6144, gpuMode: 'nvidia', gpuBackend: 'cuda' });
    assert.deepEqual(parsed, parseProfile(input));
    assert.equal(parsed.image, input.image);
    assert.equal(parsed.memoryMb, input.memoryMb);
    assert.ok(!Object.keys(parsed).some(key => key.startsWith('gpu')));
  }
  for (const patch of [{ dockerOptions: { gpu: { kind: 'nvidia' } } }, { containerEnv: { GPU_ACCELERATED: 'true' } }]) {
    assert.throws(() => parseProfile({ ...input, ...patch }), (error: unknown) => error instanceof ApiError && error.code === 'invalid_profile');
  }
});

test('profile metadata migrates existing rows safely and round-trips through create, list and patch HTTP routes', async () => {
  const database = new PGlite();
  let server: ReturnType<typeof createServer> | undefined;
  try {
    for (const file of ['001_init.sql', '002_gpu_mode.sql', '004_guest_resources.sql']) await database.exec(await readFile(new URL('../migrations/' + file, import.meta.url), 'utf8'));
    const before = await database.query<Record<string, unknown>>('SELECT * FROM profiles ORDER BY id');
    await database.exec(await readFile(new URL('../migrations/020_profile_metadata.sql', import.meta.url), 'utf8'));
    const after = await database.query<Record<string, unknown>>('SELECT * FROM profiles ORDER BY id');
    assert.deepEqual(after.rows.map(({ api_level, abi, device_model, resolution, ...row }) => {
      assert.deepEqual([api_level, abi, device_model, resolution], [null, null, null, null]); return row;
    }), before.rows);
    await database.exec("ALTER TABLE profiles ADD COLUMN recommended boolean NOT NULL DEFAULT false; ALTER TABLE profiles ADD COLUMN gpu_image text; ALTER TABLE profiles ADD COLUMN image_flavor text; ALTER TABLE profiles ADD COLUMN device_type text; ALTER TABLE profiles ADD COLUMN image_tag text; ALTER TABLE profiles ADD COLUMN gpu_memory_mb integer; ALTER TABLE profiles ADD COLUMN container_env jsonb NOT NULL DEFAULT '{}'; ALTER TABLE profiles ADD COLUMN disk_max_gb integer; ALTER TABLE profiles ADD COLUMN sdcard_gb integer; ALTER TABLE profiles ADD COLUMN sdcard_max_gb integer; CREATE TABLE app_secrets(name text PRIMARY KEY, value text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()); ALTER TABLE profiles ADD COLUMN docker_options jsonb NOT NULL DEFAULT '{}'::jsonb");
    await database.exec(await readFile(new URL('../migrations/036_profile_removal.sql', import.meta.url), 'utf8'));
    await database.exec(await readFile(new URL('../migrations/039_profile_gpu_support.sql', import.meta.url), 'utf8'));
    await database.exec(await readFile(new URL('../migrations/045_launch_permissions.sql', import.meta.url), 'utf8'));
    const pool = { query: database.query.bind(database) } as unknown as Pool;
    const pass: express.RequestHandler = (_req, _res, next) => next();
    const context = { pool, config: {}, hub: {}, requireAuth: pass, requireAdmin: pass, current: () => ({ user: { role: 'admin' } }) } as unknown as ServerContext;
    const app = express(); app.use(express.json()); registerAdminRoutes(app, context);
    app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(error instanceof ApiError ? error.status : 500).json({ error: String(error) });
    });
    server = createServer(app); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const request = (path: string, method = 'GET', body?: unknown) => fetch('http://127.0.0.1:' + address.port + '/api' + path, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const metadata = { recommended: true, imageFlavor: 'google_apis', deviceType: 'mobile', apiLevel: 35, abi: 'x86_64, arm64-v8a', deviceModel: 'Custom model', resolution: '1080x2400' };
    const created = await request('/admin/profiles', 'POST', { ...input, ...metadata, gpuSupport: 'cuda' }); assert.equal(created.status, 201);
    const createdBody = await created.json() as { profile: Record<string, unknown> };
    for (const [key, value] of Object.entries(metadata)) assert.equal(createdBody.profile[key], value);
    assert.ok(!('gpuSupport' in createdBody.profile) && !('gpuModes' in createdBody.profile));
    assert.equal((await database.query('SELECT gpu_support FROM profiles WHERE id=$1', [input.id])).rows[0]?.gpu_support, 'none');
    const updated = await request('/admin/profiles/' + input.id, 'PATCH', { name: 'Renamed' }); assert.equal(updated.status, 200);
    const updatedBody = await updated.json() as { profile: Record<string, unknown> };
    for (const [key, value] of Object.entries(metadata)) assert.equal(updatedBody.profile[key], value);
    const listing = await (await request('/profiles')).json() as { profiles: Array<Record<string, unknown>> };
    assert.equal(listing.profiles.find(profile => profile.id === input.id)?.abi, metadata.abi);
    const cleared = await (await request('/admin/profiles/' + input.id, 'PATCH', { gpuSupport: 'none', imageFlavor: null, deviceType: null, apiLevel: null, abi: '', deviceModel: null, resolution: '' })).json() as { profile: Record<string, unknown> };
    for (const key of Object.keys(metadata).filter(key => key !== 'recommended')) assert.equal(cleared.profile[key], null);
    assert.equal(cleared.profile.recommended, true);
    assert.ok(!('gpuSupport' in cleared.profile));
    const recommendOff = await (await request('/admin/profiles/' + input.id, 'PATCH', { recommended: false })).json() as { profile: Record<string, unknown> };
    assert.equal(recommendOff.profile.recommended, false);
  } finally {
    if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())); }
    await database.close();
  }
});


test('normal server migration applies profile metadata automatically and is idempotent', async () => {
  const database = new PGlite();
  try {
    // Match pg's simple-query multi-statement support and rowCount contract.
    const query = async (sql: string, values?: unknown[]) => {
      const result = values === undefined ? (await database.exec(sql)).at(-1) : await database.query(sql, values);
      return { ...result, rowCount: result?.rows?.length || result?.affectedRows || 0 };
    };
    const pool = { query, connect: async () => ({ query, release: () => {} }) } as unknown as Pool;
    await migrate(pool);
    const versions = await database.query<{ version: number }>('SELECT version FROM schema_migrations ORDER BY version');
    const files = await readdir(new URL('../migrations/', import.meta.url));
    const expectedVersions = files.filter(name => /^\d+.*\.sql$/.test(name)).map(name => Number(name.split('_')[0])).sort((a, b) => a - b);
    assert.deepEqual(versions.rows.map(row => row.version), expectedVersions);
    await database.query("UPDATE profiles SET api_level=30,abi='x86_64',device_model='Custom image',resolution='720x1280' WHERE id='android-30'");
    await migrate(pool);
    const saved = await database.query("SELECT api_level,abi,device_model,resolution FROM profiles WHERE id='android-30'");
    assert.deepEqual(saved.rows[0], { api_level: 30, abi: 'x86_64', device_model: 'Custom image', resolution: '720x1280' });
  } finally { await database.close(); }
});
