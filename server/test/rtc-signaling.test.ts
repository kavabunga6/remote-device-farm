import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type WebSocket from 'ws';
import type { AgentHub } from '../src/agent.js';
import { attachRtcSignaling } from '../src/rtc-signaling.js';
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(control = true) {
  const messages: any[] = [], commands: any[] = [];
  const socket = Object.assign(new EventEmitter(), { readyState: 1, send: (raw: string) => messages.push(JSON.parse(raw)) });
  let offerResolve: (value: any) => void = () => {};
  const hub = { setViewerTransport: () => {}, command: async (...args: any[]) => {
    commands.push(args);
    if (args[2] === 'rtc-capabilities') return { available: true, iceServers: [] };
    if (args[2] === 'rtc-offer') return new Promise(resolve => { offerResolve = resolve; });
    return {};
  } };
  const bridge = attachRtcSignaling({ socket: socket as unknown as WebSocket, hub: hub as unknown as AgentHub,
    sessionId: 'session', hostId: 'host', canControl: control, activity: () => {}, enabled: true });
  return { bridge, messages, commands, socket, resolve: (v: any) => offerResolve(v) };
}
test('viewer SDP cannot override session, peer identity or view-only permission', async () => {
  const f = fixture(false);
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
  f.bridge.handle({ type: 'rtc-offer', description: { type: 'offer', sdp: 'test' } });
  f.socket.emit('close'); f.resolve({ description: { type: 'answer', sdp: 'answer' } }); await tick();
  assert.equal(f.messages.some(m => m.type === 'rtc-answer'), false);
  assert.ok(f.commands.some(c => c[2] === 'rtc-close'));
});
test('invalid and concurrent offers are bounded; WSS cannot quietly inject RTC input', async () => {
  const f = fixture();
  f.bridge.handle({ type: 'rtc-offer', description: { type: 'answer', sdp: 'bad' } });
  assert.equal(f.commands.filter(c => c[2] === 'rtc-offer').length, 0);
  assert.equal(f.bridge.handle({ type: 'input', kind: 'key', keyCode: 3 }), true);
  assert.equal(f.messages.at(-1).code, 'wrong_transport');
  f.bridge.handle({ type: 'rtc-offer', description: { type: 'offer', sdp: 'test' } });
  f.bridge.handle({ type: 'rtc-offer', description: { type: 'offer', sdp: 'test' } });
  assert.equal(f.commands.filter(c => c[2] === 'rtc-offer').length, 1);
  f.resolve({ description: { type: 'answer', sdp: 'answer' } }); await tick(); f.bridge.close();
});
