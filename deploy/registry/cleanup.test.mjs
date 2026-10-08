import test from 'node:test';
import assert from 'node:assert/strict';
import { runCleanup } from './cleanup.mjs';
const digest = 'sha256:' + 'a'.repeat(64);
function fixture(fail = false) {
  const calls = [], job = { digests: [digest], deleted: [] };
  return {
    calls, job, args: {
      job, drain: async () => calls.push('drain'), inventory: async () => ({ repositories: ['rdf-emulator'], items: [{ digest, children: [] }] }),
      remove: async () => calls.push('delete'), stop: async () => calls.push('stop'), gc: async () => { calls.push('gc'); if (fail) throw Error('GC failed'); },
      restart: async () => calls.push('restart'), save: async () => calls.push('save:' + job.stage)
    }
  };
}
test('maintenance drains traffic and stops the registry before physical GC', async () => {
  const f = fixture(); await runCleanup(f.args);
  assert.ok(f.calls.indexOf('drain') < f.calls.indexOf('delete')); assert.ok(f.calls.indexOf('stop') < f.calls.indexOf('gc')); assert.ok(f.calls.indexOf('gc') < f.calls.indexOf('restart'));
  assert.deepEqual(f.job.deleted, [digest]); assert.equal(f.job.state, 'done');
});
test('GC failure still restarts Distribution and preserves confirmed deletions', async () => {
  const f = fixture(true); await assert.rejects(runCleanup(f.args), /GC failed/); assert.equal(f.calls.at(-1), 'restart'); assert.deepEqual(f.job.deleted, [digest]);
});
test('a shared registry or retained index rejects the job before any manifest deletion', async () => {
  const f = fixture(); f.args.inventory = async () => ({ repositories: ['rdf-emulator', 'other'], items: [{ digest, children: [] }] });
  await assert.rejects(runCleanup(f.args), /Shared registry/); assert.ok(!f.calls.includes('delete')); assert.ok(!f.calls.includes('stop'));
});
