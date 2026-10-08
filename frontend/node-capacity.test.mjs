import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

async function loadModule(path) {
  const result = await build({ entryPoints: [fileURLToPath(new URL(path, import.meta.url))], bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent', define: { 'import.meta.url': JSON.stringify(new URL(path, import.meta.url).href) } });
  return import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].contents).toString('base64'));
}
const { previewNodeCapacity, profilesExceedingSlot, heartbeatAge } = await loadModule('./src/node-capacity.ts');
const { desiredNodePolicy } = await loadModule('../server/src/node-policy.ts');
const host = { cpuCores: 28, memoryMb: 32768, policySupported: true, status: 'online', disabled: false, reportedSlots: 1, slotCap: null, slotMode: 'dynamic', slotCpu: 4, slotMemoryMb: 4096, manualSlots: 1, activeSessions: 2 };

test('preview matches server policy across reservation, capacity and cap boundaries', () => {
  for (const cpu of [0, 1, 4, 5, 8, 28, 64, 256]) for (const memory of [0, 1024, 4096, 8192, 32768, 1_000_000]) {
    for (const slotCpu of [1, 4, 16]) for (const slotMemoryMb of [1024, 4096, 6144, 65536]) {
      const current = { ...host, cpuAllocatableCores: cpu, memoryAllocatableMb: memory };
      const expected = desiredNodePolicy({ slot_mode: 'dynamic', slot_cpu: slotCpu, slot_memory_mb: slotMemoryMb, disabled: false, metrics: { cpuAllocatableCores: cpu, memoryAllocatableMb: memory }, policy_revision: 0 }).slots;
      assert.equal(previewNodeCapacity(current, { slotCpu, slotMemoryMb }).slots, expected, JSON.stringify({ cpu, memory, slotCpu, slotMemoryMb }));
    }
  }
});

test('uses daemon ceiling and ignores free memory / old slot cap for modern policy', () => {
  const result = previewNodeCapacity({ ...host, cpuAllocatableCores: 8, memoryAllocatableMb: 8192, availableMemoryMb: 0, slotCap: 0 }, {});
  assert.equal(result.slots, 1);
  assert.equal(result.cpuBudget, 6);
  assert.equal(result.memoryBudgetMb, 6553);
  assert.equal(result.free, 0);
  assert.deepEqual(result.limit, ['CPU', 'память']);
});

test('manual, disabled, offline, legacy cap and invalid draft values are explicit', () => {
  assert.equal(previewNodeCapacity(host, { slotMode: 'manual', manualSlots: 12 }).slots, 12);
  assert.equal(previewNodeCapacity({ ...host, status: 'offline' }, {}).free, 0);
  assert.equal(previewNodeCapacity(host, { disabled: true }).slots, 0);
  assert.equal(previewNodeCapacity({ ...host, policySupported: false, reportedSlots: 8, slotCap: 3 }, { slotMode: 'manual', manualSlots: 6 }).slots, 3);
  assert.equal(previewNodeCapacity({ ...host, cpuAllocatableCores: 0 }, {}).slots, 0);
  assert.equal(previewNodeCapacity(host, { slotCpu: 0 }), null);
  assert.equal(previewNodeCapacity(host, { slotMemoryMb: 1 }), null);
  assert.equal(previewNodeCapacity(host, { manualSlots: 99, slotMode: 'manual' }), null);
});

test('profile fit uses container limits and ignores disabled profiles and guest limits', () => {
  const results = profilesExceedingSlot([
    { id: 'fits', cpu: 4, memoryMb: 4096, guestCores: 8, guestMemoryMb: 6000 },
    { id: 'cpu', cpu: 8, memoryMb: 4096 },
    { id: 'ram', cpu: 4, memoryMb: 6144 },
    { id: 'off', cpu: 16, memoryMb: 65536, enabled: false },
  ], 4, 4096);
  assert.deepEqual(results.map(item => item.profile.id), ['cpu', 'ram']);
  assert.match(results[1].reasons[0], /6144 > 4096/);
});

test('heartbeat distinguishes absent, fresh and stale data without negative ages', () => {
  const now = Date.parse('2026-10-03T12:00:00Z');
  assert.equal(heartbeatAge(null, now).timestamp, null);
  assert.equal(heartbeatAge('invalid', now).timestamp, null);
  assert.equal(heartbeatAge(new Date(now - 5000).toISOString(), now).label, 'Ответ 5 с назад');
  assert.equal(heartbeatAge(new Date(now - 46000).toISOString(), now).stale, true);
  assert.equal(heartbeatAge(new Date(now + 5000).toISOString(), now).label, 'Ответ только что');
});
