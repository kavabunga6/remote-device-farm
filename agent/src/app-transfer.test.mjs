import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { AppTransfers } from './app-transfer.mjs';

const fakeAdb = (calls, exitCode = 0) => ({
  connect: async () => {},
  run: async (serial, argv) => { calls.push({ serial, argv }); return { exitCode, stdout: 'Success', stderr: 'boom' }; },
});
const b64 = (text) => Buffer.from(text).toString('base64');

test('chunks are assembled, verified and installed, then the temp file is removed', async () => {
  const calls = [];
  const transfers = new AppTransfers(fakeAdb(calls));
  const sha256 = createHash('sha256').update('hello world').digest('hex');
  const { transferId } = await transfers.begin('s1', { name: 'a.apk', size: 11, sha256 });
  const local = transfers.active.get(transferId).local;
  await transfers.chunk('s1', { transferId, index: 0, contentBase64: b64('hello ') });
  assert.equal((await transfers.chunk('s1', { transferId, index: 1, contentBase64: b64('world') })).received, 11);
  const result = await transfers.finish('s1', 'emu:1', { transferId });
  assert.equal(result.installed, true);
  assert.deepEqual(calls[0].argv.slice(0, 2), ['install', '-r']);
  assert.equal(existsSync(local), false);
  assert.equal(transfers.active.size, 0);
});

test('bad input aborts the transfer and cleans up', async () => {
  const transfers = new AppTransfers(fakeAdb([]));
  await assert.rejects(transfers.begin('s1', { name: '../x.apk', size: 5 }));
  await assert.rejects(transfers.begin('s1', { name: 'x.txt', size: 5 }));
  await assert.rejects(transfers.begin('s1', { name: 'x.apk', size: 0 }));
  const { transferId } = await transfers.begin('s1', { name: 'x.apk', size: 4 });
  await assert.rejects(transfers.begin('s1', { name: 'y.apk', size: 4 }), /in progress/);
  await assert.rejects(transfers.chunk('s2', { transferId, index: 0, contentBase64: b64('ab') }), /Unknown/);
  await assert.rejects(transfers.chunk('s1', { transferId, index: 1, contentBase64: b64('ab') }), /order/);
  assert.equal(transfers.active.size, 0);
  const second = await transfers.begin('s1', { name: 'x.apk', size: 4 });
  await assert.rejects(transfers.chunk('s1', { transferId: second.transferId, index: 0, contentBase64: b64('abcde') }), /exceeds/);
  assert.equal(transfers.active.size, 0);
});

test('checksum mismatch, install failure and idle timeout clean up', async () => {
  const transfers = new AppTransfers(fakeAdb([], 1), { idleMs: 30 });
  let t = await transfers.begin('s1', { name: 'x.apk', size: 2, sha256: 'a'.repeat(64) });
  await transfers.chunk('s1', { transferId: t.transferId, index: 0, contentBase64: b64('ab') });
  await assert.rejects(transfers.finish('s1', 'e', { transferId: t.transferId }), /Checksum/);
  t = await transfers.begin('s1', { name: 'x.apk', size: 2 });
  await transfers.chunk('s1', { transferId: t.transferId, index: 0, contentBase64: b64('ab') });
  await assert.rejects(transfers.finish('s1', 'e', { transferId: t.transferId }), /boom/);
  t = await transfers.begin('s1', { name: 'x.apk', size: 2 });
  const local = transfers.active.get(t.transferId).local;
  // Timer firing starts async filesystem cleanup; wait for its completion under parallel load.
  const deadline = Date.now() + 5_000;
  while (existsSync(local) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(transfers.active.size, 0);
  assert.equal(existsSync(local), false);
});

test('concurrent begins and chunks cannot corrupt a session transfer', async () => {
  const transfers = new AppTransfers(fakeAdb([]));
  const first = transfers.begin('s1', { name: 'x.apk', size: 4 });
  await assert.rejects(transfers.begin('s1', { name: 'y.apk', size: 4 }), /in progress/);
  const { transferId } = await first;
  const writing = transfers.chunk('s1', { transferId, index: 0, contentBase64: b64('ab') });
  await assert.rejects(transfers.chunk('s1', { transferId, index: 0, contentBase64: b64('cd') }), /busy/);
  await writing;
  assert.equal((await transfers.chunk('s1', { transferId, index: 1, contentBase64: b64('cd') })).received, 4);
  await assert.rejects(transfers.abort('s2', transferId), /Unknown transfer/);
  await assert.rejects(transfers.finish('s2', 'emu:2', { transferId }), /Unknown transfer/);
  await transfers.abort('s1', transferId);
  assert.equal(transfers.active.size, 0);
});