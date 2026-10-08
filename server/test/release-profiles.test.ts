import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import type { Pool } from 'pg';
import { migrate } from '../src/db.js';

test('migrations 034 and 035 remove non-release SDK profiles, keeps referenced ones disabled and leaves manual profiles', async () => {
  const db = new PGlite();
  const query = async (sql: string, values?: unknown[]) => {
    const result = values === undefined ? (await db.exec(sql)).at(-1) : await db.query(sql, values);
    return { ...result, rowCount: result?.rows?.length || result?.affectedRows || 0 };
  };
  await migrate({ query, connect: async () => ({ query, release() {} }) } as unknown as Pool);
  const add = (id: string, image: string, enabled = true) => db.query(
    "INSERT INTO profiles(id,name,android_version,image,cpu,memory_mb,disk_gb,enabled) VALUES($1,$1,'17',$2,2,4096,8,$3)", [id, image, enabled]);
  const canary = 'google-sdk-android-37-0-android-desktop-arm64-v8a';
  await add('sdk-dev', `rdf-sdk-emulator:${canary}`, false);
  await add('sdk-stable', 'rdf-sdk-emulator:google-sdk-android-34-google-apis-x86-64', false);
  await add('manual-beta', 'registry.example/emulator:beta');
  await add('sdk-dev-used', `rdf-sdk-emulator:${canary}`.replace('arm64-v8a', 'x86-64'), false);
  await db.query("UPDATE profiles SET enabled=true WHERE id='sdk-dev-used'");
  await db.query("INSERT INTO users(id,provider,subject,username,display_name,role) VALUES('11111111-1111-4111-8111-111111111111','local','u','u','u','user')");
  await db.query("INSERT INTO hosts(id,name,status,slots) VALUES('h','h','online',1)");
  await db.query("INSERT INTO sessions(id,owner_user_id,host_id,profile_id,state) VALUES('22222222-2222-4222-8222-222222222222','11111111-1111-4111-8111-111111111111','h','sdk-dev-used','stopped')");
  await db.exec(await readFile(new URL('../migrations/034_release_profiles_only.sql', import.meta.url), 'utf8'));
  const rows = (await db.query<{ id: string; enabled: boolean }>("SELECT id,enabled FROM profiles WHERE id IN ('sdk-dev','sdk-stable','manual-beta','sdk-dev-used') ORDER BY id")).rows;
  assert.deepEqual(rows, [{ id: 'manual-beta', enabled: true }, { id: 'sdk-dev-used', enabled: false }, { id: 'sdk-stable', enabled: false }]);
  await db.exec(await readFile(new URL('../migrations/035_remove_sdk_profiles.sql', import.meta.url), 'utf8'));
  const left = (await db.query<{ id: string; enabled: boolean }>("SELECT id,enabled FROM profiles WHERE id IN ('sdk-dev','sdk-stable','manual-beta','sdk-dev-used') ORDER BY id")).rows;
  assert.deepEqual(left, [{ id: 'manual-beta', enabled: true }, { id: 'sdk-dev-used', enabled: false }]);
  await db.close();
});


test('starter approval migration disables bundled clones, preserves custom images and session history', async () => {
  const db = new PGlite();
  try {
    const query = async (sql: string, values?: unknown[]) => {
      const result = values === undefined ? (await db.exec(sql)).at(-1) : await db.query(sql, values);
      return { ...result, rowCount: result?.rows?.length || result?.affectedRows || 0 };
    };
    await migrate({ query, connect: async () => ({ query, release() {} }) } as unknown as Pool);
    const original = (await db.query<{ image: string; enabled: boolean }>("SELECT image,enabled FROM profiles WHERE id='android-30'")).rows[0]!;
    assert.equal(original.enabled, false);
    await db.query("INSERT INTO profiles(id,name,android_version,image,cpu,memory_mb,disk_gb,enabled,recommended) VALUES('legacy-copy','Legacy','11',$1,2,4096,8,true,true)", [original.image]);
    await db.query("UPDATE profiles SET image='registry.example.com/approved-emulator:example',enabled=true WHERE id='android-30'");
    await db.query("INSERT INTO users(id,provider,subject,username,display_name,role) VALUES('11111111-1111-4111-8111-111111111111','local','example','example','Example','user')");
    await db.query("INSERT INTO hosts(id,name,status,slots) VALUES('example','Example','online',1)");
    await db.query("INSERT INTO sessions(id,owner_user_id,host_id,profile_id,state) VALUES('22222222-2222-4222-8222-222222222222','11111111-1111-4111-8111-111111111111','example','legacy-copy','stopped')");
    const sql = await readFile(new URL('../migrations/051_disable_unverified_starter.sql', import.meta.url), 'utf8');
    await db.exec(sql);
    await db.exec(sql);
    assert.deepEqual((await db.query("SELECT id,enabled,recommended FROM profiles ORDER BY id")).rows, [
      { id: 'android-30', enabled: true, recommended: false },
      { id: 'legacy-copy', enabled: false, recommended: false },
    ]);
    assert.equal((await db.query("SELECT count(*)::int AS count FROM sessions WHERE profile_id='legacy-copy'")).rows[0]?.count, 1);
  } finally { await db.close(); }
});
