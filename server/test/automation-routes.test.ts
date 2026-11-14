import test from 'node:test';
import assert from 'node:assert/strict';
import { apiFixture, credentials, memberCredentials } from './support/api-fixture.js';

test('automation routes enforce owner, role revocation, upload limits and Appium data permissions', async () => {
  const f = await apiFixture();
  const calls: Array<{ action: string; params: Record<string, unknown> }> = [];
  f.hub.command = async (_host: string, _session: string, action: string, params: Record<string, unknown>) => {
    calls.push({ action, params });
    if (action === 'appium') return { status: 200, body: { value: { ready: true } } };
    if (action === 'camera') return { available: true, imageSet: params.op === 'set' };
    return { nodes: [] };
  };
  async function request(method: string, resource: string, cookie = '', data?: unknown) {
    const response = await fetch(f.url + resource, { method,
      headers: { origin: f.url, ...(cookie ? { cookie } : {}), ...(data ? { 'content-type': 'application/json' } : {}) },
      body: data ? JSON.stringify(data) : undefined });
    return { status: response.status, body: await response.json() as any };
  }
  async function login(data: typeof credentials) {
    const response = await fetch(f.url + '/api/login', { method: 'POST', headers: { origin: f.url, 'content-type': 'application/json' }, body: JSON.stringify(data) });
    assert.equal(response.status, 200); await response.arrayBuffer();
    return response.headers.get('set-cookie')!.split(';')[0]!;
  }
  try {
    const member = await login(memberCredentials), admin = await login(credentials);
    const created = await request('POST', '/api/sessions', member, { hostId: 'contract-node', profileId: 'contract-profile' });
    const id = created.body.session.id;
    const deadline = Date.now() + 5000;
    while ((await request('GET', '/api/sessions/' + id, member)).body.session.state !== 'running') {
      assert.ok(Date.now() < deadline); await new Promise(r => setTimeout(r, 20));
    }
    assert.equal((await request('GET', '/api/sessions/' + id + '/ui')).status, 401);
    const other = await request('POST', '/api/sessions', admin, { hostId: 'contract-node', profileId: 'contract-profile' });
    assert.equal((await request('GET', '/api/sessions/' + other.body.session.id + '/ui', member)).status, 404);
    assert.equal((await request('GET', '/api/sessions/' + id + '/camera', member)).status, 200);
    assert.equal((await request('POST', '/api/sessions/' + id + '/ui/tap', member, { selector: {} })).status, 400);
    assert.equal((await request('GET', '/api/sessions/' + id + '/appium/status', member)).status, 200);
    assert.equal((await request('GET', '/api/sessions/' + id + '/appium/status?redirect=http://other', member)).status, 400);
    const data = new FormData(); data.append('image', new Blob(['not png'], { type: 'text/plain' }), 'image.png');
    const invalid = await fetch(f.url + '/api/sessions/' + id + '/camera/image', { method: 'POST', headers: { cookie: member, origin: f.url }, body: data });
    assert.equal(invalid.status, 400); await invalid.arrayBuffer();
    const role = (await f.pool.query("SELECT access_role_id AS id FROM users WHERE username=$1", [memberCredentials.username])).rows[0].id;
    const permissions = (await f.pool.query('SELECT permissions FROM access_roles WHERE id=$1', [role])).rows[0].permissions;
    await f.pool.query('UPDATE access_roles SET permissions=$2 WHERE id=$1', [role, permissions.filter((p: string) => p !== 'sessions.control' && p !== 'sessions.env')]);
    const before = calls.length;
    assert.equal((await request('POST', '/api/sessions/' + id + '/ui/tap', member, { selector: { text: 'Sign in' } })).status, 403);
    assert.equal((await request('GET', '/api/sessions/' + id + '/appium/status', member)).status, 403);
    assert.equal((await request('POST', '/api/sessions/' + id + '/camera/reset', member, {})).status, 403);
    assert.equal(calls.length, before);
    assert.equal((await request('GET', '/api/sessions/' + id + '/ui', member)).status, 200);
  } finally { await f.close(); }
});

test('Appium never delivers a pending reply after permission, login or lease revocation', async t => {
  for (const mode of ['permission', 'login', 'lease'] as const) await t.test(mode, async () => {
    const f = await apiFixture();
    try {
      const signed = await fetch(f.url + '/api/login', { method: 'POST',
        headers: { origin: f.url, 'content-type': 'application/json' }, body: JSON.stringify(memberCredentials) });
      assert.equal(signed.status, 200); await signed.arrayBuffer();
      const headers = { cookie: signed.headers.get('set-cookie')!.split(';')[0]!, origin: f.url, 'content-type': 'application/json' };
      const created = await fetch(f.url + '/api/sessions', { method: 'POST', headers,
        body: JSON.stringify({ hostId: 'contract-node', profileId: 'contract-profile' }) });
      assert.equal(created.status, 202);
      const { session } = await created.json() as any;
      const deadline = Date.now() + 5000;
      while (true) {
        const state = await fetch(f.url + '/api/sessions/' + session.id, { headers });
        if ((await state.json() as any).session.state === 'running') break;
        assert.ok(Date.now() < deadline); await new Promise(resolve => setTimeout(resolve, 20));
      }
      f.hub.command = async (_host, _session, action) => {
        assert.equal(action, 'appium');
        if (mode === 'permission') await f.pool.query("UPDATE access_roles SET permissions=array_remove(permissions,'sessions.files') WHERE builtin='user'");
        if (mode === 'login') await f.pool.query("DELETE FROM browser_sessions WHERE user_id=(SELECT id FROM users WHERE username=$1)", [memberCredentials.username]);
        if (mode === 'lease') await f.pool.query("UPDATE sessions SET state='stopped',ended_at=now() WHERE id=$1", [session.id]);
        return { status: 200, body: { value: 'private-pending-device-reply' } };
      };
      const response = await fetch(f.url + '/api/sessions/' + session.id + '/appium/status', { headers });
      assert.equal(response.status, { permission: 403, login: 401, lease: 409 }[mode]);
      assert.doesNotMatch(await response.text(), /private-pending-device-reply/);
    } finally { await f.close(); }
  });
});
