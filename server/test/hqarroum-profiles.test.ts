import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import type { Pool } from 'pg';
import { PROFILES, installProfiles } from '../../scripts/install-hqarroum-profiles.mjs';
import { migrate } from '../src/db.js';
import { parseProfile, profileJson } from '../src/http-common.js';
import { resolveProfileLaunch } from '../src/profile-launch.js';

type ProfileRow = Record<string, unknown> & { id: string };

async function fixture() {
  const db = new PGlite();
  // Adapt PGlite's result shape to pg, including multi-statement migrations.
  const query = async (sql: string, values?: unknown[]) => {
    const result = values === undefined ? (await db.exec(sql)).at(-1) : await db.query(sql, values);
    return { ...result, rowCount: result?.rows?.length || result?.affectedRows || 0 };
  };
  const pool = { query, connect: async () => ({ query, release() {} }) } as unknown as Pool;
  await migrate(pool);
  return { db, pool, snapshot: async () => (await db.query<ProfileRow>('SELECT * FROM profiles ORDER BY id')).rows };
}

test('HQarroum dry run lists missing profiles without changing the real catalogue', async () => {
  const f = await fixture();
  try {
    const before = await f.snapshot();
    const report = await installProfiles(f.pool, { validateProfile: parseProfile });
    assert.deepEqual(report.map((row: { id: string }) => row.id), PROFILES.map((profile: { id: string }) => profile.id));
    assert.ok(report.every((row: { action: string }) => row.action === 'would create enabled'));
    assert.deepEqual(await f.snapshot(), before);
  } finally { await f.db.close(); }
});

test('HQarroum apply is idempotent and preserves customized, disabled and removed profiles', async () => {
  const f = await fixture();
  try {
    // Existing Google profiles must not be re-enabled as a side effect of import.
    await f.db.query("UPDATE profiles SET enabled=false,name=name || ' customized'");
    const original = await f.snapshot();
    await installProfiles(f.pool, { apply: true, validateProfile: parseProfile });
    const created = await f.snapshot();
    assert.equal(created.length, original.length + PROFILES.length);
    assert.deepEqual(created.filter(row => original.some(previous => previous.id === row.id)), original);
    for (const profile of PROFILES) {
      const row = created.find(candidate => candidate.id === profile.id);
      assert.ok(row);
      assert.equal(row.enabled, true);
      assert.equal(row.recommended, false);
      assert.equal(row.removed_at, null);
      assert.equal(row.gpu_support, 'none');
      // Launch must remain compatible with the existing 4 CPU / 4 GiB slot.
      assert.ok(Number(row.cpu) <= 4);
      assert.ok(Number(row.memory_mb) <= 4096);
      assert.ok(Number(row.guest_memory_mb) <= Number(row.memory_mb) - 1024);
      assert.ok(Number(row.guest_cores) <= Number(row.cpu));
      assert.equal(row.disk_max_gb, row.disk_gb);
      assert.equal(row.sdcard_gb, null);
      assert.equal(row.sdcard_max_gb, null);
      assert.ok(!('gpuModes' in profileJson(row)) && !('gpuSupport' in profileJson(row)));
      assert.equal(resolveProfileLaunch(row, 'software').image, profile.image);
      assert.equal(resolveProfileLaunch(row, 'nvidia').image, profile.image);
    }
    await f.db.query("UPDATE profiles SET name='Custom name',cpu=6,enabled=false WHERE id=$1", [PROFILES[0].id]);
    await f.db.query('UPDATE profiles SET removed_at=now(),enabled=false WHERE id=$1', [PROFILES[1].id]);
    const beforeRepeat = await f.snapshot();
    await installProfiles(f.pool, { apply: true, validateProfile: parseProfile });
    assert.deepEqual(await f.snapshot(), beforeRepeat);
  } finally { await f.db.close(); }
});

test('HQarroum conflicting image aborts the entire import without changing other profiles', async () => {
  const f = await fixture();
  try {
    await f.db.query("INSERT INTO profiles(id,name,android_version,image,cpu,memory_mb,disk_gb) VALUES($1,'Unrelated','13','registry.example/other:1',4,4096,16)", [PROFILES.at(-1).id]);
    const before = await f.snapshot();
    await assert.rejects(installProfiles(f.pool, { apply: true, validateProfile: parseProfile }), /Profile ID collision/);
    assert.deepEqual(await f.snapshot(), before);
  } finally { await f.db.close(); }
});

test('HQarroum conflict after the initial read rolls back earlier insertions', async () => {
  const f = await fixture();
  try {
    const before = await f.snapshot();
    const client = await f.pool.connect();
    let injected = false;
    // PGlite has one connection. Inject a conflicting row after the initial
    // catalogue read to exercise the real ON CONFLICT and transaction rollback.
    const pool = { connect: async () => ({ release() {}, query: async (sql: string, values?: unknown[]) => {
      if (!injected && sql.startsWith('INSERT INTO profiles') && values?.[0] === PROFILES[1].id) {
        injected = true;
        await client.query("INSERT INTO profiles(id,name,android_version,image,cpu,memory_mb,disk_gb) VALUES($1,'Concurrent','12L','registry.example/other:2',4,4096,16)", [PROFILES[1].id]);
      }
      return client.query(sql, values);
    } }) };
    await assert.rejects(installProfiles(pool, { apply: true, validateProfile: parseProfile }), /Profile ID collision/);
    assert.equal(injected, true);
    assert.deepEqual(await f.snapshot(), before);
  } finally { await f.db.close(); }
});
