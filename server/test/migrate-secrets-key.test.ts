import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import type { Pool } from 'pg';
import { SecretBox } from '../src/secrets.js';
import { migrateSecretsKey } from '../src/migrate-secrets-key.js';
import { initializeRegistry } from '../src/registry.js';

async function fixture() {
  const db = new PGlite();
  await db.exec(`CREATE TABLE profiles (id text PRIMARY KEY, container_env jsonb NOT NULL DEFAULT '{}');
    CREATE TABLE registry_settings(id boolean PRIMARY KEY, external_password text, builtin_address text, updated_at timestamptz);
    CREATE TABLE app_secrets(name text PRIMARY KEY, value text NOT NULL);
    INSERT INTO registry_settings(id) VALUES(true);`);
  const query = (sql: string, values?: unknown[]) => db.query(sql, values);
  const pool = { query, connect: async () => ({ query, release() {} }) } as unknown as Pool;
  return { db, pool };
}
const nextKey = 'a-safe-new-environment-secret-key-value';

test('offline key migration preserves profile and registry secrets and removes the database key', async () => {
  const { db, pool } = await fixture();
  try {
    const oldKey = randomBytes(32), oldBox = new SecretBox(oldKey);
    await db.query('INSERT INTO app_secrets VALUES ($1,$2)', ['profile-env-key', oldKey.toString('base64')]);
    await db.query('INSERT INTO profiles VALUES ($1,$2)', ['one', { TOKEN: oldBox.seal('sensitive-profile-value') }]);
    await db.query('UPDATE registry_settings SET external_password=$1', [oldBox.seal('sensitive-registry-value')]);
    assert.deepEqual(await migrateSecretsKey(pool, nextKey), { profiles: 1, registry: 1 });
    const nextBox = new SecretBox(createHash('sha256').update(nextKey).digest());
    const row = (await db.query<{ container_env: Record<string, string> }>('SELECT container_env FROM profiles')).rows[0]!;
    assert.equal(nextBox.open(row.container_env.TOKEN!), 'sensitive-profile-value');
    const registry = (await db.query<{ external_password: string }>('SELECT external_password FROM registry_settings')).rows[0]!;
    assert.equal(nextBox.open(registry.external_password), 'sensitive-registry-value');
    assert.equal((await db.query('SELECT * FROM app_secrets')).rows.length, 0);
    assert.throws(() => oldBox.open(row.container_env.TOKEN!));
  } finally { await db.close(); }
});

test('wrong previous key rolls back every rewritten value and retains the original key', async () => {
  const { db, pool } = await fixture();
  try {
    const raw = randomBytes(32), box = new SecretBox(raw);
    await db.query('INSERT INTO app_secrets VALUES ($1,$2)', ['profile-env-key', raw.toString('base64')]);
    const first = box.seal('first');
    await db.query('INSERT INTO profiles VALUES ($1,$2),($3,$4)', ['first', { TOKEN: first }, 'broken', { TOKEN: new SecretBox(randomBytes(32)).seal('wrong-key') }]);
    await assert.rejects(migrateSecretsKey(pool, nextKey));
    assert.equal((await db.query<{ container_env: { TOKEN: string } }>("SELECT container_env FROM profiles WHERE id='first'")).rows[0]!.container_env.TOKEN, first);
    assert.equal((await db.query('SELECT * FROM app_secrets')).rows.length, 1);
  } finally { await db.close(); }
});

test('registry startup seeds only a missing address and validates the environment value', async () => {
  const { db, pool } = await fixture();
  try {
    await initializeRegistry(pool, 'localhost:5000');
    await initializeRegistry(pool, 'different.example:443');
    assert.equal((await db.query<{ builtin_address: string }>('SELECT builtin_address FROM registry_settings')).rows[0]!.builtin_address, 'localhost:5000');
    await assert.rejects(initializeRegistry(pool, 'host/path'));
  } finally { await db.close(); }
});

test('rotation from an environment key requires and uses the previous environment value', async () => {
  const { db, pool } = await fixture();
  try {
    const previous = 'previous-environment-value-32-characters';
    const oldBox = new SecretBox(createHash('sha256').update(previous).digest());
    await db.query('INSERT INTO profiles VALUES ($1,$2)', ['one', { TOKEN: oldBox.seal('retained') }]);
    await assert.rejects(migrateSecretsKey(pool, nextKey), /Old key is unavailable/);
    await migrateSecretsKey(pool, nextKey, previous);
    const value = (await db.query<{ container_env: { TOKEN: string } }>('SELECT container_env FROM profiles')).rows[0]!.container_env.TOKEN;
    assert.equal(new SecretBox(createHash('sha256').update(nextKey).digest()).open(value), 'retained');
  } finally { await db.close(); }
});
