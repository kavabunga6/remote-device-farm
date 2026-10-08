import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import type { Pool } from 'pg';

const PREFIX = 'enc:v1:';

/** AES-256-GCM for values that must not be readable from the API, exports, logs or a casual database query. */
export class SecretBox {
  constructor(private readonly key: Buffer) {
    if (key.length !== 32) throw new Error('Secret key must be 32 bytes');
  }

  static isSealed(value: unknown): value is string {
    return typeof value === 'string' && value.startsWith(PREFIX);
  }

  seal(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64');
  }

  /** Values written before encryption existed have no prefix and are returned unchanged. */
  open(value: string): string {
    if (!SecretBox.isSealed(value)) return value;
    const raw = Buffer.from(value.slice(PREFIX.length), 'base64');
    const decipher = createDecipheriv('aes-256-gcm', this.key, raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
  }
}

const boxes = new WeakMap<Pool, Promise<SecretBox>>();

/** The key is SECRETS_KEY when configured, otherwise generated on first use and stored in app_secrets. */
export function getSecretBox(pool: Pool, secretsKey?: string): Promise<SecretBox> {
  const cached = boxes.get(pool);
  if (cached) return cached;
  const created = (async () => {
    if (secretsKey) return new SecretBox(createHash('sha256').update(secretsKey).digest());
    const read = async () => (await pool.query("SELECT value FROM app_secrets WHERE name='profile-env-key'")).rows[0]?.value as string | undefined;
    let stored = await read();
    if (!stored) {
      await pool.query("INSERT INTO app_secrets(name,value) VALUES('profile-env-key',$1) ON CONFLICT (name) DO NOTHING", [randomBytes(32).toString('base64')]);
      stored = await read();
    }
    return new SecretBox(Buffer.from(stored!, 'base64'));
  })();
  created.catch(() => boxes.delete(pool));
  boxes.set(pool, created);
  return created;
}

/** Container variables as stored: every value sealed. Entries that are null keep the value already stored. */
export async function sealEnv(box: SecretBox, incoming: Record<string, string | null>, existing: Record<string, unknown> = {}): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(incoming)) {
    if (value === null) {
      const kept = existing[name];
      if (typeof kept !== 'string') throw new Error(`No stored value to keep for ${name}`);
      result[name] = SecretBox.isSealed(kept) ? kept : box.seal(kept);
    } else result[name] = box.seal(value);
  }
  return result;
}

export function openEnv(box: SecretBox, stored: unknown): Record<string, string> {
  const result: Record<string, string> = {};
  if (stored && typeof stored === 'object') for (const [name, value] of Object.entries(stored as Record<string, unknown>)) if (typeof value === 'string') result[name] = box.open(value);
  return result;
}

/** Encrypts variables saved in plain text by earlier versions. Safe to run on every start. */
export async function sealLegacyProfileEnv(pool: Pool, secretsKey?: string): Promise<number> {
  const rows = (await pool.query("SELECT id,container_env FROM profiles WHERE container_env <> '{}'::jsonb")).rows;
  let changed = 0;
  for (const row of rows) {
    const env = row.container_env as Record<string, unknown>;
    if (Object.values(env).every(value => typeof value !== 'string' || SecretBox.isSealed(value))) continue;
    const box = await getSecretBox(pool, secretsKey);
    await pool.query('UPDATE profiles SET container_env=$2 WHERE id=$1', [row.id, await sealEnv(box, env as Record<string, string>)]);
    changed++;
  }
  return changed;
}
