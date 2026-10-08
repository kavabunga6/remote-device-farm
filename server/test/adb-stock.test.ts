import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { AdbDeviceAuth, adbTokenSigner } from '../../agent/src/adb-device-auth.mjs';
import net, { type AddressInfo, type Socket } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import type { Pool } from 'pg';
import type { Config } from '../src/config.js';
import type { AgentHub } from '../src/agent.js';
import { AdbPortBroker } from '../src/adb-port.js';
import { ADB_COMMAND_CONNECT, ADB_COMMAND_AUTH, adbFrame, newAdbChallenge, parseAdbPublicKey, readAdbHandshakeFrame, verifyAdbSignature } from '../src/adb-wire.js';
import { generateAdbKeyPair } from '../src/adb-key.js';

const adbBinary = process.env.RDF_STOCK_ADB;
const run = promisify(execFile);

async function freePort(): Promise<number> {
  const listener = net.createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const port = (listener.address() as AddressInfo).port;
  await new Promise<void>(resolve => listener.close(() => resolve()));
  return port;
}

test('stock adb authorizes a selected user key, executes Android shell through service-key auth and rejects other keys', { skip: !adbBinary }, async () => {
  const pair = await generateAdbKeyPair();
  const serviceKey = await generateAdbKeyPair();
  const trusted = parseAdbPublicKey(serviceKey.publicKey).key;
  const signServiceToken = adbTokenSigner(serviceKey.privateKey);
  const directory = await mkdtemp(path.join(os.tmpdir(), 'rdf-adb-stock-'));
  const trustedHome = path.join(directory, 'trusted');
  await mkdir(path.join(trustedHome, '.android'), { recursive: true, mode: 0o700 });
  const privatePath = path.join(trustedHome, '.android', 'adbkey');
  await writeFile(privatePath, pair.privateKey, { mode: 0o600 });
  await writeFile(privatePath + '.pub', pair.publicKey);
  const brokerPort = await freePort();
  const adbServerPort = await freePort();
  const sessionId = '11111111-1111-4111-8111-111111111111';
  const lease = { session_id: sessionId, host_id: 'host-1', owner_user_id: 'owner-1',
    public_key: pair.publicKey, fingerprint: pair.fingerprint, expires_at: null };
  const pool = { query: async () => ({ rows: [lease] }) } as unknown as Pool;
  let forwarded = 0, deviceAuthorizations = 0;
  const transports = new Set<Socket>();
  const android = net.createServer(device => {
    transports.add(device); device.on('error', () => {}); device.once('close', () => transports.delete(device));
    let buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0), stage = 'connect';
    const challenge = newAdbChallenge();
    device.on('data', bytes => {
      buffer = Buffer.concat([buffer, bytes]);
      try {
        while (buffer.length) {
          const parsed = readAdbHandshakeFrame(buffer); if (!parsed) return;
          buffer = parsed.rest; const p = parsed.packet;
          if (stage === 'connect') {
            assert.equal(p.command, ADB_COMMAND_CONNECT);
            device.write(adbFrame(ADB_COMMAND_AUTH, 1, 0, challenge)); stage = 'signature';
          } else if (stage === 'signature') {
            assert.equal(p.command, ADB_COMMAND_AUTH); assert.equal(p.arg0, 2);
            assert(verifyAdbSignature(trusted, challenge, p.payload), 'Android must accept only the service key');
            deviceAuthorizations++;
            device.write(adbFrame(ADB_COMMAND_CONNECT, 0x01000000, 256 * 1024,
              Buffer.from('device::ro.product.name=rdf;ro.product.model=Mock;\0'))); stage = 'shell';
          } else if (p.command === 0x4e45504f) { // OPEN. No shell_v2 advertised: stock adb uses legacy shell.
            assert.match(p.payload.toString(), /^shell:getprop sys\.boot_completed\0$/);
            device.write(adbFrame(0x59414b4f, 1, p.arg0));
            device.write(adbFrame(0x45545257, 1, p.arg0, Buffer.from('1\n')));
          } else if (p.command === 0x59414b4f) {
            device.write(adbFrame(0x45534c43, p.arg1, p.arg0));
          }
        }
      } catch { device.destroy(); }
    });
  });
  android.listen(0, '127.0.0.1'); await once(android, 'listening');
  const androidPort = (android.address() as AddressInfo).port;
  const hub = { onSessionClosed: () => {}, hasAgent: () => true,
    addDeviceTunnel: (_sessionId: string, _hostId: string, client: Socket, initial: Buffer) => {
      forwarded++;
      const bridge = new AdbDeviceAuth(signServiceToken);
      const device = net.connect({ host: '127.0.0.1', port: androidPort });
      transports.add(device); device.on('error', () => client.destroy());
      device.once('close', () => { transports.delete(device); client.destroy(); });
      client.once('close', () => device.destroy());
      device.once('connect', () => { for (const bytes of bridge.fromClient(initial)) device.write(bytes); });
      client.on('data', bytes => {
        try { for (const data of bridge.fromClient(bytes)) device.write(data); } catch { client.destroy(); }
      });
      device.on('data', bytes => {
        try {
          const { toClient, toDevice } = bridge.fromDevice(bytes);
          for (const data of toClient) client.write(data);
          for (const data of toDevice) device.write(data);
        } catch { client.destroy(); }
      });
      return true;
    } } as unknown as AgentHub;
  const config = { adbPorts: { host: '127.0.0.1', start: brokerPort, count: 1 } } as Config;
  const broker = new AdbPortBroker(pool, hub, config);
  const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(ADB_|ANDROID_)/i.test(key)));
  const env = { ...cleanEnv, HOME: trustedHome, ANDROID_USER_HOME: path.dirname(privatePath),
    ANDROID_SDK_HOME: trustedHome, ADB_VENDOR_KEYS: privatePath, ADB_LOCAL_TRANSPORT_MAX_PORT: '0', ADB_MDNS_AUTO_CONNECT: '0' };
  try {
    await broker.start();
    const result = await run(adbBinary!, ['-P', String(adbServerPort), 'connect', '127.0.0.1:' + brokerPort],
      { env, timeout: 12_000 });
    assert.match(result.stdout, /connected to 127\.0\.0\.1:/);
    const shell = await run(adbBinary!, ['-P', String(adbServerPort), '-s', '127.0.0.1:' + brokerPort,
      'shell', 'getprop', 'sys.boot_completed'], { env, timeout: 12_000 });
    assert.equal(shell.stdout.trim(), '1');
    assert.equal(forwarded, 1);
    assert.equal(deviceAuthorizations, 1);

    await run(adbBinary!, ['-P', String(adbServerPort), 'kill-server'], { env, timeout: 5_000 });
    const other = await generateAdbKeyPair();
    const untrustedHome = path.join(directory, 'untrusted');
    await mkdir(path.join(untrustedHome, '.android'), { recursive: true, mode: 0o700 });
    const otherPath = path.join(untrustedHome, '.android', 'adbkey');
    await writeFile(otherPath, other.privateKey, { mode: 0o600 });
    await writeFile(otherPath + '.pub', other.publicKey);
    const otherEnv = { ...env, HOME: untrustedHome, ANDROID_USER_HOME: path.dirname(otherPath),
      ANDROID_SDK_HOME: untrustedHome, ADB_VENDOR_KEYS: otherPath };
    await run(adbBinary!, ['-P', String(adbServerPort), 'connect', '127.0.0.1:' + brokerPort],
      { env: otherEnv, timeout: 12_000 }).catch(() => {});
    const devices = await run(adbBinary!, ['-P', String(adbServerPort), 'devices'], { env: otherEnv, timeout: 5_000 });
    assert(!devices.stdout.includes('127.0.0.1:' + brokerPort + '\tdevice'));
    assert.equal(forwarded, 1, 'Other keys must not reach the agent');
    assert.equal(deviceAuthorizations, 1);
  } finally {
    await run(adbBinary!, ['-P', String(adbServerPort), 'kill-server'], { env, timeout: 5_000 }).catch(() => {});
    await broker.stop();
    for (const socket of transports) socket.destroy();
    await new Promise<void>(resolve => android.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});