import assert from 'node:assert/strict';
import test from 'node:test';
import { operationalError, StartupFailure, waitForStartupDependency } from '../src/startup.js';
import { AgentHub } from '../src/agent.js';
import { ApiError } from '../src/http-common.js';
import type { Pool } from 'pg';

test('startup diagnostics expose stage and trusted codes without secret-bearing error data', () => {
  const secret = 'sensitive-value';
  const cause = Object.assign(new Error('postgres://user:' + secret + '@private-host/db'), { code: 'ENOTFOUND', sql: secret, address: 'private-host' });
  const details = operationalError(new StartupFailure('database', new AggregateError([cause], secret)), 'listeners');
  assert.deepEqual(JSON.parse(details), { phase: 'database', code: 'ENOTFOUND' });
  assert.doesNotMatch(details, /sensitive-value|private-host|postgres|sql|stack/);
  assert.equal(JSON.parse(operationalError({ code: 'PRIVATE_TOKEN_VALUE', message: secret }, 'api')).code, 'UNKNOWN');
  let invoked = false;
  assert.equal(JSON.parse(operationalError({ get code() { invoked = true; throw Error(secret); } }, 'api')).code, 'UNKNOWN');
  assert.equal(invoked, false);
  const cycle: { cause?: unknown } = {}; cycle.cause = cycle;
  assert.equal(JSON.parse(operationalError(cycle, 'api')).code, 'UNKNOWN');
});

test('database readiness waits through crash recovery, then proceeds once', async () => {
  let now = 0, checks = 0; const records: string[] = [];
  await waitForStartupDependency(async () => { if (++checks < 3) throw Object.assign(Error('recovering'), { code: '57P03' }); }, {
    now: () => now, sleep: async ms => { now += ms; }, onRetry: record => records.push(record),
  });
  assert.equal(checks, 3); assert.equal(now, 3000); assert.equal(records.length, 2);
  assert.equal(JSON.parse(records[0]!).code, '57P03');
});

test('startup does not retry credentials, schema errors or an expired deadline', async () => {
  for (const code of ['28P01', '23505', '42P01']) {
    let checks = 0;
    await assert.rejects(waitForStartupDependency(async () => { checks++; throw Object.assign(Error('secret'), { code }); }, { sleep: async () => assert.fail('fatal failure was retried') }));
    assert.equal(checks, 1);
  }
  let now = 0, checks = 0;
  await assert.rejects(waitForStartupDependency(async () => { checks++; throw Object.assign(Error(), { code: 'ECONNREFUSED' }); }, { timeoutMs: 1500, now: () => now, sleep: async ms => { now += ms; } }));
  assert.equal(now, 1500); assert.equal(checks, 2);
});

test('offline agent commands return a service-unavailable API error before allocating a request', async () => {
  const hub = new AgentHub({} as Pool);
  await assert.rejects(hub.command('missing', 'missing', 'emulator-catalog', {}), error => error instanceof ApiError && error.status === 503 && error.code === 'agent_offline');
  await hub.dispose();
});
