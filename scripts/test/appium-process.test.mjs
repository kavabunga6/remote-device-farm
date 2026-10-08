import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { startProcess } from '../../examples/appium/process.mjs';

const options = { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true };

test('failed spawn settles and cleanup does not wait for a nonexistent exit event', { timeout: 3000 }, async () => {
  const worker = startProcess('rdf-nonexistent-appium-test-command', [], options);
  const result = await worker.completion;
  assert.equal(result.error.code, 'ENOENT');
  assert.equal(await worker.stop(50), result);
  assert.equal(worker.child.listenerCount('error'), 0);
  assert.equal(worker.child.listenerCount('close'), 0);
});

test('cleanup waits for process output to drain before completing', { timeout: 5000 }, async () => {
  const worker = startProcess(process.execPath, ['-e', 'process.stdout.write("x".repeat(1024*1024))'], options);
  let bytes = 0;
  worker.child.stdout.on('data', chunk => { bytes += chunk.length; });
  const result = await worker.completion;
  assert.equal(result.code, 0);
  assert.equal(bytes, 1024 * 1024);
  await worker.stop(50);
});

test('repeated cleanup terminates the owned child once and drops listeners', { timeout: 5000 }, async () => {
  const worker = startProcess(process.execPath, ['-e', 'process.on("SIGTERM",()=>{});console.log("ready");setInterval(()=>{},1000)'], options);
  worker.child.stderr.resume();
  const [message] = await once(worker.child.stdout, 'data');
  assert.match(String(message), /ready/);
  const stopping = worker.stop(50);
  assert.equal(worker.stop(50), stopping);
  const result = await stopping;
  assert.ok(result.signal || result.code !== null);
  assert.equal(worker.child.listenerCount('close'), 0);
  assert.equal(worker.child.listenerCount('error'), 0);
});
