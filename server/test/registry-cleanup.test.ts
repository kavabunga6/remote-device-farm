import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import type { PoolClient } from 'pg';
import { DistributionRegistry, applyRegistryCleanup, cleanupReferences, planRegistryCleanup, registryCleanupCli,
  type CleanupRegistry, type Manifest } from '../src/registry-cleanup.js';

const A = 'sha256:' + 'a'.repeat(64), B = 'sha256:' + 'b'.repeat(64), C = 'sha256:' + 'c'.repeat(64), D = 'sha256:' + 'd'.repeat(64);
const repository = 'farm.example.com/rdf-emulator';
const manifest = (digest: string, children: string[] = []): Manifest => ({ digest, children, body: '{}', contentType: 'application/vnd.oci.image.manifest.v1+json' });
function fakeRegistry() {
  const calls: string[] = [];
  const tags = new Map([['current', B], ['unused', D]]);
  const manifests = new Map([[A, manifest(A)], [B, manifest(B, [C])], [C, manifest(C)], [D, manifest(D)]]);
  const registry: CleanupRegistry = {
    repositories: async () => ['rdf-emulator'], tags: async () => [...tags.keys()],
    resolve: async tag => { const digest = tags.get(tag); if (!digest) throw new Error('missing tag'); return digest; },
    manifest: async digest => { const value = manifests.get(digest); if (!value) throw new Error('missing digest'); return value; },
    retain: async (tag, item) => { calls.push('retain:' + item.digest); tags.set(tag, item.digest); },
    remove: async digest => { calls.push('delete:' + digest); manifests.delete(digest); },
  };
  return { registry, calls, tags, manifests };
}

test('dry-run protects old pinned, tag-resolved and child platform manifests without writing', async () => {
  const f = fakeRegistry();
  const plan = await planRegistryCleanup(f.registry, { repository, images: [repository + '@' + A, repository + ':current'], knownCompletedDigests: [A, B, C, D], activeSessions: 0, recentNodes: 0 });
  assert.deepEqual(plan.retain, [A, B, C]);
  assert.deepEqual(plan.remove, [D]);
  assert.deepEqual(f.calls, []);
  await applyRegistryCleanup(f.registry, plan, true);
  assert.deepEqual(f.calls, ['retain:' + A, 'retain:' + B, 'retain:' + C, 'delete:' + D]);
  assert.ok(f.tags.has('rdf-retain-' + A.slice(7)), 'untagged profiles survive global delete-untagged collection');
});

test('missing references, aliases and unrelated repositories fail closed', async () => {
  const f = fakeRegistry();
  const refs = { repository, images: [repository + ':missing'], knownCompletedDigests: [A, B, C, D], activeSessions: 0, recentNodes: 0 };
  await assert.rejects(planRegistryCleanup(f.registry, refs), /missing tag/);
  await assert.rejects(planRegistryCleanup(f.registry, { ...refs, images: [repository + '@sha256:' + 'f'.repeat(64)] }), /missing digest/);
  await assert.rejects(planRegistryCleanup(f.registry, { ...refs, images: ['old-farm.example/rdf-emulator@sha256:' + 'f'.repeat(64)] }), /missing digest/);
  f.registry.repositories = async () => ['rdf-emulator', 'other-consumer'];
  await assert.rejects(planRegistryCleanup(f.registry, { ...refs, images: [] }), /other repositories/);
  assert.deepEqual(f.calls, []);
});

test('apply requires maintenance, no running sessions or recent agents, and successful retention of every manifest', async () => {
  const f = fakeRegistry();
  const plan = await planRegistryCleanup(f.registry, { repository, images: [repository + '@' + A], knownCompletedDigests: [A, B, C, D], activeSessions: 0, recentNodes: 0 });
  await assert.rejects(applyRegistryCleanup(f.registry, plan, false), /maintenance/);
  await assert.rejects(applyRegistryCleanup(f.registry, { ...plan, activeSessions: 1 }, true), /Stop active/);
  await assert.rejects(applyRegistryCleanup(f.registry, { ...plan, recentNodes: 1 }, true), /heartbeats/);
  f.registry.retain = async () => { throw new Error('read-only registry'); };
  await assert.rejects(applyRegistryCleanup(f.registry, plan, true), /read-only/);
  assert.deepEqual(f.calls, [], 'no delete follows an incomplete retention phase');
});

test('distribution pagination is same-origin and manifest bytes must match digest', async () => {
  const body = JSON.stringify({ schemaVersion: 2, layers: [] });
  const digest = 'sha256:' + createHash('sha256').update(body).digest('hex');
  const calls: string[] = [];
  const registry = new DistributionRegistry('http://registry:5000', (async (url, init) => {
    const value = new URL(String(url)); calls.push((init?.method ?? 'GET') + ' ' + value.pathname + value.search);
    if (value.pathname === '/v2/_catalog') return Response.json({ repositories: ['rdf-emulator'] });
    if (value.pathname.endsWith('/tags/list')) {
      if (!value.searchParams.has('last')) return Response.json({ tags: ['first'] }, { headers: { link: '</v2/rdf-emulator/tags/list?n=100&last=first>; rel="next"' } });
      return Response.json({ tags: ['second'] });
    }
    return new Response(init?.method === 'HEAD' || init?.method === 'PUT' ? null : body, { status: init?.method === 'PUT' ? 201 : 200,
      headers: { 'content-type': 'application/vnd.oci.image.manifest.v1+json', 'docker-content-digest': digest } });
  }) as typeof fetch);
  assert.deepEqual(await registry.tags(), ['first', 'second']);
  assert.equal((await registry.manifest(digest)).digest, digest);
  await registry.retain('rdf-retain-' + digest.slice(7), await registry.manifest(digest));
  assert.ok(calls.some(call => call.startsWith('PUT ')));
  await assert.rejects(registry.manifest(A), /digest mismatch/);
  const foreign = new DistributionRegistry('http://registry:5000', (async () => Response.json({ tags: [] }, { headers: { link: '<https://other.example/v2/rdf-emulator/tags/list>; rel="next"' } })) as typeof fetch);
  await assert.rejects(foreign.tags(), /Foreign/);
});

test('database references include disabled profiles, live removed profiles, current images and queued pulls', async () => {
  const db = new PGlite();
  try {
    await db.exec(`CREATE TABLE registry_settings(id boolean,mode text,builtin_address text);
      INSERT INTO registry_settings VALUES(true,'builtin','farm.example.com');
      CREATE TABLE profiles(id text,image text,removed_at timestamptz,enabled boolean);
      CREATE TABLE sessions(profile_id text,state text,launch_image text);
      CREATE TABLE emulator_images(repository text,tag text,digest text);
      CREATE TABLE image_prewarm_jobs(image text,state text);
      CREATE TABLE hosts(removed_at timestamptz,last_seen_at timestamptz);
      CREATE TABLE emulator_image_job_receipts(repository text,digest text,state text);`);
    await db.query('INSERT INTO profiles VALUES($1,$2,null,false),($3,$4,now(),false)', ['disabled', repository + '@' + A, 'removed', repository + '@' + B]);
    await db.query("INSERT INTO sessions VALUES('removed','running',$1)", [repository + '@sha256:' + 'e'.repeat(64)]);
    await db.query('INSERT INTO emulator_images VALUES($1,$2,$3)', [repository, 'current', C]);
    await db.query("INSERT INTO emulator_image_job_receipts VALUES($1,$2,'done'),($1,$3,'failed'),('other.example/rdf-emulator',$4,'done')", [repository, A, B, D]);
    await db.query("INSERT INTO image_prewarm_jobs VALUES($1,'queued'),($2,'pulling'),($3,'failed')", [repository + ':prewarm@' + D, repository + ':other@' + A, repository + ':ignore@' + B]);
    const client = { query: async (sql: string, values?: unknown[]) => db.query(sql, values) } as unknown as PoolClient;
    const refs = await cleanupReferences(client);
    assert.ok(refs.images.includes(repository + '@' + A));
    assert.ok(refs.images.includes(repository + '@' + B));
    assert.ok(refs.images.includes(repository + '@sha256:' + 'e'.repeat(64)), 'immutable launch image survives later profile changes');
    assert.ok(refs.images.includes(repository + ':current@' + C));
    assert.ok(refs.images.includes(repository + ':prewarm@' + D));
    assert.ok(!refs.images.includes(repository + ':ignore@' + B));
    assert.equal(refs.activeSessions, 1);
    assert.deepEqual(refs.knownCompletedDigests.sort(), [A, C], 'only completed receipts for this registry establish known builds');
  } finally { await db.close(); }
});

test('CLI rejects apply without explicit maintenance and rejects contradictory flags before opening a database', async () => {
  await assert.rejects(registryCleanupCli(['--apply'], {}), /maintenance/);
  await assert.rejects(registryCleanupCli(['--apply', '--dry-run'], {}), /Usage/);
  await assert.rejects(registryCleanupCli(['--unknown'], {}), /Usage/);
});


test('a pushed build without a server receipt is preserved and blocks apply until reconciliation', async () => {
  const f = fakeRegistry();
  const refs = { repository, images: [repository + ':current'], knownCompletedDigests: [B], activeSessions: 0, recentNodes: 0 };
  const plan = await planRegistryCleanup(f.registry, refs);
  assert.deepEqual(plan.unreconciledTags, { unused: D });
  assert.ok(plan.retain.includes(D));
  assert.ok(!plan.remove.includes(D));
  await assert.rejects(applyRegistryCleanup(f.registry, plan, true), /Unreconciled build tags/);
  assert.deepEqual(f.calls, [], 'neither retention nor delete mutates registry while pending builds need import');
  const reconciled = await planRegistryCleanup(f.registry, { ...refs, knownCompletedDigests: [B, D] });
  assert.deepEqual(reconciled.unreconciledTags, {});
  assert.deepEqual(reconciled.remove, [D]);
});

test('only exact internally generated retention tags bypass missing build receipts', async () => {
  const f = fakeRegistry();
  f.tags.clear();
  f.tags.set('rdf-retain-' + D.slice(7), D);
  const refs = { repository, images: [], knownCompletedDigests: [], activeSessions: 0, recentNodes: 0 };
  assert.deepEqual((await planRegistryCleanup(f.registry, refs)).remove, [D]);
  f.tags.set('rdf-retain-custom-build', A);
  const plan = await planRegistryCleanup(f.registry, refs);
  assert.deepEqual(plan.unreconciledTags, { 'rdf-retain-custom-build': A });
  assert.ok(plan.retain.includes(A));
});
