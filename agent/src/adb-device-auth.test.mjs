import assert from 'node:assert/strict';
import { constants, generateKeyPairSync, publicDecrypt, randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AdbDeviceAuth, adbTokenSigner, loadAdbTokenSigner } from './adb-device-auth.mjs';

const CNXN = 0x4e584e43, AUTH = 0x48545541;
const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const signer = adbTokenSigner(pair.privateKey.export({ type: 'pkcs8', format: 'pem' }));
function frame(command, arg0, arg1, payload = Buffer.alloc(0)) {
  const header = Buffer.alloc(24);
  header.writeUInt32LE(command, 0); header.writeUInt32LE(arg0, 4); header.writeUInt32LE(arg1, 8);
  header.writeUInt32LE(payload.length, 12);
  header.writeUInt32LE(payload.reduce((sum, byte) => (sum + byte) >>> 0, 0), 16);
  header.writeUInt32LE((command ^ 0xffffffff) >>> 0, 20);
  return Buffer.concat([header, payload]);
}
const connect = version => frame(CNXN, version, 1024 * 1024, Buffer.from('host::features=shell_v2;\0'));
const connected = version => frame(CNXN, version, 1024 * 1024, Buffer.from('device::features=shell_v2;\0'));

for (const version of [0x01000000, 0x01000001]) {
  test(`agent signs Android AUTH without exposing it to the authenticated user: protocol ${version}`, () => {
    const bridge = new AdbDeviceAuth(signer), initial = connect(version);
    assert.deepEqual(bridge.fromClient(initial.subarray(0, 13)), []);
    assert.deepEqual(bridge.fromClient(initial.subarray(13)), [initial]);
    const token = randomBytes(20), challenge = frame(AUTH, 1, 0, token);
    if (version === 0x01000001) challenge.writeUInt32LE(0, 16);
    assert.deepEqual(bridge.fromDevice(challenge.subarray(0, 29)), { toClient: [], toDevice: [] });
    const response = bridge.fromDevice(challenge.subarray(29));
    assert.deepEqual(response.toClient, []);
    assert.equal(response.toDevice.length, 1);
    const signature = response.toDevice[0];
    assert.equal(signature.readUInt32LE(0), AUTH);
    assert.equal(signature.readUInt32LE(4), 2);
    const plain = publicDecrypt({ key: pair.publicKey, padding: constants.RSA_PKCS1_PADDING }, signature.subarray(24));
    assert.deepEqual(plain, Buffer.concat([Buffer.from('3021300906052b0e03021a05000414', 'hex'), token]));
    const banner = connected(version);
    if (version === 0x01000001) banner.writeUInt32LE(0, 16);
    const data = randomBytes(256 * 1024); // Larger than a handshake; must survive coalescing.
    assert.deepEqual(bridge.fromDevice(Buffer.concat([banner, data])).toClient, [banner, data]);
    assert(bridge.ready);
    assert.equal(bridge.signToken, null);
    assert.deepEqual(bridge.fromClient(data), [data]);
    assert.deepEqual(bridge.fromDevice(data), { toClient: [data], toDevice: [] });
  });
}

test('a rejected service key closes authorization instead of offering a key or leaking Android AUTH', () => {
  const bridge = new AdbDeviceAuth(signer);
  bridge.fromClient(connect(0x01000001));
  bridge.fromDevice(frame(AUTH, 1, 0, randomBytes(20)));
  assert.throws(() => bridge.fromDevice(frame(AUTH, 1, 0, randomBytes(20))), /rejected/);
  assert(!bridge.ready);
});

test('malformed, oversized and out of order handshakes cannot obtain a signature', () => {
  let signatures = 0;
  const fresh = () => new AdbDeviceAuth(() => { signatures++; return Buffer.alloc(256); });
  assert.throws(() => fresh().fromDevice(frame(AUTH, 1, 0, randomBytes(20))), /before client/);
  assert.throws(() => fresh().fromClient(Buffer.alloc(4121)), /too large/);
  for (const challenge of [frame(AUTH, 3, 0, randomBytes(20)), frame(AUTH, 1, 1, randomBytes(20)), frame(AUTH, 1, 0, randomBytes(19))]) {
    const bridge = fresh(); bridge.fromClient(connect(0x01000001));
    assert.throws(() => bridge.fromDevice(challenge));
  }
  const broken = frame(AUTH, 1, 0, randomBytes(20)); broken.writeUInt32LE(100_000, 12);
  const bridge = fresh(); bridge.fromClient(connect(0x01000000));
  assert.throws(() => bridge.fromDevice(broken), /header/);
  const checksum = frame(AUTH, 1, 0, randomBytes(20)); checksum.writeUInt32LE(0, 16);
  const legacy = fresh(); legacy.fromClient(connect(0x01000000));
  assert.throws(() => legacy.fromDevice(checksum), /checksum/);
  assert.throws(() => bridge.fromClient(Buffer.from('pipelined')), /before device/);
  assert.equal(signatures, 0);
});

test('per-connection authentication remains independent and never changes user keys', () => {
  const one = new AdbDeviceAuth(signer), two = new AdbDeviceAuth(signer);
  one.fromClient(connect(0x01000001)); two.fromClient(connect(0x01000001));
  one.fromDevice(frame(AUTH, 1, 0, randomBytes(20)));
  two.fromDevice(frame(AUTH, 1, 0, randomBytes(20)));
  one.fromDevice(connected(0x01000001));
  assert(one.ready); assert(!two.ready);
  assert.throws(() => two.fromDevice(frame(AUTH, 1, 0, randomBytes(20))), /rejected/);
});

test('the agent signs with the private half of the exact public key given to Android', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'rdf-agent-adb-'));
  try {
    const keyPath = path.join(directory, 'custom-adbkey');
    await writeFile(keyPath, pair.privateKey.export({ type: 'pkcs1', format: 'pem' }), { mode: 0o600 });
    const fromFile = await loadAdbTokenSigner(keyPath + '.pub');
    const token = randomBytes(20);
    assert.deepEqual(fromFile(token), signer(token));
    await assert.rejects(loadAdbTokenSigner(keyPath), /end with/);
    assert.throws(() => signer(Buffer.alloc(21)), /token/);
    const small = generateKeyPairSync('rsa', { modulusLength: 1024 });
    assert.throws(() => adbTokenSigner(small.privateKey.export({ type: 'pkcs8', format: 'pem' })), /RSA-2048/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

for (const version of [0x01000000, 0x01000001]) {
  test(`agent rejects a device that accepts ADB without authentication: protocol ${version}`, () => {
    let signatures = 0;
    const bridge = new AdbDeviceAuth(() => { signatures++; return Buffer.alloc(256); });
    bridge.fromClient(connect(version));
    const banner = connected(version);
    assert.deepEqual(bridge.fromDevice(banner.subarray(0, 17)), { toClient: [], toDevice: [] });
    assert.throws(() => bridge.fromDevice(banner.subarray(17)), /after authorization/);
    assert.equal(signatures, 0);
    assert.equal(bridge.ready, false);
  });
}
