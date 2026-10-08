import { constants, createHash, createPublicKey, publicDecrypt, randomBytes, timingSafeEqual, type KeyObject } from 'node:crypto';

export const ADB_HEADER_BYTES = 24;
export const ADB_COMMAND_CONNECT = 0x4e584e43;
export const ADB_COMMAND_AUTH = 0x48545541;
export const ADB_AUTH_TOKEN = 1;
export const ADB_AUTH_SIGNATURE = 2;
const DIGEST_INFO_SHA1 = Buffer.from('3021300906052b0e03021a05000414', 'hex');
const ADB_PUBLIC_KEY_BYTES = 524;

export type AdbPublicKey = { key: KeyObject; fingerprint: string };

export function parseAdbPublicKey(input: unknown): AdbPublicKey {
  if (typeof input !== 'string' || input.length < 690 || input.length > 1024) throw new Error('Invalid ADB public key');
  const base64 = input.trim().split(/\s+/, 1)[0] || '';
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) throw new Error('Invalid ADB public key');
  const bytes = Buffer.from(base64, 'base64');
  if (bytes.length !== ADB_PUBLIC_KEY_BYTES || bytes.readUInt32LE(0) !== 64) throw new Error('ADB public key must be RSA-2048');
  const exponent = bytes.readUInt32LE(520);
  if (exponent !== 65537) throw new Error('ADB public key must use the standard RSA exponent');
  const modulus = Buffer.from(bytes.subarray(8, 264)).reverse();
  if (!(modulus[0]! & 0x80) || !(modulus[255]! & 1)) throw new Error('Invalid ADB public key modulus');
  const exponentBytes = Buffer.alloc(4);
  exponentBytes.writeUInt32BE(exponent);
  const key = createPublicKey({ key: { kty: 'RSA', n: modulus.toString('base64url'), e: exponentBytes.subarray(exponentBytes.findIndex(value => value !== 0)).toString('base64url') }, format: 'jwk' });
  if (key.asymmetricKeyDetails?.modulusLength !== 2048) throw new Error('ADB public key must be RSA-2048');
  return { key, fingerprint: createHash('sha256').update(bytes).digest('hex') };
}

export function verifyAdbSignature(key: KeyObject, token: Buffer, signature: Buffer): boolean {
  if (token.length !== 20 || signature.length !== 256) return false;
  let plain: Buffer;
  try { plain = publicDecrypt({ key, padding: constants.RSA_NO_PADDING }, signature); }
  catch { return false; }
  const paddingBytes = 256 - 3 - DIGEST_INFO_SHA1.length - token.length;
  const expected = Buffer.concat([
    Buffer.from([0, 1]), Buffer.alloc(paddingBytes, 0xff), Buffer.from([0]),
    DIGEST_INFO_SHA1, token,
  ]);
  return expected.length === plain.length && timingSafeEqual(expected, plain);
}

export type AdbPacket = { command: number; arg0: number; arg1: number; payload: Buffer; frame: Buffer };

export function adbFrame(command: number, arg0: number, arg1: number, payload: Buffer = Buffer.alloc(0)): Buffer {
  if (payload.length > 4096) throw new Error('ADB handshake payload too large');
  const header = Buffer.alloc(ADB_HEADER_BYTES);
  header.writeUInt32LE(command, 0);
  header.writeUInt32LE(arg0, 4);
  header.writeUInt32LE(arg1, 8);
  header.writeUInt32LE(payload.length, 12);
  let checksum = 0;
  for (const value of payload) checksum = (checksum + value) >>> 0;
  header.writeUInt32LE(checksum, 16);
  header.writeUInt32LE((command ^ 0xffffffff) >>> 0, 20);
  return Buffer.concat([header, payload]);
}

export function readAdbHandshakeFrame(bytes: Buffer): { packet: AdbPacket; rest: Buffer } | null {
  if (bytes.length < ADB_HEADER_BYTES) return null;
  const command = bytes.readUInt32LE(0);
  const arg0 = bytes.readUInt32LE(4);
  const arg1 = bytes.readUInt32LE(8);
  const length = bytes.readUInt32LE(12);
  const checksum = bytes.readUInt32LE(16);
  const magic = bytes.readUInt32LE(20);
  if (length > 4096 || magic !== ((command ^ 0xffffffff) >>> 0)) throw new Error('Invalid ADB packet header');
  if (bytes.length < ADB_HEADER_BYTES + length) return null;
  const payload = bytes.subarray(ADB_HEADER_BYTES, ADB_HEADER_BYTES + length);
  let actual = 0;
  for (const value of payload) actual = (actual + value) >>> 0;
  if (actual !== checksum) throw new Error('Invalid ADB packet checksum');
  const end = ADB_HEADER_BYTES + length;
  return { packet: { command, arg0, arg1, payload, frame: bytes.subarray(0, end) }, rest: bytes.subarray(end) };
}

export function newAdbChallenge(): Buffer { return randomBytes(20); }

