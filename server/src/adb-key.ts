import { diagnostic } from './diagnostics.js';
import { generateKeyPair, type KeyObject } from 'node:crypto';
import { promisify } from 'node:util';
import { parseAdbPublicKey } from './adb-wire.js';

const generateRsaPair = promisify(generateKeyPair);
const WORD_BYTES = 4;
const MODULUS_BYTES = 256;
const WORD_COUNT = MODULUS_BYTES / WORD_BYTES;
const WORD_MODULUS = 1n << 32n;

function littleEndian(value: bigint, bytes: number): Buffer {
  const result = Buffer.alloc(bytes);
  for (let index = 0; index < bytes; index++) {
    result[index] = Number(value & 255n);
    value >>= 8n;
  }
  if (value !== 0n) throw new Error(diagnostic('adb-key.c24b440938'));
  return result;
}

function publicKeyText(key: KeyObject): string {
  const jwk = key.export({ format: 'jwk' });
  const modulusBytes = Buffer.from(jwk.n!, 'base64url');
  const exponentBytes = Buffer.from(jwk.e!, 'base64url');
  if (modulusBytes.length !== MODULUS_BYTES ||
      BigInt('0x' + exponentBytes.toString('hex')) !== 65537n) {
    throw new Error(diagnostic('adb-key.4f03e73366'));
  }
  const modulus = BigInt('0x' + modulusBytes.toString('hex'));
  const lowWord = modulus & (WORD_MODULUS - 1n);
  // Android's RSAPublicKey contains -n[0]^-1 mod 2^32 and R^2 mod n.
  let inverse = 1n;
  for (let index = 0; index < 5; index++) {
    inverse = inverse * (2n - lowWord * inverse) & (WORD_MODULUS - 1n);
  }
  const n0inv = (-inverse) & (WORD_MODULUS - 1n);
  const rr = (1n << BigInt(MODULUS_BYTES * 16)) % modulus;
  const wire = Buffer.alloc(524);
  wire.writeUInt32LE(WORD_COUNT, 0);
  wire.writeUInt32LE(Number(n0inv), 4);
  littleEndian(modulus, MODULUS_BYTES).copy(wire, 8);
  littleEndian(rr, MODULUS_BYTES).copy(wire, 264);
  wire.writeUInt32LE(65537, 520);
  return wire.toString('base64') + ' rdf@farm\n';
}

export async function generateAdbKeyPair(): Promise<{ privateKey: string; publicKey: string; fingerprint: string }> {
  const { privateKey, publicKey } = await generateRsaPair('rsa', { modulusLength: 2048, publicExponent: 65537 });
  // adbkey uses an unencrypted PKCS#8 PEM file; the server never stores it.
  const privatePem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  const publicText = publicKeyText(publicKey);
  return { privateKey: privatePem, publicKey: publicText, fingerprint: parseAdbPublicKey(publicText).fingerprint };
}