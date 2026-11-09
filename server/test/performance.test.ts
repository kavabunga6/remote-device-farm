import assert from 'node:assert/strict';
import test from 'node:test';
import { apiFixture, credentials, memberCredentials } from './support/api-fixture.js';
import { recordServiceLog } from '../src/service-log.js';

test('performance tools require console access and keep captures scoped to their session', async () => {
  const f = await apiFixture();
  try {
    const owner = '11111111-1111-4111-8111-111111111111';
    const session = '22222222-2222-4222-8222-222222222222';
    const path = '/api/sessions/' + session + '/performance';
    await f.pool.query(
      `INSERT INTO sessions(id,owner_user_id,host_id,profile_id,state) VALUES($1,$2,'contract-node','contract-profile','running')`,
      [session, owner]);
    async function login(user: typeof credentials) {
      const response = await fetch(f.url + '/api/login', {
        method: 'POST', headers: { origin: f.url, 'Content-Type': 'application/json' }, body: JSON.stringify(user),
      });
      assert.equal(response.status, 200);
      return response.headers.get('set-cookie')!.split(';')[0]!;
    }
    const cookie = await login(memberCredentials);
    const request = (suffix = '', method = 'GET', authenticated = true) => fetch(f.url + path + suffix, {
      method, headers: { origin: f.url, ...(authenticated ? { cookie } : {}) },
    });
    const calls: string[] = [];
    const sampledAt = '2026-01-01T12:00:00.000Z';
    const sample = { sampledAt, cpuCores: 2, memoryBytes: 4096 };
    const binary = Buffer.alloc(120_000, 42);
    binary[0] = 10;
    let traceId: unknown;
    let holdTrace = false;
    let entered!: () => void;
    let released!: () => void;
    const traceStarted = new Promise<void>(resolve => { entered = resolve; });
    const traceReleased = new Promise<void>(resolve => { released = resolve; });
    f.hub.command = async (host, id, action, params, _timeout, _input, signal) => {
      assert.equal(host, 'contract-node');
      assert.equal(id, session);
      calls.push(action);
      if (action === 'performance-container') return { ...sample, secret: 'discard' };
      if (action === 'performance-processes') return { sampledAt, processes: [{ pid: 12, name: 'example.app', cpuPercent: 10, residentBytes: 512 }] };
      if (action === 'performance-trace-open') {
        traceId = params.traceId;
        if (holdTrace) {
          entered();
          await new Promise<void>((_resolve, reject) => signal!.addEventListener('abort', () => reject(signal!.reason), { once: true }));
          assert.fail('cancelled trace continued');
        }
        return { size: binary.length };
      }
      assert.equal(params.traceId, traceId);
      if (action === 'performance-trace-read') {
        const offset = Number(params.offset);
        return { chunk: binary.subarray(offset, offset + 48 * 1024).toString('base64') };
      }
      if (action === 'performance-trace-release') { if (holdTrace) released(); return {}; }
      assert.fail('Unexpected agent action: ' + action);
    };
    assert.equal((await request('/trace', 'POST', false)).status, 401);
    const otherSession = '33333333-3333-4333-8333-333333333333';
    const admin = await login(credentials);
    const { rows } = await f.pool.query("SELECT id FROM users WHERE username=$1", [credentials.username]);
    await f.pool.query(
      `INSERT INTO sessions(id,owner_user_id,host_id,profile_id,state) VALUES($1,$2,'contract-node','contract-profile','running')`,
      [otherSession, rows[0].id]);
    const cross = await fetch(f.url + '/api/sessions/' + otherSession + '/performance/trace', {
      method: 'POST', headers: { origin: f.url, cookie },
    });
    assert.equal(cross.status, 404);
    assert.deepEqual(calls, []);
    const load = await request();
    assert.equal(load.status, 200);
    assert.equal((await load.json() as { sample: Record<string, unknown> }).sample.secret, undefined);
    const processes = await request('/processes', 'POST');
    assert.equal(processes.status, 200);
    assert.equal((await processes.json() as { processes: unknown[] }).processes.length, 1);
    const trace = await request('/trace', 'POST');
    assert.equal(trace.status, 200);
    assert.match(trace.headers.get('content-disposition')!, /\.perfetto-trace/);
    assert.match(trace.headers.get('cache-control')!, /no-store/);
    assert.deepEqual(Buffer.from(await trace.arrayBuffer()), binary);
    assert.deepEqual(calls, ['performance-container', 'performance-processes', 'performance-trace-open',
      'performance-trace-read', 'performance-trace-read', 'performance-trace-read', 'performance-trace-release']);
    holdTrace = true;
    const cancel = new AbortController();
    const aborted = assert.rejects(fetch(f.url + path + '/trace', { method: 'POST', headers: { origin: f.url, cookie }, signal: cancel.signal }), { name: 'AbortError' });
    await traceStarted;
    cancel.abort();
    await aborted;
    await traceReleased;
    assert.deepEqual(calls.slice(-2), ['performance-trace-open', 'performance-trace-release']);
    assert.deepEqual(await (await request('/crash')).json(), { crash: null });
    await f.pool.query("UPDATE sessions SET state='stopping' WHERE id=$1", [session]);
    await recordServiceLog(f.pool, { service: 'emulator', severity: 'error', code: 'container.state', sessionId: session,
      message: JSON.stringify({ running: false, exitCode: 137, oomKilled: true, performance: sample }) });
    await recordServiceLog(f.pool, { service: 'emulator', severity: 'error', code: 'container.stderr', sessionId: session,
      message: 'memory allocation failed' });
    const crash = await (await request('/crash')).json() as { crash: { reason: string; exitCode: number; lastSample: { cpuCores: number }; logs: string[] } };
    assert.equal(crash.crash.reason, 'oom');
    assert.equal(crash.crash.exitCode, 137);
    assert.equal(crash.crash.lastSample.cpuCores, 2);
    assert.deepEqual(crash.crash.logs, []);
    assert.equal((await request('/trace', 'POST')).status, 409);
    await f.pool.query('DELETE FROM sessions WHERE id=$1', [session]);
    const retained = await request('/crash');
    assert.equal(retained.status, 200);
    assert.deepEqual(await retained.json(), crash);
    const normal = '44444444-4444-4444-8444-444444444444';
    await f.pool.query(
      `INSERT INTO sessions(id,owner_user_id,host_id,profile_id,state) VALUES($1,$2,'contract-node','contract-profile','stopping')`,
      [normal, owner]);
    await recordServiceLog(f.pool, { service: 'emulator', severity: 'info', code: 'container.state', sessionId: normal,
      message: JSON.stringify({ running: false, exitCode: 0, oomKilled: false }) });
    await f.pool.query('DELETE FROM sessions WHERE id=$1', [normal]);
    const history = await fetch(f.url + '/api/me/rentals', { headers: { cookie } });
    assert.equal(history.status, 200);
    const { rentals } = await history.json() as { rentals: Array<{ sessionId: string; finalState: string; hasCrash: boolean }> };
    assert.deepEqual(rentals.map(row => [row.sessionId, row.finalState, row.hasCrash]), [
      [normal, 'stopping', false], [session, 'stopping', true],
    ]);
    const failed = '55555555-5555-4555-8555-555555555555';
    await f.pool.query(
      `INSERT INTO sessions(id,owner_user_id,host_id,profile_id,state) VALUES($1,$2,'contract-node','contract-profile','stopping')`,
      [failed, owner]);
    await recordServiceLog(f.pool, { service: 'server', severity: 'error', code: 'session.start_failed', sessionId: failed,
      message: 'Emulator failed before Docker created a container' });
    await f.pool.query('DELETE FROM sessions WHERE id=$1', [failed]);
    const failedCrash = await fetch(f.url + '/api/sessions/' + failed + '/performance/crash', { headers: { cookie } });
    assert.equal(failedCrash.status, 200);
    assert.equal((await failedCrash.json() as { crash: { reason: string } }).crash.reason, 'startup');
    const updatedHistory = await (await fetch(f.url + '/api/me/rentals', { headers: { cookie } })).json() as { rentals: typeof rentals };
    assert.equal(updatedHistory.rentals.find(row => row.sessionId === failed)?.hasCrash, true);
    await f.pool.query('DELETE FROM sessions WHERE id=$1', [otherSession]);
    const otherRental = await fetch(f.url + '/api/sessions/' + otherSession + '/performance/crash', { headers: { cookie } });
    assert.equal(otherRental.status, 404);
    const adminCrash = await fetch(f.url + path + '/crash', { headers: { cookie: admin } });
    assert.equal(adminCrash.status, 200);
    assert.deepEqual((await adminCrash.json() as typeof crash).crash.logs, ['memory allocation failed']);
  } finally { await f.close(); }
});
