import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { constants, createPrivateKey, privateEncrypt } from 'node:crypto';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import type { Config } from '../src/config.js';
import { allocateAdbPortAccess } from '../src/adb-access.js';
import { generateAdbKeyPair } from '../src/adb-key.js';
import { parseAdbPublicKey, verifyAdbSignature } from '../src/adb-wire.js';

test('downloaded key has stock adb PKCS#8 and complete Android RSA public fields', async () => {
  const generated = await generateAdbKeyPair();
  assert.match(generated.privateKey, /^-----BEGIN PRIVATE KEY-----/);
  assert.match(generated.publicKey, /^[A-Za-z0-9+/=]+ rdf@farm\n$/);
  assert.equal(createPrivateKey(generated.privateKey).asymmetricKeyDetails?.modulusLength, 2048);
  const wire = Buffer.from(generated.publicKey.split(' ')[0]!, 'base64');
  assert.equal(wire.length, 524);
  assert.equal(wire.readUInt32LE(0), 64);
  assert.equal(wire.readUInt32LE(520), 65537);
  const modulus = BigInt('0x' + Buffer.from(wire.subarray(8, 264)).reverse().toString('hex'));
  const n0inv = BigInt(wire.readUInt32LE(4));
  assert.equal(((modulus & 0xffffffffn) * n0inv) & 0xffffffffn, 0xffffffffn);
  const rr = BigInt('0x' + Buffer.from(wire.subarray(264, 520)).reverse().toString('hex'));
  assert.equal(rr, (1n << 4096n) % modulus);
  const parsed = parseAdbPublicKey(generated.publicKey);
  assert.equal(parsed.fingerprint, generated.fingerprint);
  const challenge = Buffer.from('00112233445566778899aabbccddeeff00112233', 'hex');
  const digestInfo = Buffer.from('3021300906052b0e03021a05000414', 'hex');
  const signature = privateEncrypt(
    { key: generated.privateKey, padding: constants.RSA_PKCS1_PADDING },
    Buffer.concat([digestInfo, challenge]),
  );
  assert.equal(verifyAdbSignature(parsed.key, challenge, signature), true);
});
test('saved public key survives session release while old leases keep their expiry', async () => {
  const database = new PGlite();
  try {
    await database.exec(await readFile(new URL('../migrations/001_init.sql', import.meta.url), 'utf8'));
    await database.exec(await readFile(new URL('../migrations/006_adb_port_access.sql', import.meta.url), 'utf8'));
    const userId = '11111111-1111-4111-8111-111111111111';
    const oldSession = '22222222-2222-4222-8222-222222222222';
    const newSession = '33333333-3333-4333-8333-333333333333';
    const pair = await generateAdbKeyPair();
    await database.query(
      "INSERT INTO users(id,provider,subject,username,display_name) VALUES($1,'local','owner','owner','Owner')",
      [userId],
    );
    await database.query("INSERT INTO hosts(id,name,slots) VALUES('host-1','Host',2)");
    await database.query(
      "INSERT INTO sessions(id,owner_user_id,host_id,profile_id,state) " +
      "VALUES($1,$3,'host-1','android-30','running'),($2,$3,'host-1','android-30','running')",
      [oldSession, newSession, userId],
    );
    await database.query(
      'INSERT INTO adb_port_access(session_id,owner_user_id,port,public_key,fingerprint,expires_at) ' +
      "VALUES($1,$2,15555,$3,$4,now() + interval '1 hour')",
      [oldSession, userId, pair.publicKey, pair.fingerprint],
    );
    await database.exec(await readFile(new URL('../migrations/008_user_adb_keys.sql', import.meta.url), 'utf8'));
    await database.query(
      'INSERT INTO user_adb_keys(user_id,public_key,fingerprint) VALUES($1,$2,$3)',
      [userId, pair.publicKey, pair.fingerprint],
    );
    const config = { adbPorts: { host: '127.0.0.1', start: 15555, count: 2 } } as Config;
    await database.query('BEGIN');
    const lease = await allocateAdbPortAccess(database, config, newSession, userId,
      { public_key: pair.publicKey, fingerprint: pair.fingerprint }, null);
    await database.query('COMMIT');
    assert.equal(lease.port, 15556);
    assert.equal(lease.expiresAt, null);
    const rows = await database.query<{ session_id: string; expires_at: Date | null }>(
      'SELECT session_id,expires_at FROM adb_port_access ORDER BY port',
    );
    assert.equal(rows.rows.length, 2);
    assert.ok(rows.rows[0]?.expires_at);
    assert.equal(rows.rows[1]?.expires_at, null);
    await database.query('DELETE FROM sessions WHERE id=$1', [newSession]);
    const saved = await database.query<{ public_key: string }>(
      'SELECT public_key FROM user_adb_keys WHERE user_id=$1', [userId],
    );
    assert.equal(saved.rows[0]?.public_key, pair.publicKey);
    const remaining = await database.query<{ session_id: string }>(
      'SELECT session_id FROM adb_port_access ORDER BY port',
    );
    assert.deepEqual(remaining.rows.map(row => row.session_id), [oldSession]);
    const columns = await database.query<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_name='user_adb_keys'",
    );
    assert.equal(columns.rows.some(row => row.column_name === 'private_key'), false);
  } finally {
    await database.close();
  }
});
