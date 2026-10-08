import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import type { Pool } from 'pg';
import { migrate } from '../src/db.js';
import { ImageManagement } from '../src/image-management.js';
import { ApiError } from '../src/http-common.js';
import { defaultPolicy, registryCandidates, type ManagedImage } from '../src/image-retention.js';
import { requestPermission } from '../src/request-permissions.js';
import type { RegistryMaintenance } from '../src/image-maintenance-client.js';
const A = 'sha256:' + 'a'.repeat(64), B = 'sha256:' + 'b'.repeat(64), C = 'sha256:' + 'c'.repeat(64), repo = 'registry/rdf-emulator';
async function fixture() {
  const db = new PGlite();
  const query = async (sql: string, values?: unknown[]) => {
    if (sql.includes('pg_try_advisory_lock')) return { rows: [{ acquired: true }], rowCount: 1 };
    if (sql.includes('pg_advisory_unlock')) return { rows: [], rowCount: 1 };
    const result = values === undefined ? (await db.exec(sql)).at(-1) : await db.query(sql, values);
    return { ...result, rowCount: result?.rows?.length || result?.affectedRows || 0 };
  };
  const pool = { query, connect: async () => ({ query, release() { } }) } as unknown as Pool; await migrate(pool);
  await db.query("UPDATE registry_settings SET builtin_address='registry' WHERE id");
  await db.query("INSERT INTO hosts(id,name,slots) VALUES('node','Node',2)");
  let inventory = [{ digest: A, tags: ['a'], createdAt: '2026-01-01T00:00:00Z', package: 'sdk', sizeBytes: 1000, children: [] }, { digest: B, tags: ['b'], createdAt: '2026-02-01T00:00:00Z', package: 'sdk', sizeBytes: 1000, children: [] }];
  const submissions: Array<{ id: string; digests: string[] }> = [];
  const registry: RegistryMaintenance = {
    inventory: async () => ({ repositories: ['rdf-emulator'], items: inventory, maintenance: false }),
    submit: async (id, digests) => { submissions.push({ id, digests }); return { id, state: 'running', stage: 'deleting', deleted: [] }; },
    status: async id => { inventory = inventory.filter(item => item.digest !== A); return { id, state: 'done', stage: 'done', deleted: [A] }; }
  };
  const hub = { hasAgent: () => true, command: async () => ({ jobs: [] }) };
  const manager = new ImageManagement(pool, hub as any, registry);
  const profile = async (id = 'profile', image = repo + ':a@' + A) => db.query("INSERT INTO profiles(id,name,android_version,image,cpu,memory_mb,disk_gb) VALUES($1,$1,'16',$2,2,4096,8)", [id, image]);
  return { db, pool, manager, submissions, profile, inventory, registry, hub, close: () => db.close() };
}
test('retention groups by package and protects references, unknown builds and recent versions', () => {
  const make = (digest: string, createdAt: string): ManagedImage => ({ digest, createdAt, tags: [], children: [], package: 'sdk', sizeBytes: 1, uses: [], blockers: [], known: true });
  const items = [make(A, '2026-01-01T00:00:00Z'), make(B, '2026-02-01T00:00:00Z'), make(C, '2026-03-01T00:00:00Z')];
  assert.deepEqual(registryCandidates(items, { ...defaultPolicy, registryKeep: 1 }, Date.parse('2026-10-01')).map(item => item.digest), [A, B]);
  items[0].uses = [{ kind: 'profile', id: 'p', name: 'p', image: 'x' }]; items[1].known = false; assert.deepEqual(registryCandidates(items, { ...defaultPolicy, registryKeep: 1 }, Date.parse('2026-10-01')), []);
});
test('explicit deletion disables profiles, persists intent and blocks reenabling a deleted digest', async () => {
  const f = await fixture(); try {
    await f.profile();
    const input = { scope: 'registry', action: 'delete', digests: [A] };
    const plan = await f.manager.preview(input); assert.equal(plan.blocked, false); assert.equal(plan.items[0].uses[0].kind, 'profile');
    const result = await f.manager.enqueue({ ...input, token: plan.token }, null); await f.manager.poll();
    assert.equal((await f.db.query("SELECT enabled FROM profiles WHERE id='profile'")).rows[0].enabled, false);
    assert.equal(f.submissions[0].id, result.id);
    await f.manager.poll(); f.inventory.splice(0, 1);
    await assert.rejects(f.db.query("UPDATE profiles SET enabled=true WHERE id='profile'"), /image_removed/);
  } finally { await f.close(); }
});
test('profile deletion option uses existing soft deletion and stale previews never mutate data', async () => {
  const f = await fixture(); try {
    await f.profile(); const input = { scope: 'registry', action: 'delete', digests: [A], removeProfiles: true }; const plan = await f.manager.preview(input);
    await f.profile('another'); await assert.rejects(f.manager.enqueue({ ...input, token: plan.token }, null), { code: 'changed' });
    const fresh = await f.manager.preview(input); await f.manager.enqueue({ ...input, token: fresh.token }, null); await f.manager.poll();
    assert.ok((await f.db.query("SELECT removed_at FROM profiles WHERE id='profile'")).rows[0].removed_at);
  } finally { await f.close(); }
});
test('queued sessions block deletion and scheduled cleanup defaults to disabled', async () => {
  const f = await fixture(); try {
    await f.profile(); await f.db.query("INSERT INTO users(id,provider,subject,username,display_name) VALUES('11111111-1111-4111-8111-111111111111','local','test','test','test')");
    await f.db.query("INSERT INTO queue_entries(id,user_id,profile_id,expires_at) VALUES('22222222-2222-4222-8222-222222222222','11111111-1111-4111-8111-111111111111','profile',now()+interval '1 hour')");
    const plan = await f.manager.preview({ scope: 'registry', action: 'delete', digests: [A] }); assert.equal(plan.blocked, true);
    assert.deepEqual(plan.items[0].blockers, ['queue']); const policy = await f.manager.policy(); assert.equal(policy.cacheEnabled, false); assert.equal(policy.registryEnabled, false);
    await assert.rejects(f.manager.savePolicy({ ...defaultPolicy, registryDays: 0 })); assert.equal(requestPermission('GET', '/api/admin/image-management/jobs'), 'images.view');
  } finally { await f.close(); }
});


test('failed registry cleanup keeps profiles disabled but unlocks only confirmed existing digests', async () => {
  const f = await fixture(); try {
    await f.profile(); const input = { scope: 'registry', action: 'delete', digests: [A] }; const plan = await f.manager.preview(input);
    await f.manager.enqueue({ ...input, token: plan.token }, null); await f.manager.poll();
    f.registry.status = async id => ({ id, state: 'failed', stage: 'deleting', deleted: [], errorCode: 'registry_cleanup_failed' });
    await f.manager.poll();
    assert.equal((await f.db.query("SELECT enabled FROM profiles WHERE id='profile'")).rows[0].enabled, false);
    assert.equal((await f.db.query('SELECT * FROM image_removals')).rows.length, 0);
    await f.db.query("UPDATE profiles SET enabled=true WHERE id='profile'");
  } finally { await f.close(); }
});

test('lost supervisor job recovers only remaining manifests and still collects storage', async () => {
  const f = await fixture(); try {
    const input = { scope: 'registry', action: 'delete', digests: [A] }; const plan = await f.manager.preview(input);
    await f.manager.enqueue({ ...input, token: plan.token }, null); await f.manager.poll();
    f.registry.status = async () => null; f.inventory.splice(0, 1);
    await f.manager.poll(); assert.deepEqual(f.submissions.at(-1)?.digests, []);
    assert.equal((await f.db.query('SELECT * FROM image_removals')).rows.length, 1, 'missing digest stays blocked');
  } finally { await f.close(); }
});

test('retention preserves every descendant of a retained manifest index', () => {
  const child: ManagedImage = { digest: A, tags: [], children: [], package: 'sdk', createdAt: '2026-01-01T00:00:00Z', sizeBytes: 1, uses: [], blockers: [], known: true };
  const parent: ManagedImage = { ...child, digest: B, children: [A], uses: [{ kind: 'profile', id: 'p', name: 'p', image: 'x' }] };
  assert.deepEqual(registryCandidates([child, parent], { ...defaultPolicy, registryKeep: 1 }, Date.parse('2026-10-01')), []);
});


test('physical GC is blocked when the storage contains another repository', async () => {
  const f = await fixture(); try {
    const base = f.registry.inventory; f.registry.inventory = async () => ({ ...await base(), repositories: ['rdf-emulator', 'unrelated'] });
    const plan = await f.manager.preview({ scope: 'registry', action: 'gc' }); assert.equal(plan.blocked, true);
    await assert.rejects(f.manager.enqueue({ scope: 'registry', action: 'gc', token: plan.token }, null), { code: 'protected' });
    assert.equal(f.submissions.length, 0);
  } finally { await f.close(); }
});


test('post-cleanup inventory outages keep reconciliation pending until existence can be confirmed', async () => {
  const f = await fixture(); try {
    const input = { scope: 'registry', action: 'delete', digests: [A] }; const plan = await f.manager.preview(input);
    await f.manager.enqueue({ ...input, token: plan.token }, null); await f.manager.poll();
    const inventory = f.registry.inventory;
    f.registry.inventory = async () => { throw new ApiError(503, 'image_management_unavailable', 'unavailable'); };
    await f.manager.poll(); assert.equal((await f.db.query('SELECT state FROM image_cleanup_jobs')).rows[0].state, 'running');
    f.registry.inventory = inventory;
    await f.manager.poll(); assert.equal((await f.db.query('SELECT state FROM image_cleanup_jobs')).rows[0].state, 'done');
  } finally { await f.close(); }
});


test('cache deletion reaches only the selected node and preserves protected server references', async () => {
  const f = await fixture(); try {
    await f.profile(); const calls: any[] = [];
    const item = { id: B, tags: [repo + ':old'], digests: [repo + '@' + B], sizeBytes: 1000, package: 'sdk', firstSeenAt: '2026-01-01T00:00:00Z', lastUsedAt: null, containers: [], blockers: [] };
    Object.assign(f.hub, {
      command: async (host: string, id: string, action: string, params: any) => {
        calls.push({ host, id, action, params });
        return action === 'image-cache' ? { items: [{ ...item, blockers: [] }] } : { removed: [B], failed: [] };
      }
    });
    const input = { scope: 'cache', action: 'delete', hostId: 'node', ids: [B] }; const plan = await f.manager.preview(input);
    assert.equal(plan.blocked, false); await f.manager.enqueue({ ...input, token: plan.token }, null); await f.manager.poll();
    const removal = calls.find(call => call.action === 'image-cache-remove'); assert.equal(removal.host, 'node'); assert.deepEqual(removal.params.ids, [B]); assert.ok(removal.params.protectedRefs.includes(repo + ':a@' + A));
    assert.equal((await f.db.query('SELECT state FROM image_cleanup_jobs')).rows[0].state, 'done');
    await f.profile('uses-cache', repo + '@' + B);
    const protectedPlan = await f.manager.preview(input); assert.equal(protectedPlan.blocked, true); assert.ok(protectedPlan.items[0].blockers.includes('reference'), 'server protects its references independently of agent blockers');
  } finally { await f.close(); }
});


test('immutable references through an old registry hostname remain associated and cannot bypass removal', async () => {
  const f = await fixture(); try {
    await f.profile('alias', 'old.registry.example/rdf-emulator:current@' + A);
    const input = { scope: 'registry', action: 'delete', digests: [A] }; const plan = await f.manager.preview(input);
    assert.equal(plan.items[0].uses[0].id, 'alias'); await f.manager.enqueue({ ...input, token: plan.token }, null); await f.manager.poll(); await f.manager.poll();
    assert.equal((await f.db.query("SELECT enabled FROM profiles WHERE id='alias'")).rows[0].enabled, false);
    await assert.rejects(f.db.query("UPDATE profiles SET enabled=true WHERE id='alias'"), /image_removed/);
  } finally { await f.close(); }
});
