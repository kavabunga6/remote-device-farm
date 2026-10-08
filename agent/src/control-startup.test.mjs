import assert from 'node:assert/strict';
import test from 'node:test';
import { initializeControl } from './control-startup.mjs';

test('Docker readiness retries before cleanup and never exposes failure messages', async () => {
  let now = 0, inspections = 0, cleanups = 0; const records = [];
  await initializeControl({ hostInfo: async () => { if (++inspections < 3) throw new Error('Docker API request timed out'); }, recoverImageChecks: async () => { cleanups++; } }, {
    now: () => now, sleep: async ms => { now += ms; }, report: record => records.push(record),
  });
  assert.equal(inspections, 3); assert.equal(cleanups, 1); assert.equal(now, 3000);
  assert.equal(records[0].code, 'DOCKER_API_TIMEOUT');
  assert.equal(records[0].phase, 'docker');
});

test('ownership or cleanup failures stop startup immediately', async () => {
  let attempts = 0; const records = [];
  await assert.rejects(initializeControl({ hostInfo: async () => {}, recoverImageChecks: async () => { attempts++; throw Error('private key sensitive-value'); } }, {
    sleep: async () => assert.fail('unsafe cleanup was retried'), report: record => records.push(record),
  }));
  assert.equal(attempts, 1); assert.equal(records[0].event, 'control.startup_failed');
  assert.doesNotMatch(JSON.stringify(records), /sensitive-value|private key/);
});

test('Docker startup retry ends at its deadline without running cleanup', async () => {
  let now = 0, attempts = 0;
  await assert.rejects(initializeControl({ hostInfo: async () => { attempts++; throw Object.assign(Error(), { code: 'ECONNREFUSED' }); }, recoverImageChecks: async () => assert.fail('cleanup ran before Docker was ready') }, {
    timeoutMs: 1500, now: () => now, sleep: async ms => { now += ms; }, report: () => {},
  }));
  assert.equal(now, 1500); assert.equal(attempts, 2);
});
