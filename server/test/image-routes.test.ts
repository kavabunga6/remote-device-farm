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
import { ImageBuildWorker, type AgentJob } from '../src/image-build-worker.js';
import { builderHost, registerImageRoutes } from '../src/routes/image-routes.js';
import { authorizeRegistryRequest, issueRegistryToken, registryAuthFor } from '../src/registry.js';
import { getSecretBox } from '../src/secrets.js';
// @ts-expect-error plain ES module without type declarations
import { buildManifest, parseSdkList, selectEntries, imageTag } from '../../agent/src/emulator-catalog.mjs';
import { readFileSync } from 'node:fs';

const ADMIN = '33333333-3333-4333-8333-333333333333';
const USER = '11111111-1111-4111-8111-111111111111';
const DIGEST_A = 'sha256:' + 'a'.repeat(64);
const DIGEST_B = 'sha256:' + 'b'.repeat(64);
const catalog = parseSdkList(readFileSync(new URL('../../agent/src/fixtures/sdkmanager-list.txt', import.meta.url), 'utf8'));
const PLAY = 'system-images;android-34;google_apis_playstore;x86_64';

async function fixture() {
  const db = new PGlite();
  const query = async (sql: string, values?: unknown[]) => {
    const result = values === undefined ? (await db.exec(sql)).at(-1) : await db.query(sql, values);
    return { ...result, rowCount: result?.rows?.length || result?.affectedRows || 0 };
  };
  const pool = { query, connect: async () => ({ query, release() {} }) } as unknown as Pool;
  await migrate(pool);
  for (const [id, role] of [[USER, 'user'], [ADMIN, 'admin']]) {
    await db.query("INSERT INTO users(id,provider,subject,username,display_name,role) VALUES($1::uuid,'local',$1::text,$1::text,$1::text,$2)", [id, role]);
  }
  await db.query("INSERT INTO hosts(id,name,slots) VALUES('builder','Builder',2),('other','Other',2)");
  const commands: Array<{ hostId: string; action: string; params: Record<string, unknown> }> = [];
  let jobs: Array<Record<string, unknown>> = [];
  let failJobs = false;
  let cancelError: string | null = null;
  const connected = new Set(['builder']);
  const hub = { hasAgent: (id: string) => connected.has(id), command: async (hostId: string, _session: string, action: string, params: Record<string, unknown>) => {
    commands.push({ hostId, action, params });
    if (action === 'emulator-jobs') {
      if (failJobs) throw new Error('agent disconnected');
      return { jobs };
    }
    if (action === 'emulator-catalog') return { abi: 'x86_64', refreshedAt: new Date().toISOString(), images: selectEntries(catalog, { abi: 'x86_64' }).map((entry: Record<string, unknown>) => ({ package: entry.package, tag: imageTag(entry), device: entry.device, flavor: entry.flavor })), jobs };
    if (action === 'emulator-cancel') {
      if (cancelError) throw new Error(cancelError);
      const job = jobs.find(item => item.id === params.jobId);
      if (!job) throw new Error('Emulator build job not found');
      if (job.state === 'queued') job.state = 'cancelled';
      else if (['building', 'validating', 'pushing'].includes(String(job.state))) job.state = 'cancelling';
      return { jobs: [job] };
    }
    if (action === 'emulator-build') {
      const target = params.target as { repository: string };
      jobs = (params.packages as string[]).map((name, index) => {
        const entry = catalog.find((item: { package: string }) => item.package === name);
        return { id: 'job-' + index, package: name, image: `${target.repository}:${imageTag(entry)}`, state: 'queued', profiles: buildManifest([entry], { registry: target.repository }).profiles };
      });
      return { jobs };
    }
    throw new Error('unexpected ' + action);
  } } as unknown as AgentHub;
  let actor: string | null = ADMIN;
  const auth = { authenticate: async () => actor === null ? null : ({ user: { id: actor, role: actor === ADMIN ? 'admin' : 'user' }, via: 'cookie' }) } as unknown as AuthService;
  const worker = new ImageBuildWorker(pool, hub, undefined, 10);
  const app = express(); app.use(express.json()); registerImageRoutes(app, createServerContext(pool, {} as Config, auth, undefined, hub), worker);
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(error instanceof ApiError ? error.status : 500).json({ error: { code: error instanceof ApiError ? error.code : 'internal_error', message: String((error as Error).message) } });
  });
  const server = createServer(app); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const request = (path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) =>
    fetch(`http://127.0.0.1:${address.port}/api${path}`, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const close = async () => { await worker.stop(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await db.close(); };
  return { db, pool, request, close, commands, worker, hub, connected, failJobs: (value: boolean) => { failJobs = value; }, setJobs: (value: typeof jobs) => { jobs = value; }, getJobs: () => jobs, cancelError: (value: string | null) => { cancelError = value; }, as: (id: string | null) => { actor = id; } };
}

const basic = (password: string, user = 'rdf') => 'Basic ' + Buffer.from(`${user}:${password}`).toString('base64');

test('registry tokens: pull reads, push writes, everything else is refused', async () => {
  const f = await fixture();
  try {
    const pull = await issueRegistryToken(f.pool, 'pull', 'other');
    const push = await issueRegistryToken(f.pool, 'push', 'builder');
    assert.equal(await authorizeRegistryRequest(f.pool, basic(pull), 'GET'), 200);
    assert.equal(await authorizeRegistryRequest(f.pool, basic(pull), 'HEAD'), 200);
    assert.equal(await authorizeRegistryRequest(f.pool, basic(pull), 'PUT'), 403);
    assert.equal(await authorizeRegistryRequest(f.pool, basic(push), 'PATCH'), 200);
    assert.equal(await authorizeRegistryRequest(f.pool, basic('wrong'), 'GET'), 401);
    assert.equal(await authorizeRegistryRequest(f.pool, basic(pull, 'admin'), 'GET'), 401);
    assert.equal(await authorizeRegistryRequest(f.pool, undefined, 'GET'), 401);
    await f.db.query("UPDATE registry_tokens SET expires_at=now() - interval '1 second'");
    assert.equal(await authorizeRegistryRequest(f.pool, basic(pull), 'GET'), 401);
    const response = await f.request('/registry/auth', 'GET', undefined, { Authorization: basic('nope') });
    assert.equal(response.status, 401);
    assert.match(response.headers.get('www-authenticate') ?? '', /Basic/);
  } finally { await f.close(); }
});

test('registry settings: built-in by default, company registry password is write-only and encrypted', async () => {
  const f = await fixture();
  try {
    let body = await (await f.request('/admin/registry')).json() as { registry: Record<string, unknown> };
    assert.equal(body.registry.mode, 'builtin');
    assert.equal((await f.request('/admin/registry', 'PUT', { builtinAddress: 'not a host!' })).status, 400);
    body = await (await f.request('/admin/registry', 'PUT', { builtinAddress: 'https://farm.example.com/' })).json() as typeof body;
    assert.equal(body.registry.builtinAddress, 'farm.example.com');
    assert.equal((await f.request('/admin/registry', 'PUT', { mode: 'external' })).status, 400, 'external needs an address');
    assert.equal((await (await f.request('/admin/registry')).json() as { registry: { mode: string } }).registry.mode, 'builtin', 'rejected settings must not change the active registry');
    body = await (await f.request('/admin/registry', 'PUT', { mode: 'external', externalAddress: 'registry.corp:5000/mobile', externalUsername: 'ci', externalPassword: 's3cret' })).json() as typeof body;
    assert.equal(body.registry.externalPasswordSet, true);
    assert.ok(!JSON.stringify(body).includes('s3cret'));
    const stored = (await f.db.query<{ external_password: string }>('SELECT external_password FROM registry_settings')).rows[0]!.external_password;
    assert.match(stored, /^enc:v1:/);
    const box = await getSecretBox(f.pool);
    assert.deepEqual(await registryAuthFor(f.pool, box, 'registry.corp:5000/mobile/rdf-emulator:34@' + DIGEST_A, 'pull', 'other'),
      { username: 'ci', password: 's3cret', serveraddress: 'registry.corp:5000' });
    assert.equal(await registryAuthFor(f.pool, box, 'docker.io/library/nginx:1', 'pull', 'other'), null);
    const farm = await registryAuthFor(f.pool, box, 'farm.example.com/rdf-emulator:34@' + DIGEST_A, 'pull', 'other');
    assert.equal(farm?.serveraddress, 'farm.example.com');
    assert.equal(await authorizeRegistryRequest(f.pool, basic(farm!.password), 'GET'), 200);
    f.as(USER);
    assert.equal((await f.request('/admin/registry')).status, 403);
  } finally { await f.close(); }
});

test('builds go to the builder node and finished pushes create enabled profiles pinned by digest', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.request('/admin/emulator-images/builds', 'POST', { packages: [PLAY] })).status, 409, 'no builder yet');
    let list = await (await f.request('/admin/emulator-images')).json() as { builder: unknown; images: unknown[] };
    assert.equal(list.builder, null);
    await f.request('/admin/hosts/builder/image-builder', 'PUT', { enabled: true });
    assert.equal((await f.request('/admin/emulator-images/builds', 'POST', { packages: [PLAY] })).status, 409, 'registry address missing');
    await f.request('/admin/registry', 'PUT', { builtinAddress: 'farm.example.com' });
    const accepted = await f.request('/admin/emulator-images/builds', 'POST', { packages: [PLAY] });
    assert.equal(accepted.status, 202);
    const build = f.commands.find(command => command.action === 'emulator-build')!;
    assert.equal(build.hostId, 'builder');
    const target = build.params.target as { repository: string; auth: { username: string; password: string } };
    assert.equal(target.repository, 'farm.example.com/rdf-emulator');
    assert.equal(await authorizeRegistryRequest(f.pool, basic(target.auth.password), 'PUT'), 200, 'the builder gets a push token');

    f.setJobs(f.getJobs().map(job => ({ ...job, state: 'done', digest: DIGEST_A, sizeMb: 3100 })));
    list = await (await f.request('/admin/emulator-images')).json() as typeof list;
    const image = (list.images as Array<Record<string, unknown>>).find(item => item.package === PLAY)!;
    assert.equal(image.built, true);
    assert.equal(image.digest, DIGEST_A);
    const profiles = (await f.db.query<{ id: string; image: string; enabled: boolean; resolution: string }>("SELECT id,image,enabled,resolution FROM profiles WHERE id LIKE 'emu-%' ORDER BY id")).rows;
    assert.equal(profiles.length, 2, 'phone and tablet');
    assert.ok(profiles.every(profile => profile.enabled && profile.image === 'farm.example.com/rdf-emulator:34-google_apis_playstore-x86_64@' + DIGEST_A));
    assert.ok(profiles.some(profile => profile.resolution === '2560x1600'));

    await f.request('/admin/emulator-images');
    assert.equal((await f.db.query("SELECT id FROM profiles WHERE id LIKE 'emu-%'")).rows.length, 2, 'polling again is idempotent');

    // A rebuild with a new digest does not move profiles until the administrator applies it.
    f.setJobs(f.getJobs().map(job => ({ ...job, id: 'job-rebuild', digest: DIGEST_B })));
    list = await (await f.request('/admin/emulator-images')).json() as typeof list;
    const rebuilt = (list.images as Array<Record<string, unknown>>).find(item => item.package === PLAY)!;
    assert.equal(rebuilt.digest, DIGEST_B);
    assert.equal(rebuilt.updateAvailable, true);
    assert.ok((await f.db.query<{ image: string }>("SELECT image FROM profiles WHERE id LIKE 'emu-%'")).rows.every(row => row.image.endsWith(DIGEST_A)));
    const applied = await (await f.request('/admin/emulator-images/apply', 'POST', { package: PLAY })).json() as { updated: string[] };
    assert.equal(applied.updated.length, 2);
    assert.ok((await f.db.query<{ image: string }>("SELECT image FROM profiles WHERE id LIKE 'emu-%'")).rows.every(row => row.image.endsWith(DIGEST_B)));
  } finally { await f.close(); }
});

test('only one node is the image builder, and only administrators manage builds', async () => {
  const f = await fixture();
  try {
    await f.request('/admin/hosts/builder/image-builder', 'PUT', { enabled: true });
    await f.request('/admin/hosts/other/image-builder', 'PUT', { enabled: true });
    assert.deepEqual((await f.db.query<{ id: string }>('SELECT id FROM hosts WHERE image_builder')).rows.map(row => row.id), ['other']);
    assert.equal((await f.request('/admin/emulator-images/builds', 'POST', { packages: [] })).status, 400);
    f.as(USER);
    assert.equal((await f.request('/admin/emulator-images/builds', 'POST', { packages: [PLAY] })).status, 403);
    assert.equal((await f.request('/admin/hosts/other/image-builder', 'PUT', { enabled: false })).status, 403);
  } finally { await f.close(); }
});


function completedJob(id = 'background-job', digest = DIGEST_A, finishedAt = '2026-10-07T08:00:00Z'): AgentJob {
  const entry = catalog.find((item: { package: string }) => item.package === PLAY);
  const repository = 'farm.example.com/rdf-emulator';
  return { id, state: 'done', package: PLAY, image: repository + ':' + imageTag(entry), digest, finishedAt,
    profiles: buildManifest([entry], { registry: repository }).profiles };
}

test('background worker imports and acknowledges completed builds while no catalog is open', async () => {
  const f = await fixture();
  try {
    await f.db.query("UPDATE registry_settings SET builtin_address='farm.example.com'");
    f.setJobs([completedJob() as unknown as Record<string, unknown>]);
    // The former builder is not selected anymore; results still need reconciliation.
    await f.db.query("UPDATE hosts SET image_builder=true WHERE id='other'");
    const stop = f.worker.start();
    for (let i = 0; i < 100; i++) {
      if (f.commands.some(command => command.action === 'emulator-jobs' && Array.isArray(command.params.acknowledged))) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    await stop();
    assert.equal((await f.db.query("SELECT id FROM profiles WHERE id LIKE 'emu-%'")).rows.length, 2);
    assert.ok(!f.commands.some(command => command.action === 'emulator-catalog'));
    assert.ok(f.commands.some(command => command.action === 'emulator-jobs' && (command.params.acknowledged as string[] | undefined)?.includes('background-job')));
    const restarted = new ImageBuildWorker(f.pool, f.hub);
    await restarted.poll();
    assert.equal((await f.db.query('SELECT * FROM emulator_image_job_receipts')).rows.length, 1);
    assert.equal((await f.db.query("SELECT * FROM audit_events WHERE action='emulator_image.built'")).rows.length, 1);
  } finally { await f.close(); }
});

test('disconnection retries without acknowledgement and invalid profiles roll back the image and receipt', async () => {
  const f = await fixture();
  try {
    await f.db.query("UPDATE registry_settings SET builtin_address='farm.example.com'");
    f.setJobs([{ ...completedJob(), profiles: [{ id: 'invalid' }] }]);
    f.failJobs(true);
    await f.worker.poll();
    assert.equal((await f.db.query('SELECT * FROM emulator_image_job_receipts')).rows.length, 0);
    f.failJobs(false);
    await f.worker.poll();
    assert.equal((await f.db.query('SELECT * FROM emulator_images')).rows.length, 0);
    assert.equal((await f.db.query('SELECT * FROM emulator_image_job_receipts')).rows.length, 0);
    assert.ok(!f.commands.some(command => command.params.acknowledged));
    f.setJobs([completedJob() as unknown as Record<string, unknown>]);
    await f.worker.poll();
    assert.equal((await f.db.query("SELECT id FROM profiles WHERE id LIKE 'emu-%'")).rows.length, 2);
  } finally { await f.close(); }
});

test('old build results cannot revert a newer registry digest across worker restarts', async () => {
  const f = await fixture();
  try {
    await f.db.query("UPDATE registry_settings SET builtin_address='farm.example.com'");
    await f.worker.recordJobs([completedJob('new', DIGEST_B, '2026-10-07T10:00:00Z')], 'builder');
    const restarted = new ImageBuildWorker(f.pool, f.hub);
    await restarted.recordJobs([completedJob('old', DIGEST_A, '2026-10-07T08:00:00Z')], 'builder');
    await restarted.recordJobs([completedJob('new', DIGEST_B, '2026-10-07T10:00:00Z'), completedJob('old', DIGEST_A)], 'builder');
    assert.equal((await f.db.query<{ digest: string }>('SELECT digest FROM emulator_images')).rows[0]!.digest, DIGEST_B);
    assert.equal((await f.db.query('SELECT * FROM emulator_image_job_receipts')).rows.length, 2);
  } finally { await f.close(); }
});

test('auto builder is opt-in, needs exactly one connected healthy KVM node, and preserves manual selection', async () => {
  const f = await fixture();
  try {
    await f.db.query(`UPDATE hosts SET metrics='{"kvm":true,"architecture":"x64"}'::jsonb,last_seen_at=now()`);
    assert.equal(await builderHost(f.pool, f.hub, false), null);
    f.connected.add('other');
    assert.equal(await builderHost(f.pool, f.hub, true), null, 'ambiguous nodes require a choice');
    f.connected.delete('other');
    assert.equal((await builderHost(f.pool, f.hub, true))?.id, 'builder');
    f.connected.clear();
    assert.equal((await builderHost(f.pool, f.hub, true))?.id, 'builder', 'selected builder stays selected while disconnected');
    await f.db.query('UPDATE hosts SET image_builder=false,disabled=true');
    f.connected.add('builder');
    assert.equal(await builderHost(f.pool, f.hub, true), null, 'disabled nodes are not auto-selected');
  } finally { await f.close(); }
});


test('one malformed result does not block another completed build and overlapping polls share one pass', async () => {
  const f = await fixture();
  try {
    await f.db.query("UPDATE registry_settings SET builtin_address='farm.example.com'");
    f.setJobs([completedJob('valid') as unknown as Record<string, unknown>, { ...completedJob('bad'), profiles: [{ id: 'invalid' }] }]);
    const first = f.worker.poll();
    assert.equal(f.worker.poll(), first);
    await first;
    const receipts = (await f.db.query<{ job_id: string }>('SELECT job_id FROM emulator_image_job_receipts')).rows;
    assert.deepEqual(receipts.map(row => row.job_id), ['valid']);
    assert.equal((await f.db.query("SELECT id FROM profiles WHERE id LIKE 'emu-%'")).rows.length, 2);
    assert.deepEqual(f.commands.find(command => Array.isArray(command.params.acknowledged))?.params.acknowledged, ['valid']);
  } finally { await f.close(); }
});


test('build cancellation stays on the job host after the selected builder changes and returns real terminal state', async () => {
  const f = await fixture();
  try {
    const job = { ...completedJob('cancel-original'), state: 'queued' };
    f.setJobs([job]);
    await f.db.query("UPDATE hosts SET image_builder=true WHERE id='other'");
    f.connected.add('other');
    for (const state of ['queued', 'building', 'pushing', 'cancelling', 'cancelled', 'done', 'failed']) {
      f.setJobs([{ ...job, state }]);
      const response = await f.request('/admin/emulator-images/builds/cancel-original/cancel', 'POST', { builderHostId: 'builder' });
      assert.equal(response.status, 200);
      const expected = state === 'queued' ? 'cancelled' : ['building', 'validating', 'pushing'].includes(state) ? 'cancelling' : state;
      const body = await response.json() as { jobs: AgentJob[] };
      assert.deepEqual(body.jobs.map(item => [item.id, item.state]), [['cancel-original', expected]]);
    }
    const calls = f.commands.filter(command => command.action === 'emulator-cancel');
    assert.equal(calls.length, 7);
    assert.ok(calls.every(command => command.hostId === 'builder'));
    assert.ok(calls.every(command => command.params.jobId === 'cancel-original'));
    assert.ok(!f.commands.some(command => command.action === 'emulator-catalog'));
    assert.equal((await f.db.query("SELECT * FROM audit_events WHERE action='emulator_image.build_cancel_requested' AND actor_user_id=$1", [ADMIN])).rows.length, 7);
  } finally { await f.close(); }
});

test('build cancellation requires an administrator, explicit original node and valid job identity', async () => {
  const f = await fixture();
  const path = '/admin/emulator-images/builds/job-1/cancel';
  try {
    f.as(null);
    assert.equal((await f.request(path, 'POST', { builderHostId: 'builder' })).status, 401);
    f.as(USER);
    assert.equal((await f.request(path, 'POST', { builderHostId: 'builder' })).status, 403);
    f.as(ADMIN);
    for (const body of [undefined, {}, { builderHostId: '' }, { builderHostId: 17 }, { builderHostId: ' builder ' }, { builderHostId: 'a'.repeat(201) }]) {
      assert.equal((await f.request(path, 'POST', body)).status, 400);
    }
    for (const jobId of ['bad id', 'bad.id', 'bad_id', 'a'.repeat(65)]) {
      assert.equal((await f.request('/admin/emulator-images/builds/' + encodeURIComponent(jobId) + '/cancel', 'POST', { builderHostId: 'builder' })).status, 400);
    }
    assert.equal((await f.request(path, 'POST', { builderHostId: 'unknown' })).status, 404);
    await f.db.query("UPDATE hosts SET removed_at=now() WHERE id='other'");
    f.connected.add('other');
    assert.equal((await f.request(path, 'POST', { builderHostId: 'other' })).status, 404);
    f.connected.clear();
    const offline = await f.request(path, 'POST', { builderHostId: 'builder' });
    assert.equal(offline.status, 409);
    assert.equal((await offline.json() as { error: { code: string } }).error.code, 'agent_offline');
    assert.equal(f.commands.length, 0, 'Rejected requests must not send cancellation to any agent');
  } finally { await f.close(); }
});

test('missing jobs, agent disconnects and unconfirmed cancellation do not report success', async () => {
  const f = await fixture();
  const path = '/admin/emulator-images/builds/job-1/cancel';
  try {
    const missing = await f.request(path, 'POST', { builderHostId: 'builder' });
    assert.equal(missing.status, 404);
    assert.equal((await missing.json() as { error: { code: string } }).error.code, 'image_build_not_found');
    for (const [message, status, code] of [
      ['agent disconnected', 409, 'agent_offline'],
      ['agent command timed out', 504, 'agent_timeout'],
      ['Unsupported node operation', 502, 'image_build_cancel_failed'],
    ] as const) {
      f.cancelError(message);
      const response = await f.request(path, 'POST', { builderHostId: 'builder' });
      assert.equal(response.status, status);
      assert.equal((await response.json() as { error: { code: string } }).error.code, code);
    }
    assert.equal((await f.db.query("SELECT * FROM audit_events WHERE action='emulator_image.build_cancel_requested'")).rows.length, 0);
  } finally { await f.close(); }
});

test('cancelled build receipts are acknowledged once without importing profiles or logging a failure', async () => {
  const f = await fixture();
  try {
    await f.db.query("UPDATE registry_settings SET builtin_address='farm.example.com'");
    f.setJobs([
      { ...completedJob('cancelled-job'), state: 'cancelled', profiles: [{ id: 'invalid' }] },
      { ...completedJob('cancelling-job'), state: 'cancelling' },
    ]);
    await f.worker.poll();
    await new ImageBuildWorker(f.pool, f.hub).poll();
    const receipts = (await f.db.query('SELECT job_id,state FROM emulator_image_job_receipts')).rows;
    assert.deepEqual(receipts, [{ job_id: 'cancelled-job', state: 'cancelled' }]);
    assert.equal((await f.db.query('SELECT * FROM emulator_images')).rows.length, 0);
    assert.equal((await f.db.query("SELECT * FROM profiles WHERE id LIKE 'emu-%'")).rows.length, 0);
    const acknowledgements = f.commands.filter(command => command.params.acknowledged);
    assert.equal(acknowledgements.length, 2);
    assert.ok(acknowledgements.every(command => JSON.stringify(command.params.acknowledged) === JSON.stringify(['cancelled-job'])));
    const audit = (await f.db.query("SELECT action,outcome FROM audit_events WHERE action LIKE 'emulator_image.%'")).rows;
    assert.deepEqual(audit, [{ action: 'emulator_image.build_cancelled', outcome: 'success' }]);
    assert.equal((await f.db.query("SELECT * FROM service_logs WHERE code='emulator_images.reconcile_failed'")).rows.length, 0);
  } finally { await f.close(); }
});


test('new completed builds require full runtime evidence; validating and failed jobs never create profiles',async()=>{
  const f=await fixture();
  const proof={version:1,checks:{off:Object.fromEntries(['bootCompleted','adbSecure','unauthorizedAdb','rendererVerified','deviceVerified','resourcesVerified'].map(k=>[k,true]))}};
  try {
    await f.db.query("UPDATE registry_settings SET builtin_address='farm.example.com'");
    for(const validation of [null,{}, {version:1,checks:{off:{bootCompleted:true}}}]) {
      await assert.rejects(f.worker.recordJobs([{...completedJob('incomplete'),validation}],'builder'),/runtime validation/);
    }
    await f.worker.recordJobs([{...completedJob('checking'),state:'validating',validation:null},{...completedJob('bad-image'),state:'failed',validation:null}],'builder');
    assert.equal((await f.db.query('SELECT * FROM emulator_images')).rows.length,0);
    assert.equal((await f.db.query("SELECT * FROM profiles WHERE id LIKE 'emu-%'")).rows.length,0);
    await f.worker.recordJobs([{...completedJob('proven'),validation:proof}],'builder');
    assert.equal((await f.db.query("SELECT * FROM profiles WHERE id LIKE 'emu-%'")).rows.length,2);
    assert.deepEqual((await f.db.query('SELECT validation FROM emulator_images')).rows[0]?.validation,proof);
    await f.db.query("UPDATE hosts SET image_builder=true WHERE id='builder'");
    const catalog=await (await f.request('/admin/emulator-images')).json() as {images:Array<{package:string;validated:boolean}>};
    assert.equal(catalog.images.find(image=>image.package===PLAY)?.validated,true);
  } finally {await f.close();}
});

test('existing artifacts are preserved and not scheduled for checking',async()=>{
  const f=await fixture();
  try {
    await f.db.query("UPDATE registry_settings SET builtin_address='farm.example.com'");
    await f.worker.recordJobs([completedJob('legacy')],'builder');
    await f.db.query("UPDATE hosts SET image_builder=true WHERE id='builder'");
    f.setJobs([]);await f.worker.poll();
    assert.equal((await f.db.query('SELECT validation FROM emulator_images')).rows[0]?.validation,null);
    assert.ok(!f.commands.some(command=>['emulator-verify','emulator-build'].includes(command.action)));
  } finally {await f.close();}
});
