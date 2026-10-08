import assert from 'node:assert/strict';
import test from 'node:test';
import { validateContainerEnv } from '../src/container-env.js';
import { ApiError, parseProfile, profileJson } from '../src/http-common.js';

const profileInput = { id: 'custom', name: 'Custom', androidVersion: '14', image: 'registry.example/android:14', cpu: 2, memoryMb: 4096, diskGb: 8, emulatorParams: '-no-snapshot', gpuMode: 'software' };

test('container variables are plain data; farm-owned names, Docker-like names and bad values are rejected', () => {
  assert.deepEqual(validateContainerEnv(undefined), {});
  assert.deepEqual(validateContainerEnv({ WEB_VNC: 'true', _A1: 'x y' }), { WEB_VNC: 'true', _A1: 'x y' });
  for (const bad of [{ AVD_CONFIG: 'disk.dataPartition.size=128G' }, { ADBKEY_PUB: 'x' }, { emulator_params: '-gpu host' }, { NVIDIA_VISIBLE_DEVICES: 'all' }, { LD_PRELOAD: '/x' }, { PATH: '/x' }, { DOCKER_HOST: 'x' }, { RDF_X: '1' },
    { '1A': 'x' }, { 'A B': 'x' }, { A: 'a\nb' }, { A: 'x'.repeat(513) }, { A: 1 }, ['A=1'], 'A=1', Object.fromEntries(Array.from({ length: 17 }, (_, i) => ['V' + i, 'x']))]) {
    assert.equal(validateContainerEnv(bad), null, JSON.stringify(bad).slice(0, 50));
  }
});

test('profiles keep emulator arguments and container variables apart, and only administrators see the variables', () => {
  const parsed = parseProfile({ ...profileInput, containerEnv: { WEB_VNC: 'true' } });
  assert.equal(parsed.emulatorParams, '-no-snapshot');
  assert.deepEqual(parsed.containerEnv, { WEB_VNC: 'true' });
  assert.deepEqual(parseProfile(profileInput).containerEnv, {});
  assert.throws(() => parseProfile({ ...profileInput, containerEnv: { EMULATOR_PARAMS: '-gpu host' } }), (e: unknown) => e instanceof ApiError && e.code === 'invalid_profile');
  const row = { id: 'custom', name: 'Custom', android_version: '14', image: 'x', cpu: 2, memory_mb: 4096, disk_gb: 8, emulator_params: '-no-snapshot', container_env: { TOKEN: 'secret' }, gpu_mode: 'software', enabled: true, created_at: new Date() };
  assert.equal('containerEnv' in profileJson(row), false, 'users never see container variables');
  assert.equal(JSON.stringify(profileJson(row)).includes('secret'), false);
  assert.deepEqual((profileJson(row, true) as { containerEnv: unknown }).containerEnv, { TOKEN: null }, 'administrators see names only, never values');
  assert.equal(JSON.stringify(profileJson(row, true)).includes('secret'), false);
  // `.map(profileJson)` passes the array index as the second argument: only a literal `true` may enable the admin view
  assert.equal(JSON.stringify([row, row, row].map(profileJson)).includes('secret'), false);
});

// End to end through the admin routes and a real schema: the variables are stored, survive an edit that does not
// mention them, and only administrators ever receive them.
import { once } from 'node:events';
import { createServer } from 'node:http';
import express from 'express';
import { PGlite } from '@electric-sql/pglite';
import type { Pool } from 'pg';
import type { AgentHub } from '../src/agent.js';
import type { AuthService } from '../src/auth.js';
import type { Config } from '../src/config.js';
import { migrate } from '../src/db.js';
import { registerAdminRoutes } from '../src/routes/admin-routes.js';
import { createServerContext } from '../src/server-context.js';

test('container variables round-trip through the admin API and never reach ordinary users', async () => {
  const db = new PGlite();
  const query = async (sql: string, values?: unknown[]) => {
    const result = values === undefined ? (await db.exec(sql)).at(-1) : await db.query(sql, values);
    return { ...result, rowCount: result?.rows?.length || result?.affectedRows || 0 };
  };
  const pool = { query, connect: async () => ({ query, release() {} }) } as unknown as Pool;
  let role: 'admin' | 'user' = 'admin';
  let server: ReturnType<typeof createServer> | undefined;
  try {
    await migrate(pool);
    await db.query("INSERT INTO users(id,provider,subject,username,display_name,role) VALUES('11111111-1111-4111-8111-111111111111','local','a','a','a','admin')");
    const auth = { authenticate: async () => ({ user: { id: '11111111-1111-4111-8111-111111111111', role }, via: 'cookie' }) } as unknown as AuthService;
    const app = express(); app.use(express.json());
    registerAdminRoutes(app, createServerContext(pool, {} as Config, auth, undefined, {} as AgentHub));
    app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(error instanceof ApiError ? error.status : 500).json({ error: error instanceof ApiError ? error.code : 'internal' });
    });
    server = createServer(app); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const call = (method: string, path: string, body?: unknown) => fetch(`http://127.0.0.1:${address.port}${path}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });

    const created = await call('POST', '/api/admin/profiles', { ...profileInput, containerEnv: { API_TOKEN: 'secret-value', WEB_VNC: 'true' } });
    assert.equal(created.status, 201);
    assert.deepEqual((await created.json()).profile.containerEnv, { API_TOKEN: null, WEB_VNC: null });
    assert.deepEqual((await (await call('GET', '/api/admin/profiles')).json()).profiles.find((p: { id: string }) => p.id === 'custom').containerEnv, { API_TOKEN: null, WEB_VNC: null });

    const renamed = await call('PATCH', '/api/admin/profiles/custom', { name: 'Renamed' });
    assert.equal(renamed.status, 200);
    assert.deepEqual((await renamed.json()).profile.containerEnv, { API_TOKEN: null, WEB_VNC: null }, 'an edit that omits the variables keeps them');
    assert.equal((await call('PATCH', '/api/admin/profiles/custom', { containerEnv: { PATH: '/x' } })).status, 400);
    const cleared = await call('PATCH', '/api/admin/profiles/custom', { containerEnv: {} });
    assert.deepEqual((await cleared.json()).profile.containerEnv, {});
    await call('PATCH', '/api/admin/profiles/custom', { containerEnv: { API_TOKEN: 'secret-value' } });

    role = 'user';
    const listing = await (await call('GET', '/api/profiles')).text();
    assert.ok(listing.includes('custom'), 'the profile itself is listed for users');
    assert.equal(listing.includes('secret-value') || listing.includes('API_TOKEN') || listing.includes('containerEnv'), false);
  } finally { server?.close(); await db.close(); }
});
