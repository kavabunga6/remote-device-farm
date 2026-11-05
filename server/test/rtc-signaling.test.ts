import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type WebSocket from 'ws';
import type { AgentHub } from '../src/agent.js';
import { attachRtcSignaling } from '../src/rtc-signaling.js';
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(control = true, capabilities = { available: true, iceServers: [] as unknown[] }) {
  const messages: any[] = [], commands: any[] = [];
  const socket = Object.assign(new EventEmitter(), { readyState: 1, send: (raw: string) => messages.push(JSON.parse(raw)) });
  let offerResolve: (value: any) => void = () => {};
  let offerReject: (reason: Error) => void = () => {};
  const hub = { setViewerTransport: () => {}, command: async (...args: any[]) => {
    commands.push(args);
    if (args[2] === 'rtc-capabilities') return capabilities;
    if (args[2] === 'rtc-offer') return new Promise((resolve, reject) => { offerResolve = resolve; offerReject = reject; });
    return {};
  } };
  const bridge = attachRtcSignaling({ socket: socket as unknown as WebSocket, hub: hub as unknown as AgentHub,
    sessionId: 'session', hostId: 'host', canControl: control, activity: () => {}, enabled: true });
  return { bridge, messages, commands, socket, resolve: (v: any) => offerResolve(v), reject: (error: Error) => offerReject(error) };
}
test('viewer SDP cannot override session, peer identity or view-only permission', async () => {
  const f = fixture(false);
  await tick();
  f.bridge.handle({ type: 'rtc-offer', description: { type: 'offer', sdp: 'test' }, peerId: 'attacker', canControl: true, sessionId: 'other' });
  const offer = f.commands.find(c => c[2] === 'rtc-offer');
  assert.equal(offer[0], 'host'); assert.equal(offer[1], 'session');
  assert.equal(offer[3].canControl, false); assert.notEqual(offer[3].peerId, 'attacker');
  f.resolve({ description: { type: 'answer', sdp: 'answer' } }); await tick();
  assert.equal(f.messages.at(-1).type, 'rtc-answer');
  f.socket.emit('close'); await tick();
  assert.ok(f.commands.some(c => c[2] === 'rtc-close' && c[3].peerId === offer[3].peerId));
});
test('disconnect during negotiation closes late peer and never publishes answer', async () => {
  const f = fixture();
  await tick();
  f.bridge.handle({ type: 'rtc-offer', description: { type: 'offer', sdp: 'test' } });
  f.socket.emit('close'); f.resolve({ description: { type: 'answer', sdp: 'answer' } }); await tick();
  assert.equal(f.messages.some(m => m.type === 'rtc-answer'), false);
  assert.ok(f.commands.some(c => c[2] === 'rtc-close'));
});
test('invalid and concurrent offers are bounded; WSS cannot quietly inject RTC input', async () => {
  const f = fixture();
  await tick();
  f.bridge.handle({ type: 'rtc-offer', description: { type: 'answer', sdp: 'bad' } });
  assert.equal(f.commands.filter(c => c[2] === 'rtc-offer').length, 0);
  assert.equal(f.bridge.handle({ type: 'input', kind: 'key', keyCode: 3 }), true);
  assert.equal(f.messages.at(-1).code, 'wrong_transport');
  f.bridge.handle({ type: 'rtc-offer', description: { type: 'offer', sdp: 'test' } });
  f.bridge.handle({ type: 'rtc-offer', description: { type: 'offer', sdp: 'test' } });
  assert.equal(f.commands.filter(c => c[2] === 'rtc-offer').length, 1);
  f.resolve({ description: { type: 'answer', sdp: 'answer' } }); await tick(); f.bridge.close();
});

test('RTC offers cannot bypass pending or disabled agent capabilities', async () => {
  const f = fixture(true, { available: false, iceServers: [{ urls: 'turn:192.0.2.20:3478', credential: 'private' }] });
  try {
    const offer = { type: 'rtc-offer', description: { type: 'offer', sdp: 'test' } };
    f.bridge.handle(offer);
    assert.equal(f.commands.some(c => c[2] === 'rtc-offer'), false);
    await tick();
    const capabilities = f.messages.find(m => m.type === 'rtc-capabilities');
    assert.equal(capabilities.available, false);
    assert.deepEqual(capabilities.iceServers, []);
    f.bridge.handle(offer);
    assert.equal(f.commands.some(c => c[2] === 'rtc-offer'), false);
    assert.doesNotMatch(JSON.stringify(f.messages), /192\.0\.2\.20|private/);
  } finally { f.bridge.close(); }
});

test('negotiation failures do not expose agent network addresses', async () => {
  const f = fixture();
  try {
    await tick();
    f.bridge.handle({ type: 'rtc-offer', description: { type: 'offer', sdp: 'test' } });
    f.reject(new Error('connect ECONNREFUSED 192.0.2.20:50000'));
    await tick();
    assert.equal(f.messages.at(-1).type, 'rtc-error');
    assert.doesNotMatch(JSON.stringify(f.messages), /192\.0\.2\.20|ECONNREFUSED/);
    assert.equal(f.messages.some(m => m.type === 'rtc-answer'), false);
  } finally { f.bridge.close(); }
});
