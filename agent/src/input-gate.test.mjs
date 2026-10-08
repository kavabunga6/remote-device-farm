import test from 'node:test';
import assert from 'node:assert/strict';
import { InputGate } from './input-gate.mjs';
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
function fixture(options = {}) {
  let now = 10000;
  const releases = [];
  const gate = new InputGate({ now: () => now, releaseInput: async id => { releases.push(id); }, ...options });
  gate.open('s', A); gate.open('s', B);
  const meta = (seq, epoch = A) => ({ epoch, seq, deadline: now + 1000 });
  return { gate, releases, meta, advance: ms => { now += ms; } };
}
const flush = () => new Promise(resolve => setImmediate(resolve));

test('stale, duplicate and wrong-epoch inputs never reach the device', async () => {
  const f = fixture(); const calls = [];
  await f.gate.dispatch('s', f.meta(1), { kind: 'key' }, () => calls.push('key'));
  assert.throws(() => f.gate.dispatch('s', f.meta(1), {}, () => calls.push('replay')), /already received/);
  assert.throws(() => f.gate.dispatch('s', { ...f.meta(2), deadline: 9999 }, {}, () => {}), /expired/);
  assert.throws(() => f.gate.dispatch('s', { ...f.meta(3), deadline: 99999 }, {}, () => {}), /expired/);
  assert.throws(() => f.gate.dispatch('s', { ...f.meta(4), epoch: 'other' }, {}, () => {}), /closed/);
  assert.deepEqual(calls, ['key']);
});

test('expired queued input is discarded after a slow predecessor', async () => {
  const f = fixture(); let finish; let executed = false;
  const first = f.gate.dispatch('s', f.meta(1), {}, () => new Promise(resolve => { finish = resolve; }));
  await flush();
  const second = f.gate.dispatch('s', f.meta(2), {}, () => { executed = true; });
  const rejected = assert.rejects(second, /expired/);
  f.advance(1100); finish(); await first; await rejected;
  assert.equal(executed, false);
});

test('owner disconnect releases held contacts while another spectator remains', async () => {
  const f = fixture();
  await f.gate.dispatch('s', f.meta(1), { kind: 'touch', action: 'down' }, async () => {});
  await assert.rejects(f.gate.dispatch('s', f.meta(1, B), { kind: 'key' }, async () => {}), /Another viewer/);
  await f.gate.release('s', A);
  assert.deepEqual(f.releases, ['s']);
  assert.throws(() => f.gate.dispatch('s', f.meta(2), {}, () => {}), /closed/);
  await f.gate.dispatch('s', f.meta(2, B), { kind: 'key' }, async () => {});
  assert.deepEqual(f.releases, ['s']);
});

test('disconnect invalidates an input already waiting for a device lock', async () => {
  const f = fixture(); let unlock; let executed = false;
  const queued = f.gate.dispatch('s', f.meta(1), { kind: 'text' }, fresh => new Promise(resolve => { unlock = resolve; }).then(() => { fresh(); executed = true; }));
  const rejected = assert.rejects(queued, /closed/);
  await flush(); await f.gate.release('s', A); unlock(); await rejected;
  assert.equal(executed, false);
});

test('bounded backlog reserves a release and never accumulates unlimited events', async () => {
  const f = fixture({ maxPending: 2 }); let finish;
  const down = f.gate.dispatch('s', f.meta(1), { kind: 'touch', action: 'down' }, () => new Promise(resolve => { finish = resolve; }));
  await flush();
  const move = f.gate.dispatch('s', f.meta(2), { kind: 'touch', action: 'move' }, () => {});
  assert.throws(() => f.gate.dispatch('s', f.meta(3), { kind: 'touch', action: 'move' }, () => {}), /queue is full/);
  const up = f.gate.dispatch('s', f.meta(4), { kind: 'touch', action: 'up' }, () => {});
  assert.throws(() => f.gate.dispatch('s', f.meta(5), { kind: 'touch', action: 'up' }, () => {}), /queue is full/);
  const rejectedMoves = assert.rejects(move, /closed/);
  const rejectedRelease = assert.rejects(up, /closed/);
  finish(); await Promise.all([down, rejectedMoves, rejectedRelease]);
  await f.gate.dispatch('s', f.meta(1, B), { kind: 'key' }, () => {});
});

test('opening same active epoch does not reset replay protection', async () => {
  const f = fixture();
  await f.gate.dispatch('s', f.meta(5), {}, () => {});
  f.gate.open('s', A);
  assert.throws(() => f.gate.dispatch('s', f.meta(1), {}, () => {}), /already received/);
});


test('an expired release invalidates its queued down before it can press the device', async () => {
  const f = fixture(); let unlock; let pressed = false;
  const blocker = f.gate.dispatch('s', f.meta(1), { kind: 'key' }, () => new Promise(resolve => { unlock = resolve; }));
  await flush();
  const down = f.gate.dispatch('s', f.meta(2), { kind: 'touch', action: 'down' }, () => { pressed = true; });
  const rejected = assert.rejects(down, /closed/);
  assert.throws(() => f.gate.dispatch('s', { ...f.meta(3), deadline: 9999 }, { kind: 'touch', action: 'up' }, () => {}), /expired/);
  unlock(); await blocker; await rejected;
  assert.equal(pressed, false);
});
