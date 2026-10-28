import { diagnostic } from './diagnostics.mjs';
import { constants, createPrivateKey, privateEncrypt } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const CNXN = 0x4e584e43;
const AUTH = 0x48545541;
const TOKEN = 1;
const SIGNATURE = 2;
const SKIP_CHECKSUM_VERSION = 0x01000001;
const SHA1_DIGEST_INFO = Buffer.from('3021300906052b0e03021a05000414', 'hex');

// ADB supplies an already hashed, 20-byte token. Hashing it again would produce
// a signature that adbd rejects. Use the same RSA/SHA1 encoding as stock adb.
export function adbTokenSigner(pem) {
  const key = createPrivateKey(pem);
  if (key.asymmetricKeyType !== 'rsa' || key.asymmetricKeyDetails?.modulusLength !== 2048) {
    throw new Error(diagnostic('adb-device-auth.fe2e6dafae'));
  }
  return token => {
    if (!Buffer.isBuffer(token) || token.length !== 20) throw new Error(diagnostic('adb-device-auth.eaaea563f9'));
    return privateEncrypt({ key, padding: constants.RSA_PKCS1_PADDING }, Buffer.concat([SHA1_DIGEST_INFO, token]));
  };
}

export async function loadAdbTokenSigner(publicKeyPath) {
  if (!publicKeyPath.endsWith('.pub')) throw new Error(diagnostic('adb-device-auth.86e53eec68'));
  return adbTokenSigner(await readFile(publicKeyPath.slice(0, -4), 'utf8'));
}

function packet(bytes, skipChecksum) {
  if (bytes.length < 24) return null;
  const command = bytes.readUInt32LE(0), arg0 = bytes.readUInt32LE(4), arg1 = bytes.readUInt32LE(8);
  const length = bytes.readUInt32LE(12), checksum = bytes.readUInt32LE(16);
  if (length > 4096 || bytes.readUInt32LE(20) !== ((command ^ 0xffffffff) >>> 0)) {
    throw new Error(diagnostic('adb-device-auth.2adf58ea41'));
  }
  if (bytes.length < 24 + length) return null;
  const payload = bytes.subarray(24, 24 + length);
  const actual = payload.reduce((sum, value) => (sum + value) >>> 0, 0);
  if (checksum !== actual && !(skipChecksum && checksum === 0)) throw new Error(diagnostic('adb-device-auth.94ae6452ab'));
  return { command, arg0, arg1, payload, frame: bytes.subarray(0, 24 + length), rest: bytes.subarray(24 + length) };
}

function authSignature(signature) {
  const header = Buffer.alloc(24);
  header.writeUInt32LE(AUTH, 0);
  header.writeUInt32LE(SIGNATURE, 4);
  header.writeUInt32LE(signature.length, 12);
  header.writeUInt32LE(signature.reduce((sum, value) => (sum + value) >>> 0, 0), 16);
  header.writeUInt32LE((AUTH ^ 0xffffffff) >>> 0, 20);
  return Buffer.concat([header, signature]);
}

// The server has already authenticated the selected user's key. Only the agent
// signs Android's challenge with its own trusted key. Never forward that second
// AUTH to the client, enroll user keys in Android, or export the agent private key.
// After CNXN, stream bytes unchanged: sync, shell, install and forwarding retain
// their negotiated protocol version, features and maximum payload size.
export class AdbDeviceAuth {
  constructor(signToken) {
    this.signToken = signToken;
    this.state = 'connect';
    this.clientBuffer = Buffer.alloc(0);
    this.deviceBuffer = Buffer.alloc(0);
    this.skipChecksum = false;
    this.signed = false;
  }

  get ready() { return this.state === 'relay'; }

  fromClient(bytes) {
    if (this.ready) return [bytes];
    if (this.state !== 'connect') throw new Error(diagnostic('adb-device-auth.d6f60b530a'));
    this.clientBuffer = Buffer.concat([this.clientBuffer, bytes]);
    if (this.clientBuffer.length > 4120) throw new Error(diagnostic('adb-device-auth.7fd1a2f4f1'));
    const parsed = packet(this.clientBuffer, false);
    if (!parsed) return [];
    if (parsed.command !== CNXN || parsed.arg0 < 0x01000000 || parsed.arg1 < 4096 || parsed.rest.length) {
      throw new Error(diagnostic('adb-device-auth.086dd79405'));
    }
    this.skipChecksum = parsed.arg0 >= SKIP_CHECKSUM_VERSION;
    this.clientBuffer = Buffer.alloc(0);
    this.state = 'authorize';
    return [parsed.frame];
  }

  fromDevice(bytes) {
    if (this.ready) return { toClient: [bytes], toDevice: [] };
    if (this.state !== 'authorize') throw new Error(diagnostic('adb-device-auth.0659a742b9'));
    this.deviceBuffer = Buffer.concat([this.deviceBuffer, bytes]);
    const toClient = [], toDevice = [];
    while (this.deviceBuffer.length) {
      const parsed = packet(this.deviceBuffer, this.skipChecksum);
      if (!parsed) break;
      this.deviceBuffer = parsed.rest;
      if (parsed.command === AUTH) {
        if (parsed.arg0 !== TOKEN || parsed.arg1 !== 0 || parsed.payload.length !== 20 || this.signed) {
          throw new Error(diagnostic('adb-device-auth.fdebf04753'));
        }
        const signature = this.signToken(parsed.payload);
        if (!Buffer.isBuffer(signature) || signature.length !== 256) throw new Error(diagnostic('adb-device-auth.59c2b83b79'));
        toDevice.push(authSignature(signature));
        this.signed = true;
        continue;
      }
      if (!this.signed || parsed.command !== CNXN || parsed.arg0 < 0x01000000 || parsed.arg1 < 4096) {
        throw new Error(diagnostic('adb-device-auth.2cc06bb822'));
      }
      this.state = 'relay';
      this.signToken = null;
      toClient.push(parsed.frame);
      if (this.deviceBuffer.length) toClient.push(this.deviceBuffer);
      this.deviceBuffer = Buffer.alloc(0);
      break;
    }
    return { toClient, toDevice };
  }
}
