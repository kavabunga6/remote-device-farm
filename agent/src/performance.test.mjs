import assert from 'node:assert/strict';
import test from 'node:test';
import { ContainerPerformance } from './container-performance.mjs';
import { AndroidTraceCapture, MAX_TRACE_BYTES, parseProcessSnapshot, recordAndroidTrace } from './android-performance.mjs';

test('on-demand stats share one Docker request and compute deltas between observations', async () => {
  let calls = 0;
  let now = 0;
  const sampler = new ContainerPerformance({
    async request(method, path) {
      assert.equal(method, 'GET');
      assert.equal(path, '/containers/session-container/stats?stream=false&one-shot=true');
      calls++;
      return {
        cpu_stats: {
          cpu_usage: { total_usage: calls * 7_500_000_000 },
          throttling_data: { periods: calls * 10, throttled_periods: calls * 3 },
        },
        memory_stats: { usage: 1000, limit: 2000, stats: calls === 1 ? { inactive_file: 400 } : { total_inactive_file: 250 } },
        blkio_stats: { io_service_bytes_recursive: [{ op: 'Read', value: calls * 25_000 }] },
      };
    },
  }, () => now);
  const [initial, duplicate] = await Promise.all([sampler.sample('session-container'), sampler.sample('session-container')]);
  assert.equal(calls, 1);
  assert.equal(initial, duplicate);
  assert.equal(initial.cpuCores, null);
  assert.equal(initial.memoryBytes, 1000);
  assert.equal(initial.memoryWorkingSetBytes, 600);
  now = 4999;
  assert.equal(await sampler.sample('session-container'), initial);
  now = 5000;
  const next = await sampler.sample('session-container');
  assert.equal(next.cpuCores, 1.5);
  assert.equal(next.throttlePercent, 30);
  assert.equal(next.readBytesPerSecond, 5000);
  assert.equal(next.memoryLimitBytes, 2000);
  assert.equal(next.memoryWorkingSetBytes, 750);
  assert.equal(sampler.latest('session-container'), next);
  assert.equal(sampler.latest('another-container'), null);
  now = 80_000;
  assert.equal((await sampler.sample('session-container')).cpuCores, null);
});

test('Toybox snapshot reads the second measurement and accepts marked sort columns', () => {
  const output = [
    '  PID %CPU  RES[NAME]',
    '  100 90.0 1.2M old',
    '  PID[%CPU] RES NAME',
    '  101 12.5  55M system_server',
    '  102  3.0 512K example.app',
    '   45  0.0    0 [kswapd0]',
  ].join('\r\n');
  assert.deepEqual(parseProcessSnapshot(output), [
    { pid: 101, cpuPercent: 12.5, residentBytes: 55 * 1024 ** 2, name: 'system_server' },
    { pid: 102, cpuPercent: 3, residentBytes: 512 * 1024, name: 'example.app' },
    { pid: 45, cpuPercent: 0, residentBytes: 0, name: '[kswapd0]' },
  ]);
  assert.equal(parseProcessSnapshot('top: unknown option'), null);
});

test('Perfetto uses the binary ADB channel with a bounded fixed recording', async () => {
  const trace = Buffer.from([10, 2, 8, 1]);
  const adb = { async run(serial, [mode, command], options) {
    assert.equal(serial, 'emulator-5554');
    assert.equal(mode, 'exec-out');
    assert.match(command, /duration_ms: 10000/);
    assert.match(command, /perfetto --txt -c - -o - 2>\/dev\/null/);
    assert.equal(options.encoding, null);
    assert.equal(options.maxOutputBytes, MAX_TRACE_BYTES);
    assert.equal(options.timeoutMs, 20_000);
    return { stdout: trace, exitCode: 0 };
  } };
  assert.deepEqual(await recordAndroidTrace(adb, 'emulator-5554'), trace);
});

test('Perfetto transfer limits chunks and releases bytes only for the owning session', async () => {
  const capture = new AndroidTraceCapture();
  const id = '11111111-1111-4111-8111-111111111111';
  const trace = Buffer.alloc(48 * 1024 + 2, 10);
  assert.deepEqual(await capture.open('session', id, async () => trace), { size: trace.length });
  assert.throws(() => capture.read('other', id, 0));
  capture.release('other', id);
  const first = Buffer.from(capture.read('session', id, 0).chunk, 'base64');
  assert.equal(first.length, 48 * 1024);
  const tail = Buffer.from(capture.read('session', id, first.length).chunk, 'base64');
  assert.deepEqual(Buffer.concat([first, tail]), trace);
  capture.release('session', id);
  assert.throws(() => capture.read('session', id, 0));
});

test('a released trace aborts active ADB capture and frees its slot', async () => {
  const capture = new AndroidTraceCapture();
  const id = '11111111-1111-4111-8111-111111111111';
  const pending = capture.open('session', id, signal => new Promise((_resolve, reject) =>
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })));
  capture.dispose('session');
  await assert.rejects(pending, { name: 'AbortError' });
  assert.deepEqual(await capture.open('session', id, async () => Buffer.from([10])), { size: 1 });
  capture.dispose();
});
