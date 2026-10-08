import test from 'node:test';
import assert from 'node:assert/strict';
import { BuildResourceGuard, parseBuildMetrics } from './build-resource-guard.mjs';
const disk = free => ({ bavail: free * 1024, bsize: 1024 ** 2 });
const cpu = (busy, idle = 100) => `cpu ${busy} 0 0 ${idle} 0 0 0 0\n`;
const memory = available => `MemAvailable: ${available * 1024 ** 2} kB\n`;
const pressure = value => `some avg10=${value} avg60=0.00 avg300=0.00 total=0\n`;
function fixture() {
  const values = { cpu: cpu(100), memory: memory(16), pressure: pressure(0), disk: disk(50), now: 0 };
  const fs = { readFile: async path => path.endsWith('stat') ? values.cpu : path.endsWith('meminfo') ? values.memory : values.pressure, statfs: async () => values.disk };
  return { values, guard: new BuildResourceGuard({ path: '/', fs, now: () => values.now, intervalMs: 5 }) };
}
test('disk and memory reserves are enforced before builds and during them', async () => {
  const { guard, values } = fixture(); await guard.sample(true);
  values.disk = disk(34); await assert.rejects(guard.sample(true), { code: 'build_disk_reserve' });
  await guard.sample(); values.disk = disk(19); await assert.rejects(guard.sample(), { code: 'build_disk_reserve' });
  values.disk = disk(50); values.memory = memory(11); await assert.rejects(guard.sample(true), { code: 'build_memory_reserve' });
  values.memory = memory(7); await assert.rejects(guard.sample(), { code: 'build_memory_reserve' });
});
test('CPU and I/O pressure need sustained overload; recovery clears the overload timer', async () => {
  const { guard, values } = fixture(); await guard.sample(true);
  values.cpu = cpu(1000); values.now = 5000; await guard.sample();
  values.cpu = cpu(2000); values.now = 15000; await guard.sample();
  values.cpu = cpu(2000, 1100); values.now = 20000; await guard.sample();
  values.pressure = pressure(40); values.now = 25000; await guard.sample();
  values.now = 40000; await assert.rejects(guard.sample(), { code: 'build_host_pressure' });
});
test('missing metrics stop admission and live reserve loss aborts the owned work', async () => {
  assert.throws(() => parseBuildMetrics('', memory(12), pressure(0), disk(50)), { code: 'build_metrics_unavailable' });
  const { guard, values } = fixture();
  await assert.rejects(guard.run(signal => new Promise((resolve, reject) => { values.memory = memory(6); signal.addEventListener('abort', () => reject(signal.reason), { once: true }); })), { code: 'build_memory_reserve' });
});

test('transport abort errors retain the resource guard reason', async () => {
  const { guard, values } = fixture();
  await assert.rejects(guard.run(signal => new Promise((resolve, reject) => {
    values.memory = memory(6);
    signal.addEventListener('abort', () => reject(Object.assign(new Error('The operation was aborted'), { code: 'ABORT_ERR' })), { once: true });
  })), { code: 'build_memory_reserve' });
});
