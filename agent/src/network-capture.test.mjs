import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { runProcess } from './adb.mjs';
test('traffic outcomes, bounded previews, live counters and real proxy failures', async () => {
  const result = await runProcess(process.platform === 'win32' ? 'py' : 'python3',
    [...(process.platform === 'win32' ? ['-3', '-X', 'utf8'] : []), '-B', fileURLToPath(new URL('../test/network_capture_test.py', import.meta.url))],
    { timeoutMs: 30000 });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.match(result.stderr, /Ran 11 tests/);
});
