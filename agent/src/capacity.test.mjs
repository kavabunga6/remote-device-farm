import test from 'node:test';
import assert from 'node:assert/strict';
import { SlotReservations } from './capacity.mjs';

const host = { slots: 4, cpuCores: 8, memoryTotalMb: 16384, memoryAvailableMb: 14000 };

test('concurrent starts reserve CPU before awaiting image pulls', async () => {
  const slots = new SlotReservations();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const first = slots.run('session-a', () => [], host, { cpu: 4, memoryMb: 4096 }, () => gate);
  await assert.rejects(() => slots.run('session-b', () => [], host, { cpu: 3, memoryMb: 4096 }, async () => {}),
    /CPU capacity/);
  release();
  await first;
  assert.equal(await slots.run('session-b', () => [], host, { cpu: 3, memoryMb: 4096 }, async () => 'started'), 'started');
});

test('running and pending emulator memory is included in admission', async () => {
  const slots = new SlotReservations();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const first = slots.run('session-a', () => [{ cpu: 2, memoryMb: 5000 }], host,
    { cpu: 2, memoryMb: 4000 }, () => gate);
  await assert.rejects(() => slots.run('session-b', () => [{ cpu: 2, memoryMb: 5000 }], host,
    { cpu: 2, memoryMb: 5000 }, async () => {}), /host memory/);
  release();
  await first;
});

test('slot and currently available host memory limits are enforced', async () => {
  const slots = new SlotReservations();
  await assert.rejects(() => slots.run('session-a', () => [], { ...host, slots: 0 },
    { cpu: 1, memoryMb: 1024 }, async () => {}), /No free emulator slots/);
  await assert.rejects(() => slots.run('session-a', () => [], { ...host, memoryAvailableMb: 4000 },
    { cpu: 1, memoryMb: 1024 }, async () => {}), /host memory/);
});

test('failed start releases its resource reservation', async () => {
  const slots = new SlotReservations();
  await assert.rejects(() => slots.run('session-a', () => [], host,
    { cpu: 4, memoryMb: 4096 }, async () => { throw new Error('Docker failed'); }));
  assert.equal(await slots.run('session-b', () => [], host,
    { cpu: 4, memoryMb: 4096 }, async () => 'started'), 'started');
});
test('pending starts also consume the currently available memory budget', async () => {
  const slots = new SlotReservations();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const constrained = { slots: 4, cpuCores: 8, memoryTotalMb: 32768, memoryAvailableMb: 14000 };
  const first = slots.run('session-a', () => [], constrained, { cpu: 2, memoryMb: 5000 }, () => gate);
  await assert.rejects(() => slots.run('session-b', () => [], constrained,
    { cpu: 2, memoryMb: 5000 }, async () => {}), /host memory/);
  release();
  await first;
});