import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';
import express from 'express';
import { PGlite } from '@electric-sql/pglite';
import type { Pool } from 'pg';
import type { AuthService } from '../src/auth.js';
import type { AgentHub } from '../src/agent.js';
import type { Config } from '../src/config.js';
import { migrate } from '../src/db.js';
import { ApiError } from '../src/http-common.js';
import { createServerContext } from '../src/server-context.js';
import { registerAdminRoutes } from '../src/routes/admin-routes.js';
import { getSecretBox, openEnv, sealLegacyProfileEnv } from '../src/secrets.js';
import { validateDockerOptions } from '../src/docker-options.js';
import { checkManifestProfile, exportManifest, parseManifest } from '../src/profile-manifest.js';

const OWNER = '11111111-1111-4111-8111-111111111111';
const ADMIN = '33333333-3333-4333-8333-333333333333';
async function fixture() {
  const db = new PGlite();
  const query = async (sql: string, values?: unknown[]) => {
    const result = values === undefined ? (await db.exec(sql)).at(-1) : await db.query(sql, values);
    return { ...result, rowCount: result?.rows?.length || result?.affectedRows || 0 };
  };
  const pool = { query, connect: async () => ({ query, release() {} }) } as unknown as Pool;
  await migrate(pool);
  for (const [id, role] of [[OWNER, 'user'], [ADMIN, 'admin']]) {
    await db.query("INSERT INTO users(id,provider,subject,username,display_name,role) VALUES($1::uuid,'local',$1::text,$1::text,$1::text,$2)", [id, role]);
  }
  let actor: string | null = OWNER;
  const auth = { authenticate: async () => actor ? { user: { id: actor, role: actor === ADMIN ? 'admin' : 'user' }, via: 'cookie' } : null } as unknown as AuthService;
  const context = createServerContext(pool, {} as Config, auth, undefined, {} as AgentHub);
  const app = express(); app.use(express.json()); registerAdminRoutes(app, context);
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (error instanceof SyntaxError && (error as { type?: string }).type === 'entity.parse.failed') { res.status(400).json({ error: { code: 'invalid_json' } }); return; }
    res.status(error instanceof ApiError ? error.status : 500).json({ error: { code: error instanceof ApiError ? error.code : 'internal_error' } });
  });
  const server = createServer(app); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const request = (path = '/hosts', method = 'GET', body?: unknown) => fetch(`http://127.0.0.1:${address.port}/api${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const close = async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await db.close(); };
  return { db, pool, request, close, actor: (id: string | null) => { actor = id; } };
}


const ok = (profile: Record<string, unknown> = {}) => ({ version: 2, profiles: [{
  id: 'qa-android-14', name: 'QA · Android 14', image: { repository: 'registry.example.com/emu/android', tag: '34-qa', digest: 'sha256:' + 'a'.repeat(64) },
  android: { version: '14', api: 34, abi: 'x86_64' }, resources: { cpu: 2, memoryMb: 4096, diskGb: 8 },
  emulator: { params: ['-no-snapshot'] }, container: { env: { API_PASSWORD: 'hunter2-secret' }, shmSizeMb: 256 }, ...profile }] });

test('manifest import previews, creates disabled profiles and keeps variable values encrypted and hidden', async () => {
  const f = await fixture();
  try {
    f.actor(ADMIN);
    const post = (manifest: unknown, extra: Record<string, unknown> = {}) => f.request('/admin/profiles/import', 'POST', { manifest, ...extra });
    const preview = await (await post(ok())).json() as { applied: boolean; results: Array<{ action: string; issues: unknown[] }> };
    assert.equal(preview.applied, false);
    assert.equal(preview.results[0]!.action, 'create');
    assert.equal((await f.db.query("SELECT 1 FROM profiles WHERE id='qa-android-14'")).rows.length, 0);

    const appliedRes = await post(ok(), { apply: true }); const applied = await appliedRes.json() as { applied: boolean };
    assert.equal(applied.applied, true);
    const row = (await f.db.query<{ enabled: boolean; container_env: Record<string, string>; docker_options: Record<string, unknown>; image: string }>("SELECT * FROM profiles WHERE id='qa-android-14'")).rows[0]!;
    assert.equal(row.enabled, false);
    assert.match(row.container_env.API_PASSWORD!, /^enc:v1:/);
    assert.ok(!JSON.stringify(row).includes('hunter2-secret'));
    assert.deepEqual(row.docker_options, { shmSizeMb: 256 });
    assert.match(row.image, /:34-qa@sha256:/);

    const listed = JSON.stringify(await (await f.request('/admin/profiles')).json());
    assert.ok(!listed.includes('hunter2-secret') && !listed.includes('enc:v1:'));
    assert.ok(listed.includes('API_PASSWORD'));
    const exported = JSON.stringify(await (await f.request('/admin/profiles/export')).json());
    assert.ok(!exported.includes('hunter2-secret') && exported.includes('"API_PASSWORD":null'));

    // Existing ids are left alone unless "update" is requested; null keeps the stored value.
    const skipped = await (await post(ok(), { apply: true })).json() as { results: Array<{ action: string }> };
    assert.equal(skipped.results[0]!.action, 'skip');
    const keep = ok({ name: 'Renamed', container: { env: { API_PASSWORD: null } } });
    assert.equal(((await (await post(keep, { apply: true, update: true })).json()) as { applied: boolean }).applied, true);
    const after = (await f.db.query<{ name: string; container_env: Record<string, string>; enabled: boolean }>("SELECT name,container_env,enabled FROM profiles WHERE id='qa-android-14'")).rows[0]!;
    assert.equal(after.name, 'Renamed');
    assert.equal(after.container_env.API_PASSWORD, row.container_env.API_PASSWORD);
    assert.equal(after.enabled, false);
  } finally { await f.close(); }
});

test('manifest import rejects anything that could widen the container or is not understood', async () => {
  const f = await fixture();
  try {
    f.actor(ADMIN);
    const bad: Array<[string, Record<string, unknown>]> = [
      ['privileged is not representable', { container: { privileged: true } }],
      ['unknown top-level field', { network: 'host' }],
      ['reserved variable', { container: { env: { ADBKEY_PUB: 'x' } } }],
      ['reserved prefix', { container: { env: { LD_PRELOAD: '/evil.so' } } }],
      ['null without a stored value', { container: { env: { NEW_ONE: null } } }],
      ['bad tmpfs path', { container: { tmpfs: [{ path: '/etc', sizeMb: 10 }] } }],
      ['bad sysctl', { container: { sysctls: { 'kernel.core_pattern': '|/x' } } }],
      ['bad ulimit', { container: { ulimits: [{ name: 'memlock', soft: 1, hard: 2 }] } }],
      ['bad variable name for the key', { launch: { adbKeyEnv: 'PATH' } }],
      ['emulator flag that takes over the disk', { emulator: { params: ['-partition-size', '9999'] } }],
      ['bad digest', { image: { repository: 'registry.example.com/x', digest: 'sha256:zz' } }],
    ];
    for (const [label, patch] of bad) {
      const response = await f.request('/admin/profiles/import', 'POST', { manifest: ok(patch), apply: true });
      const body = await response.json() as { applied?: boolean; results?: Array<{ issues: unknown[] }>; issues?: unknown[] };
      assert.ok(response.status === 400 || body.applied === false, label);
      assert.equal((await f.db.query("SELECT 1 FROM profiles WHERE id='qa-android-14'")).rows.length, 0, label);
    }
    f.actor(OWNER);
    assert.equal((await f.request('/admin/profiles/import', 'POST', { manifest: ok(), apply: true })).status, 403);
  } finally { await f.close(); }
});

test('legacy plain-text variables are encrypted on start and decrypted for launch', async () => {
  const f = await fixture();
  try {
    await f.db.query("INSERT INTO profiles(id,name,android_version,image,cpu,memory_mb,disk_gb,container_env) VALUES('legacy','legacy','11','registry.example/x:1',2,4096,8,'{\"TOKEN\":\"plain-value\"}')");
    assert.equal(await sealLegacyProfileEnv(f.pool), 1);
    const stored = (await f.db.query<{ container_env: Record<string, string> }>("SELECT container_env FROM profiles WHERE id='legacy'")).rows[0]!.container_env;
    assert.match(stored.TOKEN!, /^enc:v1:/);
    assert.deepEqual(openEnv(await getSecretBox(f.pool), stored), { TOKEN: 'plain-value' });
    assert.equal(await sealLegacyProfileEnv(f.pool), 0);
  } finally { await f.close(); }
});

test('docker options are an allowlist', () => {
  assert.deepEqual(validateDockerOptions({ shmSizeMb: 512, tmpfs: [{ path: '/dev/shm', sizeMb: 64 }], command: ['run', '--x'] }), { value: { shmSizeMb: 512, tmpfs: [{ path: '/dev/shm', sizeMb: 64 }], command: ['run', '--x'] } });
  for (const value of [{ privileged: true }, { devices: ['/dev/kvm'] }, { binds: ['/:/host'] }, { shmSizeMb: 10 }, { command: [''] }, { entrypoint: 'sh' }]) {
    assert.ok('error' in validateDockerOptions(value), JSON.stringify(value));
  }
  assert.ok('error' in validateDockerOptions({ adbKeyEnv: 'MY_KEY' }, name => name === 'MY_KEY'));
});

test('GPU launch settings cannot be hidden in Docker options', () => {
  for (const gpu of [{ kind: 'nvidia' }, { kind: 'dri' }, { capabilities: ['compute', 'utility'] }, { flags: { accelerated: ['-gpu', 'host'] } }, { env: { accelerated: { GPU_ACCELERATED: 'true' } } }]) {
    assert.ok('error' in validateDockerOptions({ gpu }), JSON.stringify(gpu));
  }
});

test('version 2 round-trips profiles without GPU fields and ignores legacy GPU metadata', () => {
  for (const support of [undefined, 'none', 'cuda', 'gpu']) {
    const parsed = parseManifest(ok({ gpu: support, container: {} }));
    assert.deepEqual(parsed.issues, []);
    assert.deepEqual(parsed.profiles[0]!.issues, []);
    assert.equal(parsed.profiles[0]!.warnings.length, support === undefined ? 0 : 1);
    const checked = checkManifestProfile(parsed.profiles[0]!, false);
    assert.equal(checked.issue, undefined);
    const profile = checked.parsed!;
    assert.ok(!Object.keys(profile).some(key => key.startsWith('gpu')));
    const exported = exportManifest([{
      id: profile.id, name: profile.name, image: profile.image, gpu_support: support,
      android_version: profile.androidVersion, cpu: profile.cpu, memory_mb: profile.memoryMb, disk_gb: profile.diskGb,
      docker_options: profile.dockerOptions, container_env: profile.containerEnv,
    }]);
    assert.equal(exported.version, 2);
    assert.ok(!('gpu' in exported.profiles[0]!));
    assert.equal(exported.profiles[0]!.image, profile.image);
    assert.equal(exported.profiles[0]!.resources.memoryMb, profile.memoryMb);
    const imported = parseManifest(exported);
    assert.deepEqual(imported.issues, []);
    assert.deepEqual(imported.profiles[0]!.issues, []);
    const roundtrip = checkManifestProfile(imported.profiles[0]!, false);
    assert.equal(roundtrip.issue, undefined);
    assert.ok(!('gpuSupport' in roundtrip.parsed!));
    assert.equal(roundtrip.parsed!.image, profile.image);
    assert.equal(roundtrip.parsed!.memoryMb, profile.memoryMb);
  }
});

test('legacy GPU overrides are ignored with a warning and never replace the main image', () => {
  for (const gpu of [
    { image: 'registry.example/alternate:cuda', kind: 'nvidia', mode: 'nvidia' },
    { kind: 'dri', mode: 'software' },
    { capabilities: ['compute', 'utility'] },
    { flags: { accelerated: ['-gpu', 'angle_indirect'] } },
    { env: { accelerated: { CUSTOM_GPU: '1' } } },
  ]) {
    const legacy = { ...ok({ gpu, gpuImage: 'registry.example/other:gpu' }), version: 1 };
    const parsed = parseManifest(legacy);
    assert.deepEqual(parsed.issues, []);
    assert.deepEqual(parsed.profiles[0]!.issues, []);
    assert.equal(parsed.profiles[0]!.warnings.length, 1);
    assert.match(parsed.profiles[0]!.warnings[0]!, /ignored/);
    const checked = checkManifestProfile(parsed.profiles[0]!, false);
    assert.equal(checked.issue, undefined);
    assert.equal(checked.parsed!.image, checkManifestProfile(parseManifest(ok()).profiles[0]!, false).parsed!.image);
    assert.deepEqual(checked.parsed!.dockerOptions, { shmSizeMb: 256 });
    assert.ok(!Object.keys(checked.parsed!).some(key => key.startsWith('gpu')));
  }
});

test('the example manifest in docs/examples is valid and produces disabled profiles', async () => {
  const { readFile } = await import('node:fs/promises');
  const manifest = JSON.parse(await readFile(new URL('../../docs/examples/profiles-test-images.json', import.meta.url), 'utf8'));
  const f = await fixture();
  try {
    f.actor(ADMIN);
    const body = await (await f.request('/admin/profiles/import', 'POST', { manifest, apply: true })).json() as { applied: boolean; results: Array<{ id: string; action: string; issues: unknown[] }> };
    assert.deepEqual(body.results.flatMap(item => item.issues), []);
    assert.equal(body.applied, true);
    const rows = (await f.db.query<{ id: string; enabled: boolean; image: string; gpu_support: string; docker_options: Record<string, unknown> }>("SELECT id,enabled,image,gpu_support,docker_options FROM profiles WHERE id LIKE 'example-android-%'")).rows;
    assert.equal(rows.length, 2);
    assert.ok(rows.every(row => row.enabled === false));
    assert.ok(rows.every(row => row.gpu_support === 'none'));
    assert.ok(rows.every(row => /@sha256:[0-9a-f]{64}$/.test(row.image)));
    assert.ok(rows.some(row => row.id === 'example-android-phone'));
    assert.ok(rows.some(row => row.id === 'example-android-tablet'));
  } finally { await f.close(); }
});

test('the farm emulator catalog produces an importable manifest: AOSP, Google APIs, Google Play, tablets, TV, automotive, wear', async () => {
  const { readFile } = await import('node:fs/promises');
  // @ts-expect-error plain ES module without type declarations
  const catalog = await import('../../agent/src/emulator-catalog.mjs');
  const list = await readFile(new URL('../../agent/src/fixtures/sdkmanager-list.txt', import.meta.url), 'utf8');
  const manifest = catalog.buildManifest(catalog.parseSdkList(list), { registry: 'registry.local/rdf-emulator' });
  const f = await fixture();
  try {
    f.actor(ADMIN);
    const body = await (await f.request('/admin/profiles/import', 'POST', { manifest, apply: true })).json() as { applied: boolean; results: Array<{ id: string; issues: unknown[] }> };
    assert.deepEqual(body.results.flatMap(item => item.issues), []);
    assert.equal(body.applied, true);
    const rows = (await f.db.query<{ id: string; enabled: boolean; image_flavor: string; device_type: string; resolution: string; image: string }>("SELECT id,enabled,image_flavor,device_type,resolution,image FROM profiles WHERE id LIKE 'emu-%'")).rows;
    assert.equal(rows.length, manifest.profiles.length);
    assert.ok(rows.every(row => row.enabled === false && row.image.startsWith('registry.local/rdf-emulator:')));
    for (const flavor of ['aosp', 'google_apis', 'google_play']) assert.ok(rows.some(row => row.image_flavor === flavor), flavor);
    for (const type of ['mobile', 'tv', 'automotive', 'wear']) assert.ok(rows.some(row => row.device_type === type), type);
    assert.ok(rows.some(row => row.resolution === '2560x1600'));
  } finally { await f.close(); }
});
