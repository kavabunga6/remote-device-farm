import assert from 'node:assert/strict';
import test from 'node:test';
import { apiFixture, memberCredentials } from './support/api-fixture.js';

test('delayed device and debugging responses recheck current permissions before delivery', async t => {
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
    const root = f.url + '/api/sessions/' + session.id;
    const deadline = Date.now() + 5000;
    while (true) {
      const response = await fetch(root, { headers });
      if ((await response.json() as any).session.state === 'running') break;
      assert.ok(Date.now() < deadline); await new Promise(resolve => setTimeout(resolve, 20));
    }
    const { rows: [role] } = await f.pool.query("SELECT id,permissions FROM access_roles WHERE builtin='user'");
    const marker = 'private-pending-device-reply';
    const cases = [
      { path: '/webviews', action: 'webviews', result: { pages: [{ title: marker }] } },
      { path: '/network-inspector/har', action: 'network-inspector', result: { entries: [] } },
      { path: '/network-inspector', action: 'network-inspector', body: { op: 'pcap', offset: 0 }, result: { data: marker } },
      { path: '/ui', action: 'ui-tree', result: { nodes: [{ text: marker }] } },
      { path: '/adb', action: 'adb', body: { argv: ['shell', 'getprop'] }, result: { stdout: marker, exitCode: 0 } },
      { path: '/logcat', action: 'logcat', result: { entries: [{ message: marker }] } },
      { path: '/logcat/apps', action: 'logcat-apps', result: { apps: [{ name: marker }] } },
      { path: '/device-info', action: 'device-info', result: { model: marker } },
      { path: '/screenshot', action: 'screenshot', result: { mime: 'image/png', data: Buffer.concat([
        Buffer.from('89504e470d0a1a0a0000000d494844520000000100000001', 'hex'), Buffer.from(marker)]).toString('base64') } },
      { path: '/performance/processes', action: 'performance-processes', body: {}, result: {
        sampledAt: new Date().toISOString(), processes: [{ pid: 42, name: marker, cpuPercent: 1, residentBytes: 1024 }] } },
    ];
    for (const item of cases) await t.test(item.path, async () => {
      await f.pool.query('UPDATE access_roles SET permissions=$2 WHERE id=$1', [role.id, role.permissions]);
      let calls = 0;
      f.hub.command = async (_host, _session, action) => {
        assert.equal(action, item.action); calls++;
        await f.pool.query('UPDATE access_roles SET permissions=ARRAY[]::text[] WHERE id=$1', [role.id]);
        return item.result;
      };
      const response = await fetch(root + item.path, { headers, method: item.body ? 'POST' : 'GET',
        body: item.body ? JSON.stringify(item.body) : undefined });
      assert.equal(calls, 1);
      assert.equal(response.status, 403);
      assert.doesNotMatch(await response.text(), new RegExp(marker));
    });
  } finally { await f.close(); }
});
