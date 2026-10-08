import assert from 'node:assert/strict';
import { generateKeyPairSync, privateEncrypt, constants } from 'node:crypto';
import test from 'node:test';
import {
  ADB_AUTH_SIGNATURE, ADB_AUTH_TOKEN, ADB_COMMAND_AUTH, ADB_COMMAND_CONNECT,
  adbFrame, parseAdbPublicKey, readAdbHandshakeFrame, verifyAdbSignature,
} from '../src/adb-wire.js';

function testKey() {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, publicExponent: 65537 });
  const jwk = publicKey.export({ format: 'jwk' });
  const modulus = Buffer.from(jwk.n!, 'base64url');
  const wire = Buffer.alloc(524);
  wire.writeUInt32LE(64, 0);
  Buffer.from(modulus).reverse().copy(wire, 8);
  wire.writeUInt32LE(65537, 520);
  return { text: wire.toString('base64') + ' test@host', privateKey };
}

test('broker verifies stock ADB RSA signature over its one-time challenge', () => {
  const { text, privateKey } = testKey();
  const parsed = parseAdbPublicKey(text);
  assert.match(parsed.fingerprint, /^[0-9a-f]{64}$/);
  const challenge = Buffer.from('00112233445566778899aabbccddeeff00112233', 'hex');
  const digestInfo = Buffer.from('3021300906052b0e03021a05000414', 'hex');
  const signature = privateEncrypt({ key: privateKey, padding: constants.RSA_PKCS1_PADDING },
    Buffer.concat([digestInfo, challenge]));
  assert.equal(verifyAdbSignature(parsed.key, challenge, signature), true);
  assert.equal(verifyAdbSignature(parsed.key, Buffer.alloc(20, 4), signature), false);
  assert.equal(verifyAdbSignature(parsed.key, challenge, Buffer.alloc(256)), false);
  assert.throws(() => parseAdbPublicKey('not a key'));
});

test('broker parses bounded ADB handshake frames and rejects forged headers', () => {
  const connect = adbFrame(ADB_COMMAND_CONNECT, 0x01000000, 256 * 1024, Buffer.from('host::\0'));
  const auth = adbFrame(ADB_COMMAND_AUTH, ADB_AUTH_TOKEN, 0, Buffer.alloc(20, 7));
  assert.equal(readAdbHandshakeFrame(connect.subarray(0, 23)), null);
  const parsed = readAdbHandshakeFrame(Buffer.concat([connect, auth]));
  assert.equal(parsed?.packet.command, ADB_COMMAND_CONNECT);
  assert.deepEqual(parsed?.packet.frame, connect);
  assert.deepEqual(parsed?.rest, auth);
  assert.equal(readAdbHandshakeFrame(adbFrame(ADB_COMMAND_AUTH, ADB_AUTH_SIGNATURE, 0, Buffer.alloc(256)))?.packet.arg0,
    ADB_AUTH_SIGNATURE);
  const forged = Buffer.from(connect);
  forged.writeUInt32LE(4097, 12);
  assert.throws(() => readAdbHandshakeFrame(forged));
  const badChecksum = Buffer.from(connect);
  badChecksum.writeUInt32LE(1, 16);
  assert.throws(() => readAdbHandshakeFrame(badChecksum));
});

