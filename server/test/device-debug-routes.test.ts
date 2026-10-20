import test from 'node:test';
import assert from 'node:assert/strict';
import { apiFixture, credentials, memberCredentials } from './support/api-fixture.js';
import { trafficHar } from '../src/routes/device-debug-routes.js';
test('debug routes enforce ownership, environment and file permissions before agent access', async () => {
  const f = await apiFixture(); let calls = 0;
  f.hub.command = async (_host: string, _session: string, action: string) => {
    calls++;
    if (action === 'network-inspector') return { available: true, recording: false, entries: [] };
    if (action === 'webviews') return { pages: [] };
    return {};
  };
  async function request(method: string, resource: string, cookie = '', data?: unknown) {
    const response = await fetch(f.url + resource, { method, headers: { origin: f.url, ...(cookie ? { cookie } : {}), ...(data ? { 'content-type': 'application/json' } : {}) }, body: data ? JSON.stringify(data) : undefined });
    const body = await response.json() as any; return { status: response.status, body };
  }
  async function login(data: typeof credentials) {
    const response = await fetch(f.url + '/api/login', { method: 'POST', headers: { origin: f.url, 'content-type': 'application/json' }, body: JSON.stringify(data) });
    await response.arrayBuffer(); return response.headers.get('set-cookie')!.split(';')[0]!;
  }
  try {
    const member = await login(memberCredentials), admin = await login(credentials);
    const id = (await request('POST', '/api/sessions', member, { hostId: 'contract-node', profileId: 'contract-profile' })).body.session.id;
    for (let n = 0; (await request('GET', '/api/sessions/' + id, member)).body.session.state !== 'running'; n++) { assert.ok(n < 100); await new Promise(r => setTimeout(r, 20)); }
    const root = '/api/sessions/' + id;
    assert.equal((await request('GET', root + '/webviews')).status, 401);
    assert.equal((await request('GET', root + '/webviews', member)).status, 200);
    assert.equal((await request('GET', root + '/network-inspector', member)).status, 200);
    assert.equal((await request('GET', root + '/network-inspector/har', member)).status, 200);
    assert.equal((await request('POST', root + '/webviews', member, { op: 'document', target: 'webview_devtools_remote_1/page' })).status, 200);
    assert.equal((await request('POST', root + '/network-inspector', member, { op: 'start', pcap: false, captureBodies: true })).status, 200);
    assert.equal((await request('POST', root + '/network-inspector', member, { op: 'start', pcap: false, captureBodies: 'true' })).status, 400);
    assert.equal((await request('POST', root + '/network-inspector', member, { op: 'pcap', offset: 0, captureId: 'invalid' })).status, 400);
    assert.equal((await request('POST', root + '/network-inspector', member, { op: 'start', pcap: 'false' })).status, 400);
    assert.equal((await request('POST', root + '/webviews', member, { op: 'shell' })).status, 400);
    const other = (await request('POST', '/api/sessions', admin, { hostId: 'contract-node', profileId: 'contract-profile' })).body.session.id;
    assert.equal((await request('GET', '/api/sessions/' + other + '/webviews', member)).status, 404);
    const role = (await f.pool.query('SELECT access_role_id AS id FROM users WHERE username=$1', [memberCredentials.username])).rows[0].id;
    const permissions = (await f.pool.query('SELECT permissions FROM access_roles WHERE id=$1', [role])).rows[0].permissions;
    await f.pool.query('UPDATE access_roles SET permissions=$2 WHERE id=$1', [role, permissions.filter((p: string) => p !== 'sessions.files')]);
    const before = calls;
    assert.equal((await request('GET', root + '/network-inspector/har', member)).status, 403);
    assert.equal((await request('POST', root + '/network-inspector', member, { op: 'pcap', offset: 0 })).status, 403);
    assert.equal(calls, before);
    await f.pool.query('UPDATE access_roles SET permissions=$2 WHERE id=$1', [role, permissions.filter((p: string) => p !== 'sessions.env' && p !== 'sessions.console')]);
    assert.equal((await request('GET', root + '/webviews', member)).status, 403);
    assert.equal((await request('POST', root + '/network-inspector', member, { op: 'start', pcap: false })).status, 403);
    assert.equal(calls, before);
  } finally { await f.close(); }
});
test('HAR preserves timings but never invents decrypted HTTPS requests', () => {
  const har = trafficHar({ entries: [{ method: 'CONNECT', url: 'https://example.test/', startedAt: 1, status: 200, durationMs: 15, bytes: 42 }] });
  assert.equal(har.log.entries[0]._encrypted, true);
  assert.equal(har.log.entries[0].request.method, 'CONNECT');
  assert.deepEqual(har.log.entries[0].request.cookies, []);
  assert.equal(har.log.entries[0].time, 0);
  assert.equal(har.log.entries[0]._elapsedMs, 15);
  assert.equal(har.log.entries[0]._timingsMeasured, false);
});
