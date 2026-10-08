import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import pg, { type Pool } from 'pg';
import { SecretBox } from './secrets.js';

/** Run with all server processes stopped: their cached SecretBox would otherwise keep writing the old key. */
export async function migrateSecretsKey(pool: Pool, newKey: string, previousKey?: string): Promise<{ profiles: number; registry: number }> {
  if (newKey.length < 32) throw new Error('SECRETS_KEY must contain at least 32 characters');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Prevent writes during the rewrite, including scripts using the same database.
    await client.query('LOCK TABLE profiles, registry_settings, app_secrets IN ACCESS EXCLUSIVE MODE');
    const stored = (await client.query("SELECT value FROM app_secrets WHERE name='profile-env-key'")).rows[0]?.value;
    const oldKey = previousKey ? createHash('sha256').update(previousKey).digest() : stored ? Buffer.from(stored, 'base64') : null;
    const oldBox = oldKey ? new SecretBox(oldKey) : null;
    const nextBox = new SecretBox(createHash('sha256').update(newKey).digest());
    const rewrap = (value: string) => {
      if (SecretBox.isSealed(value) && !oldBox) throw new Error('Old key is unavailable; set PREVIOUS_SECRETS_KEY for an existing environment key');
      return nextBox.seal(oldBox ? oldBox.open(value) : value);
    };
    const profiles = (await client.query("SELECT id,container_env FROM profiles WHERE container_env <> '{}'::jsonb")).rows;
    for (const row of profiles) {
      const rewritten = Object.fromEntries(Object.entries(row.container_env as Record<string, unknown>)
        .map(([name, value]) => [name, typeof value === 'string' ? rewrap(value) : value]));
      await client.query('UPDATE profiles SET container_env=$2 WHERE id=$1', [row.id, rewritten]);
    }
    const registry = (await client.query('SELECT external_password FROM registry_settings WHERE id')).rows[0];
    if (registry?.external_password) await client.query('UPDATE registry_settings SET external_password=$1, updated_at=now() WHERE id', [rewrap(registry.external_password)]);
    await client.query("DELETE FROM app_secrets WHERE name='profile-env-key'");
    await client.query('COMMIT');
    return { profiles: profiles.length, registry: registry?.external_password ? 1 : 0 };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.env.RDF_SERVER_STOPPED !== '1') throw new Error('Stop every server process, then set RDF_SERVER_STOPPED=1 for this offline migration');
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const counts = await migrateSecretsKey(pool, process.env.SECRETS_KEY ?? '', process.env.PREVIOUS_SECRETS_KEY);
    console.log(`Encryption key migrated: ${counts.profiles} profiles, ${counts.registry} registry credentials. No secret values were printed.`);
  } catch {
    console.error('Key migration failed and was rolled back. Check the previous key and database configuration; do not start the server with a changed key.');
    process.exitCode = 1;
  } finally { await pool.end(); }
}
