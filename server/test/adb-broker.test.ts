import assert from 'node:assert/strict';
import net, { type AddressInfo, type Socket } from 'node:net';
import { once } from 'node:events';
import { constants, generateKeyPairSync, privateEncrypt } from 'node:crypto';
import test from 'node:test';
import type { Pool } from 'pg';
import type { Config } from '../src/config.js';
import type { AgentHub } from '../src/agent.js';
import { AdbPortBroker } from '../src/adb-port.js';
import { ADB_AUTH_TOKEN, ADB_COMMAND_AUTH, ADB_COMMAND_CONNECT, adbFrame, readAdbHandshakeFrame } from '../src/adb-wire.js';

async function packetFrom(socket: Socket): Promise<NonNullable<ReturnType<typeof readAdbHandshakeFrame>>['packet']> {
  return await new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const timeout = setTimeout(() => { cleanup(); reject(new Error('ADB packet timeout')); }, 2000);
    const cleanup = () => { clearTimeout(timeout); socket.off('data', data); socket.off('error', error); };
    const error = (cause: Error) => { cleanup(); reject(cause); };
    const data = (bytes: Buffer) => {
      buffer = Buffer.concat([buffer, bytes]);
      try {
        const parsed = readAdbHandshakeFrame(buffer);
        if (parsed) { cleanup(); resolve(parsed.packet); }
      } catch (cause) { error(cause as Error); }
    };
    socket.on('data', data);
    socket.on('error', error);
  });
}

test('TCP broker forwards no emulator bytes until enrolled ADB key signs challenge and closes on revoke', async () => {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, publicExponent: 65537 });
  const jwk = publicKey.export({ format: 'jwk' });
  const wire = Buffer.alloc(524);
  wire.writeUInt32LE(64, 0);
  Buffer.from(jwk.n!, 'base64url').reverse().copy(wire, 8);
  wire.writeUInt32LE(65537, 520);
  const reservation = net.createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = (reservation.address() as AddressInfo).port;
  await new Promise<void>(resolve => reservation.close(() => resolve()));
  const sessionId = '11111111-1111-4111-8111-111111111111';
  const lease = { session_id: sessionId, host_id: 'host-1', owner_user_id: 'owner-1',
    public_key: wire.toString('base64') + ' test@host', fingerprint: 'fingerprint',
    expires_at: new Date(Date.now() + 60_000) };
  const pool = { query: async () => ({ rows: [lease] }) } as unknown as Pool;
  let forwarded: Buffer | null = null;
  const hub = { onSessionClosed: () => {}, hasAgent: () => true,
    addDeviceTunnel: (_sessionId: string, _hostId: string, _socket: Socket, initial: Buffer) => {
      forwarded = initial;
      return true;
    } } as unknown as AgentHub;
  const config = { adbPorts: { host: '127.0.0.1', start: port, count: 1 } } as Config;
  const broker = new AdbPortBroker(pool, hub, config);
  await broker.start();
  const client = net.connect({ host: '127.0.0.1', port });
  try {
    await once(client, 'connect');
    const connect = adbFrame(ADB_COMMAND_CONNECT, 0x01000000, 256 * 1024, Buffer.from('host::\0'));
    const challengePromise = packetFrom(client);
    client.write(connect);
    const challenge = await challengePromise;
    assert.equal(challenge.command, ADB_COMMAND_AUTH);
    assert.equal(challenge.arg0, ADB_AUTH_TOKEN);
    assert.equal(forwarded, null);
    const digestInfo = Buffer.from('3021300906052b0e03021a05000414', 'hex');
    const signature = privateEncrypt({ key: privateKey, padding: constants.RSA_PKCS1_PADDING },
      Buffer.concat([digestInfo, challenge.payload]));
    client.write(adbFrame(ADB_COMMAND_AUTH, 2, 0, signature));
    for (let i = 0; i < 100 && !forwarded; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.deepEqual(forwarded, connect);
    const closed = once(client, 'close');
    broker.closeSession(sessionId);
    await closed;
  } finally {
    client.destroy();
    await broker.stop();
  }
});


async function rejectingBroker() {
  const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048, publicExponent: 65537 });
  const jwk = publicKey.export({ format: 'jwk' }), wire = Buffer.alloc(524);
  wire.writeUInt32LE(64, 0);
  Buffer.from(jwk.n!, 'base64url').reverse().copy(wire, 8);
  wire.writeUInt32LE(65537, 520);
  const reservation = net.createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = (reservation.address() as AddressInfo).port;
  await new Promise<void>(resolve => reservation.close(() => resolve()));
  const lease = { session_id: '11111111-1111-4111-8111-111111111111', host_id: 'host-1', owner_user_id: 'owner-1',
    public_key: wire.toString('base64') + ' test@host', fingerprint: 'fingerprint', expires_at: new Date(Date.now() + 60_000) };
  const pool = { query: async () => ({ rows: [lease] }) } as unknown as Pool;
  let tunnelOpened = false;
  const hub = { onSessionClosed: () => {}, hasAgent: () => true,
    addDeviceTunnel: () => { tunnelOpened = true; return true; } } as unknown as AgentHub;
  const broker = new AdbPortBroker(pool, hub, { adbPorts: { host: '127.0.0.1', start: port, count: 1 } } as Config);
  await broker.start();
  const client = net.connect({ host: '127.0.0.1', port });
  await once(client, 'connect');
  const challenge = packetFrom(client);
  client.write(adbFrame(ADB_COMMAND_CONNECT, 0x01000000, 256 * 1024, Buffer.from('host::\0')));
  return { broker, client, challenge: await challenge, tunnelOpened: () => tunnelOpened };
}

test('TCP broker rejects another private key and never opens an emulator tunnel', async () => {
  const context = await rejectingBroker();
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, publicExponent: 65537 });
  try {
    let challenge = context.challenge;
    for (let attempt = 0; attempt < 3; attempt++) {
      const next = attempt < 2 ? packetFrom(context.client) : once(context.client, 'close', { signal: AbortSignal.timeout(2000) });
      const signature = privateEncrypt({ key: privateKey, padding: constants.RSA_PKCS1_PADDING },
        Buffer.concat([Buffer.from('3021300906052b0e03021a05000414', 'hex'), challenge.payload]));
      context.client.write(adbFrame(ADB_COMMAND_AUTH, 2, 0, signature));
      const response = await next;
      if (attempt < 2) {
        const refreshed = response as typeof challenge;
        assert.equal(refreshed.command, ADB_COMMAND_AUTH);
        assert.notDeepEqual(refreshed.payload, challenge.payload);
        challenge = refreshed;
      }
      assert.equal(context.tunnelOpened(), false);
    }
  } finally {
    context.client.destroy();
    await context.broker.stop();
  }
});

test('TCP broker cannot enroll an unknown public key in place of a valid signature', async () => {
  const context = await rejectingBroker();
  try {
    const closed = once(context.client, 'close', { signal: AbortSignal.timeout(2000) });
    context.client.write(adbFrame(ADB_COMMAND_AUTH, 3, 0, Buffer.from('unknown-key\0')));
    await closed;
    assert.equal(context.tunnelOpened(), false);
  } finally {
    context.client.destroy();
    await context.broker.stop();
  }
});
