import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { hashPassword, newToken, secureEqual, tokenHash, verifyPassword } from '../src/auth.js';
import { cleanAgentMetrics } from '../src/agent-report.js';
import { AgentHub } from '../src/agent.js';
import { loadConfig } from '../src/config.js';
import { hostJson, inputParams, isAllowedOrigin, parseHostSettings, parseProfile, safeUploadName } from '../src/index.js';
import type { IncomingMessage } from 'node:http';
import type { Pool } from 'pg';
import WebSocket from 'ws';

const base = {
  DATABASE_URL: 'postgres://test:test@localhost/test',
  AGENT_TOKEN: 'agent-token-with-at-least-thirty-two-chars',
  BOOTSTRAP_AGENT_ID: 'node-1',
  AUTH_MODE: 'none',
  ADMIN_TOKEN: 'admin-token-with-at-least-thirty-two-chars',
};

test('no-auth still requires an administrator credential and pinned agent ID', () => {
  assert.equal(loadConfig(base).authMode, 'none');
  assert.throws(() => loadConfig({ ...base, ADMIN_TOKEN: '' }), /ADMIN_TOKEN/);
  assert.throws(() => loadConfig({ ...base, BOOTSTRAP_AGENT_ID: 'node 2' }), /BOOTSTRAP_AGENT_ID/);
  assert.throws(() => loadConfig({ ...base, AGENT_TOKEN: 'short' }), /AGENT_TOKEN/);
});

test('LDAP requires TLS before credentials are sent', () => {
  assert.throws(() => loadConfig({ ...base, AUTH_MODE: 'ldap', LDAP_URL: 'ldap://directory:389', LDAP_BASE_DN: 'dc=example,dc=com', LDAP_BIND_DN: 'cn=reader', LDAP_BIND_PASSWORD: 'secret' }), /ldaps/);
  assert.equal(loadConfig({ ...base, AUTH_MODE: 'ldap', LDAP_URL: 'ldaps://directory:636', LDAP_BASE_DN: 'dc=example,dc=com', LDAP_BIND_DN: 'cn=reader', LDAP_BIND_PASSWORD: 'secret' }).ldap?.url, 'ldaps://directory:636');
});

test('passwords and API credentials do not remain as plaintext in storage', async () => {
  const password = 'a-long-local-admin-password';
  const stored = await hashPassword(password);
  assert.equal(stored.includes(password), false);
  assert.equal(await verifyPassword(password, stored), true);
  assert.equal(await verifyPassword('incorrect-password', stored), false);
  const raw = newToken();
  assert.notEqual(tokenHash(raw), raw);
  assert.equal(secureEqual(raw, raw), true);
  assert.equal(secureEqual(raw, `${raw}x`), false);
});

const profile = {
  id: 'android-35', name: 'Android 15', androidVersion: '15 (API 35)',
  image: 'us-docker.pkg.dev/android-emulator-268719/images/30-google-x64-no-metrics:30.1.2', cpu: 2, memoryMb: 4096,
  diskGb: 8, emulatorParams: '-no-snapshot',
};

test('administrator profiles accept image and emulator flags, reject shell metacharacters', () => {
  assert.equal(parseProfile(profile).image, profile.image);
  assert.ok(!('gpuSupport' in parseProfile({ ...profile, gpuSupport: 'none' })));
  assert.throws(() => parseProfile({ ...profile, emulatorParams: '-gpu host' }), /Invalid profile/);
  assert.throws(() => parseProfile({ ...profile, emulatorParams: '-no-window; touch /tmp/pwned' }), /Invalid profile/);
  assert.throws(() => parseProfile({ ...profile, image: '../evil' }), /Invalid profile/);
  assert.throws(() => parseProfile({ ...profile, cpu: 64 }), /Invalid profile/);
});

test('guest RAM and cores are separate from container limits and legacy flags remain valid', () => {
  const chosen = parseProfile({ ...profile, guestMemoryMb: 2048, guestCores: 2 });
  assert.equal(chosen.guestMemoryMb, 2048);
  assert.equal(chosen.guestCores, 2);
  const legacy = parseProfile({ ...profile, emulatorParams: '-memory 2048 -cores 2' });
  assert.equal(legacy.guestMemoryMb, null);
  assert.equal(legacy.guestCores, null);
  assert.throws(() => parseProfile({ ...profile, guestMemoryMb: 4096 }), /Invalid profile/);
  assert.throws(() => parseProfile({ ...profile, guestMemoryMb: 3072, emulatorParams: '-memory 2048' }), /Invalid profile/);
  assert.throws(() => parseProfile({ ...profile, guestCores: 3 }), /Invalid profile/);
  assert.throws(() => parseProfile({ ...profile, guestCores: 2, emulatorParams: '-cores 2' }), /Invalid profile/);
});

test('node slot caps cannot exceed the agent report and preserve the agent name', () => {
  assert.deepEqual(parseHostSettings({ displayName: ' Lab ', slotCap: 0 }, 1), { displayName: 'Lab', slotCap: 0 });
  assert.deepEqual(parseHostSettings({ displayName: '', slotCap: null }, 1), { displayName: null, slotCap: null });
  assert.throws(() => parseHostSettings({ slotCap: 2 }, 1), /Invalid host/);
  assert.throws(() => parseHostSettings({ displayName: 'bad\nname' }, 1), /Invalid host/);
  const host = hostJson({ id: 'node-1', name: 'Agent name', display_name: 'Lab', status: 'online', slots: 2, slot_cap: 1, used_slots: 1 });
  assert.equal(host.name, 'Lab');
  assert.equal(host.agentName, 'Agent name');
  assert.equal(host.slots, 1);
  assert.equal(host.usedSlots, 1);
});

test('browser input is constrained to the agent protocol', () => {
  assert.deepEqual(inputParams({ kind: 'tap', x: 150, y: 300 }), { kind: 'tap', x: 150, y: 300 });
  assert.deepEqual(inputParams({ kind: 'swipe', x1: 1, y1: 2, x2: 3, y2: 4, durationMs: 250 }),
    { kind: 'swipe', x1: 1, y1: 2, x2: 3, y2: 4, durationMs: 250 });
  assert.deepEqual(inputParams({ kind: 'key', keyCode: 4 }), { kind: 'key', keyCode: 4 });
  assert.deepEqual(inputParams({ kind: 'touch', action: 'move', pointerId: 0, x: 12, y: 34 }),
    { kind: 'touch', action: 'move', pointerId: 0, x: 12, y: 34 });
  assert.throws(() => inputParams({ kind: 'touch', action: 'hold', pointerId: 0, x: 12, y: 34 }), /Invalid touch/);
  assert.throws(() => inputParams({ kind: 'touch', action: 'down', pointerId: 1, x: 12, y: 34 }), /Invalid touch/);
  assert.throws(() => inputParams({ kind: 'touch', action: 'down', pointerId: 0, x: -1, y: 34 }), /Invalid touch/);
  assert.throws(() => inputParams({ kind: 'key', keyCode: 'BACK; rm -rf /' }), /Invalid key/);
  assert.throws(() => inputParams({ kind: 'tap', x: -1, y: 3 }), /Invalid coordinates/);
});

test('cookie requests need a trusted Origin or Referer', () => {
  const config = loadConfig({ ...base, PUBLIC_URL: 'https://farm.example.com' });
  const request = (headers: Record<string, string>) => ({ headers }) as unknown as IncomingMessage;
  assert.equal(isAllowedOrigin(request({ cookie: 'rdf_session=secret' }), config), false);
  assert.equal(isAllowedOrigin(request({ cookie: 'rdf_session=secret', origin: 'https://evil.example.com' }), config), false);
  assert.equal(isAllowedOrigin(request({ cookie: 'rdf_session=secret', origin: 'https://farm.example.com' }), config), true);
  assert.equal(isAllowedOrigin(request({ cookie: 'rdf_session=secret', referer: 'https://farm.example.com/sessions' }), config), true);
  assert.equal(isAllowedOrigin(request({ authorization: 'Bearer token' }), config), true);
});

test('upload names remain safe Unicode within the agent byte limit', () => {
  assert.equal(safeUploadName('Приложение.apk'), 'Приложение.apk');
  assert.equal(safeUploadName('../bad\\name\u0000.apk'), '.._bad_name_.apk');
  assert.equal(safeUploadName('..'), 'upload.bin');
  assert.equal(safeUploadName(''), 'upload.bin');
  assert.equal(safeUploadName('a'.repeat(300) + '.apk'), 'a'.repeat(236) + '.apk');
  const unicode = safeUploadName('😀'.repeat(100) + '.apk');
  assert.ok(Buffer.byteLength(unicode, 'utf8') <= 240);
  assert.ok(unicode.endsWith('.apk'));
  assert.equal(safeUploadName('bad\ud800name.apk'), 'bad_name.apk');
});

class FakeSocket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  bufferedAmount = 0;
  sent: string[] = [];
  closedWith?: number;
  terminated = false;
  send(data: string, optionsOrCallback?: unknown): void {
    this.sent.push(data);
    if (typeof optionsOrCallback === 'function') optionsOrCallback();
  }
  close(code?: number): void {
    this.closedWith = code;
    this.readyState = WebSocket.CLOSED;
    this.emit('close');
  }
  terminate(): void {
    this.terminated = true;
    this.close();
  }
}

test('ADB relay limits concurrent tunnels and closes connections when either peer stalls', async () => {
  const hub = new AgentHub({} as Pool);
  const agent = new FakeSocket();
  const internals = hub as unknown as {
    agents: Map<string, { ws: WebSocket; hostId: string; lastHeartbeat: number }>;
    onAgentMessage(ws: WebSocket, hostId: string, message: Record<string, unknown>, setLink: () => void): Promise<void>;
  };
  internals.agents.set('host-1', { ws: agent as unknown as WebSocket, hostId: 'host-1', lastHeartbeat: Date.now() });
  const clients = Array.from({ length: 9 }, () => new FakeSocket());
  for (const client of clients) hub.addTunnel('session-1', 'host-1', client as unknown as WebSocket);
  assert.equal(agent.sent.filter(value => JSON.parse(value).type === 'tunnel-open').length, 8);
  assert.equal(clients[8]?.closedWith, 1013);

  agent.bufferedAmount = 4 * 1024 * 1024 + 1;
  clients[0]?.emit('message', Buffer.from('0004test'), true);
  assert.equal(clients[0]?.closedWith, 1013);
  agent.bufferedAmount = 0;

  const secondTunnel = JSON.parse(agent.sent[1]!) as { tunnelId: string };
  clients[1]!.bufferedAmount = 4 * 1024 * 1024 + 1;
  await internals.onAgentMessage(agent as unknown as WebSocket, 'host-1', {
    type: 'tunnel-data', tunnelId: secondTunnel.tunnelId, data: Buffer.from('data').toString('base64'),
  }, () => {});
  assert.equal(clients[1]?.terminated, true);
});

test('agent host metrics preserve hardware details and reject malformed values', () => {
  const clean = cleanAgentMetrics;
  assert.deepEqual(clean({ gpuCapabilities: ['cuda', 'gpu', 'cuda', 'bogus', true] }), { gpuCapabilities: ['cuda', 'gpu'] });
  assert.deepEqual(clean({ gpuCapabilities: [], nvidiaGpuAvailable: true }), { gpuCapabilities: [], nvidiaGpuAvailable: true });
  assert.deepEqual(clean({ gpuCapabilities: 'cuda' }), {});
  assert.deepEqual(clean({
    cpuCores: 32, cpuThreads: 32, cpuPhysicalCores: 16,
    cpuModel: 'Example CPU', memoryTotalMb: 65536, memoryAvailableMb: 8192,
    gpuPresent: true, gpuModel: 'NVIDIA Example GPU', gpuVendor: 'NVIDIA',
    environmentType: 'bare-metal', agentRuntime: 'container', virtualizationType: 'KVM/QEMU',
    secret: 'must not persist',
  }), {
    cpuCores: 32, cpuThreads: 32, cpuPhysicalCores: 16,
    memoryTotalMb: 65536, memoryAvailableMb: 8192,
    gpuPresent: true, cpuModel: 'Example CPU',
    gpuModel: 'NVIDIA Example GPU', gpuVendor: 'NVIDIA',
    virtualizationType: 'KVM/QEMU', environmentType: 'bare-metal', agentRuntime: 'container',
  });
  assert.deepEqual(clean({
    cpuThreads: '32', gpuPresent: 'true', gpuModel: 'invalid\nname',
    environmentType: 'some guessed type', agentRuntime: 'host', memoryTotalMb: -1,
  }), {});
});

test('viewer backlog asks for a fresh keyframe only after draining and throttles requests', async () => {
  const hub = new AgentHub({} as Pool);
  const agent = new FakeSocket();
  const viewer = new FakeSocket();
  const unregistered = new FakeSocket();
  const hostId = 'host-1', sessionId = 'session-1';
  const internals = hub as unknown as {
    agents: Map<string, { ws: WebSocket; hostId: string; lastHeartbeat: number }>;
    sessionHosts: Map<string, string>;
    lastKeyframeRequest: Map<string, number>;
    onAgentMessage(ws: WebSocket, hostId: string, message: Record<string, unknown>, setLink: () => void): Promise<void>;
  };
  internals.agents.set(hostId, { ws: agent as unknown as WebSocket, hostId, lastHeartbeat: Date.now() });
  internals.sessionHosts.set(sessionId, hostId);
  hub.refreshStream = () => {};
  hub.addViewer(sessionId, hostId, viewer as unknown as WebSocket);
  const frame = (keyframe: boolean) => ({ type: 'video-frame', sessionId, keyframe, data: 'frame' });
  const relay = async (message: Record<string, unknown>) => internals.onAgentMessage(agent as unknown as WebSocket, hostId, message, () => {});
  await relay(frame(true));
  viewer.bufferedAmount = 256 * 1024 + 1;
  await relay(frame(false));
  assert.equal(agent.sent.length, 0);
  viewer.bufferedAmount = 0;
  const requests = () => agent.sent.map(data => JSON.parse(data) as { id: string; action: string }).filter(data => data.action === 'video-keyframe');
  for (let attempt = 0; attempt < 30 && requests().length === 0; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(requests().length, 1);
  await relay(frame(false));
  hub.requestKeyframe(sessionId, hostId, unregistered as unknown as WebSocket);
  hub.requestKeyframe(sessionId, hostId, viewer as unknown as WebSocket);
  assert.equal(requests().length, 1);
  await relay({ type: 'result', id: requests()[0]!.id, ok: true });
  internals.lastKeyframeRequest.set(sessionId, Date.now() - 1001);
  hub.requestKeyframe(sessionId, hostId, viewer as unknown as WebSocket);
  assert.equal(requests().length, 2);
  await relay({ type: 'result', id: requests()[1]!.id, ok: true });
  await relay(frame(true));
  assert.equal(JSON.parse(viewer.sent.at(-1)!).keyframe, true);
  // A request from another viewer may consume the per-session allowance while
  // this viewer is draining. Keep polling even if no further video frame arrives.
  viewer.bufferedAmount = 256 * 1024 + 1;
  await relay(frame(false));
  viewer.bufferedAmount = 0;
  internals.lastKeyframeRequest.set(sessionId, Date.now() - 600);
  for (let attempt = 0; attempt < 70 && requests().length < 3; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(requests().length, 3);
  await relay({ type: 'result', id: requests()[2]!.id, ok: true });
  internals.agents.delete(hostId);
  viewer.close();
  assert.equal(internals.lastKeyframeRequest.has(sessionId), false);
});


test('a closing viewer cannot submit input after access is revoked', async () => {
  const hub = new AgentHub({} as Pool);
  const viewer = new FakeSocket();
  viewer.readyState = WebSocket.CLOSING;
  await assert.rejects(hub.input('session-1', 'host-1', viewer as unknown as WebSocket,
    { type: 'input', id: 'input-1' }, { kind: 'key', keyCode: 3 }), /Viewer connection is closed/);
  await hub.dispose();
});
