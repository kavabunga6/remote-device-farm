import test from 'node:test';
import assert from 'node:assert/strict';
import { LiveTelemetryCollector, cpuUtilization, parseCpuTimes, parseNvidiaTelemetry, queryNvidiaTelemetry } from './live-telemetry.mjs';

const stat = (busy, idle, guest = 0) => 'cpu ' + busy + ' 0 0 ' + idle + ' 0 0 0 0 ' + guest + ' 0\n';

test('CPU measurement needs two samples and avoids counting guest CPU twice', () => {
  const first = parseCpuTimes(stat(100, 100, 75));
  const second = parseCpuTimes(stat(150, 150, 90));
  assert.deepEqual(first, { total: 200, idle: 100 });
  assert.equal(cpuUtilization(null, first), undefined);
  assert.equal(cpuUtilization(first, second), 50);
  assert.equal(cpuUtilization(second, parseCpuTimes(stat(150, 250))), 0);
  assert.equal(cpuUtilization(first, first), undefined);
  assert.equal(cpuUtilization(second, first), undefined);
  assert.equal(parseCpuTimes('cpu invalid'), null);
  assert.equal(parseCpuTimes('cpu -1 0 0 2'), null);
});

test('NVIDIA handles multiple GPUs and unsupported readings without fabricated zeroes', () => {
  assert.deepEqual(parseNvidiaTelemetry('0, 0, 0, 12288\n1, 37, 1024, 24576\n'), [
    { index: 0, utilizationPercent: 0, memoryUsedMb: 0, memoryTotalMb: 12288 },
    { index: 1, utilizationPercent: 37, memoryUsedMb: 1024, memoryTotalMb: 24576 },
  ]);
  assert.deepEqual(parseNvidiaTelemetry('0, [N/A], N/A, 12288'), [{ index: 0, memoryTotalMb: 12288 }]);
  assert.equal(parseNvidiaTelemetry('0, N/A, N/A, N/A'), undefined);
  assert.equal(parseNvidiaTelemetry('0, 50, 1, 2\n0, 50, 1, 2'), undefined);
  assert.equal(parseNvidiaTelemetry('driver initialization failed'), undefined);
  assert.equal(parseNvidiaTelemetry('0, 101, 200, 100'), undefined);
});

test('GPU probe is bounded, shell-free and makes failure unavailable rather than zero', async () => {
  let request;
  assert.deepEqual(await queryNvidiaTelemetry(async (...args) => { request = args; return { stdout: '0, 24, 8192, 12288' }; }), [{ index: 0, utilizationPercent: 24, memoryUsedMb: 8192, memoryTotalMb: 12288 }]);
  assert.equal(request[0], 'nvidia-smi');
  assert.equal(request[1].length, 2);
  assert.equal(request[2].shell, false);
  assert.ok(request[2].timeout > 0 && request[2].timeout <= 2000);
  assert.ok(request[2].maxBuffer <= 16384);
  for (const code of ['ENOENT', 'ETIMEDOUT', 'EPERM']) assert.equal(await queryNvidiaTelemetry(async () => { throw Object.assign(new Error(code), { code }); }), undefined);
});

test('collector caches and coalesces probes, tracks sample interval, and does not reuse stale GPU values after failure', async () => {
  let now = 10000, text = stat(100, 100), calls = 0, fails = false;
  const collector = new LiveTelemetryCollector({
    fs: { readFile: async () => { if (fails) throw new Error('unavailable'); return text; } },
    clock: () => now, env: { AGENT_BUILD_SHA: 'abcd1234' },
    runGpu: async () => { calls++; if (fails) throw new Error('timeout'); return { stdout: '0, 0, 0, 12288' }; },
  });
  const [a, b] = await Promise.all([collector.collect(true), collector.collect(true)]);
  assert.deepEqual(a, b); assert.equal(calls, 1);
  assert.match(a.agentVersion, /^\d+\.\d+\.\d+/); assert.equal(a.agentBuild, 'abcd1234');
  assert.equal(a.cpuUsagePercent, undefined); assert.equal(a.gpuTelemetry[0].utilizationPercent, 0);
  await collector.collect(true); assert.equal(calls, 1);
  now += 10000; text = stat(150, 150);
  const measured = await collector.collect(true);
  assert.equal(measured.cpuUsagePercent, 50); assert.equal(measured.cpuSampleSeconds, 10);
  assert.equal(measured.metricsSampledAt, new Date(now).toISOString());
  now += 10000; fails = true;
  const missing = await collector.collect(true);
  assert.equal(missing.cpuUsagePercent, undefined); assert.equal(missing.gpuTelemetry, undefined);
  now += 10000; fails = false;
  assert.equal((await collector.collect(true)).cpuUsagePercent, undefined);
});

test('non-NVIDIA nodes do not execute GPU probes and invalid build IDs are omitted', async () => {
  const collector = new LiveTelemetryCollector({ fs: { readFile: async () => '' }, env: { AGENT_BUILD_SHA: 'token=secret' }, runGpu: async () => { throw new Error('must not execute'); } });
  const metrics = await collector.collect(false);
  assert.equal(metrics.agentBuild, undefined); assert.equal(metrics.gpuTelemetry, undefined); assert.equal(metrics.cpuUsagePercent, undefined);
});
