import assert from 'node:assert/strict';
import test from 'node:test';
import { apiFixture, credentials } from './support/api-fixture.js';
import { createContractValidator, readContract } from './support/openapi-contract.mjs';
const validate = createContractValidator(readContract());
test('catalog status follows builder configuration, progress and permissions', async t => {
  const f = await apiFixture();
  try {
    const login = await fetch(f.url + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: f.url }, body: JSON.stringify(credentials) });
    const cookie = login.headers.get('set-cookie')!.split(';')[0];
    const call = async (path: string) => {
      const response = await fetch(f.url + '/api' + path, { headers: { Cookie: cookie } });
      const body = await response.json();
      assert.deepEqual(validate({ method: 'GET', url: '/api' + path, status: response.status, body }), []);
      return { status: response.status, body };
    };
    assert.equal((await call('/admin/emulator-images/catalog-status')).body.phase, 'unconfigured');
    await f.pool.query("UPDATE hosts SET image_builder=true WHERE id='contract-node'");
    const original = f.hub.command.bind(f.hub);
    f.hub.command = async (host, session, action, params) => action === 'emulator-catalog-status'
      ? { phase: 'preparing_tools', startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), progress: { step: 2, steps: 5, percent: null } }
      : original(host, session, action, params);
    const status = await call('/admin/emulator-images/catalog-status');
    assert.equal(status.body.phase, 'preparing_tools'); assert.equal(status.body.progress.step, 2);
    const member = await fetch(f.url + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: f.url }, body: JSON.stringify({ username: 'contract-member', password: 'Synthetic-test-password-43' }) });
    assert.equal((await fetch(f.url + '/api/admin/emulator-images/catalog-status', { headers: { Cookie: member.headers.get('set-cookie')!.split(';')[0] } })).status, 403);
    f.hub.command = async () => { throw new Error('Synthetic catalog failure'); };
    assert.equal((await call('/admin/emulator-images')).status, 502);
    assert.equal((await f.pool.query("SELECT count(*)::integer AS n FROM service_logs WHERE code='emulator_images.catalog_failed'")).rows[0].n, 1);
    f.hub.hasAgent = () => false;
    assert.equal((await call('/admin/emulator-images/catalog-status')).body.phase, 'offline');
    assert.equal((await call('/admin/emulator-images')).status, 503);
  } finally { await f.close(); }
});
