import assert from 'node:assert/strict';
import test from 'node:test';
import { apiFixture, credentials, memberCredentials } from './support/api-fixture.js';
import { registrationCredentials, registerAccount, RegistrationLimiter, updateRegistrationSettings } from '../src/registration.js';
import { requestPermission } from '../src/request-permissions.js';
import { createContractValidator, readContract } from './support/openapi-contract.mjs';
const ADMIN = '00000000-0000-4000-8000-000000000001';
const USER = '00000000-0000-4000-8000-000000000002';
const validate = createContractValidator(readContract());

test('registration accepts credentials only and bounds password work and attempts', () => {
  for (const body of [null, [], {}, { username: 'ab', password: 'long-password-42' },
    { username: 'bad name', password: 'long-password-42' }, { username: 'valid', password: 'short' },
    { username: 'valid', password: 'x'.repeat(2049) }, { username: 'valid', password: 'long-password-42', roleId: ADMIN },
    { username: 'valid', password: 'long-password-42', permissions: [] }]) assert.throws(() => registrationCredentials(body));
  assert.deepEqual(registrationCredentials({ username: 'valid', password: 'long-password-42' }), { username: 'valid', password: 'long-password-42' });
  const limiter = new RegistrationLimiter();
  const first = limiter.enter('one', 0), second = limiter.enter('two', 0);
  assert.throws(() => limiter.enter('three', 0), { code: 'registration_busy' }); first(); second();
  for (let n = 0; n < 9; n++) limiter.enter('one', 0)();
  assert.throws(() => limiter.enter('one', 0), { code: 'registration_rate_limit' });
  limiter.enter('one', 15 * 60_000)();
  assert.equal(requestPermission('PATCH', '/API/ADMIN/REGISTRATION-SETTINGS/'), 'roles.manage');
});

test('self registration enforces settings, selected roles and isolation on real routes', async t => {
  const f = await apiFixture();
  try {
    const call = async (path: string, method = 'GET', data?: unknown, cookie = '') => {
      const response = await fetch(f.url + '/api' + path, { method, headers: { Origin: f.url, 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: data === undefined ? undefined : JSON.stringify(data) });
      const body = await response.json();
      assert.deepEqual(validate({ method, url: '/api' + path, status: response.status, contentType: response.headers.get('content-type'), body, requestBody: response.status < 400 ? data : undefined }), []);
      return { status: response.status, body, cookie: response.headers.get('set-cookie')?.split(';')[0] ?? '' };
    };
    const root = await call('/login', 'POST', credentials), member = await call('/login', 'POST', memberCredentials);
    const rootId = (await f.pool.query('SELECT id FROM users WHERE username=$1', [credentials.username])).rows[0].id;
    let roleId = '', registeredId = '';
    await t.test('disabled by default and only authorized administrators can configure it', async () => {
      assert.equal((await call('/config')).body.registrationEnabled, false);
      assert.equal((await call('/register', 'POST', { username: 'public-user', password: 'public-password-42' })).status, 403);
      assert.equal((await call('/admin/registration-settings')).status, 401);
      assert.equal((await call('/admin/registration-settings', 'PATCH', { enabled: true, roleId: USER }, member.cookie)).status, 403);
      assert.equal((await call('/admin/registration-settings', 'PATCH', { enabled: true, roleId: ADMIN }, root.cookie)).status, 400);
      assert.equal((await call('/admin/registration-settings', 'PATCH', { enabled: true, roleId: crypto.randomUUID() }, root.cookie)).status, 400);
      const role = await call('/admin/roles', 'POST', { name: 'Registered reader', permissions: ['sessions.view'] }, root.cookie);
      roleId = role.body.role.id;
      assert.equal((await call('/admin/registration-settings', 'PATCH', { enabled: true, roleId }, root.cookie)).status, 200);
      assert.equal((await call('/config')).body.registrationEnabled, true);
      assert.equal((await call('/admin/roles/' + roleId, 'DELETE', undefined, root.cookie)).status, 409);
    });
    await t.test('the assigned role comes from the server and the new session has only its grants', async () => {
      assert.equal((await call('/register', 'POST', { username: 'public-user', password: 'public-password-42', roleId: ADMIN })).status, 400);
      const registered = await call('/register', 'POST', { username: 'public-user', password: 'public-password-42' });
      assert.equal(registered.status, 201); assert.ok(registered.cookie);
      registeredId = registered.body.user.id;
      assert.equal(registered.body.user.roleId, roleId); assert.deepEqual(registered.body.user.permissions, ['sessions.view']);
      assert.equal((await call('/admin/users', 'GET', undefined, registered.cookie)).status, 403);
      assert.equal((await call('/sessions', 'POST', {}, registered.cookie)).status, 403);
      assert.equal((await call('/register', 'POST', { username: 'public-user', password: 'public-password-42' })).status, 409);
      const row = (await f.pool.query('SELECT password_hash FROM users WHERE id=$1', [registeredId])).rows[0];
      assert.notEqual(row.password_hash, 'public-password-42'); assert.match(row.password_hash, /^scrypt/);
      assert.equal((await call('/login', 'POST', { username: 'public-user', password: 'public-password-42' })).status, 200);
    });
    await t.test('changing the default role applies only to new accounts and a deleted login inherits no data', async () => {
      assert.equal((await call('/admin/registration-settings', 'PATCH', { enabled: true, roleId: USER }, root.cookie)).status, 200);
      const next = await call('/register', 'POST', { username: 'next-user', password: 'next-password-42' });
      assert.equal(next.body.user.roleId, USER);
      assert.equal((await f.context.auth.userById(registeredId))?.roleId, roleId);
      await f.pool.query('UPDATE users SET removed_at=now() WHERE id=$1', [registeredId]);
      const reused = await call('/register', 'POST', { username: 'public-user', password: 'fresh-password-42' });
      assert.equal(reused.status, 201); assert.notEqual(reused.body.user.id, registeredId); assert.equal(reused.body.user.roleId, USER);
      assert.equal((await f.pool.query('SELECT count(*)::integer AS n FROM api_tokens WHERE owner_user_id=$1', [reused.body.user.id])).rows[0].n, 0);
      assert.equal((await call('/login', 'POST', { username: 'public-user', password: 'public-password-42' })).status, 401);
    });
    await t.test('registration rechecks settings after hashing and directory modes cannot enable it', async () => {
      const rejected = assert.rejects(registerAccount(f.pool, { username: 'in-flight-user', password: 'flight-password-42' }), { code: 'registration_disabled' });
      await updateRegistrationSettings(f.pool, { enabled: false, roleId: USER }, rootId, true);
      await rejected;
      assert.equal((await call('/config')).body.registrationEnabled, false);
      assert.equal((await call('/register', 'POST', { username: 'after-disable', password: 'public-password-42' })).status, 403);
      await assert.rejects(updateRegistrationSettings(f.pool, { enabled: true, roleId: USER }, rootId, false), { code: 'registration_unavailable' });
      assert.equal((await f.pool.query("SELECT count(*)::integer AS n FROM users WHERE username='in-flight-user'")).rows[0].n, 0);
      const audit = (await f.pool.query("SELECT * FROM audit_events WHERE action='auth.register'")).rows;
      assert.equal(audit.length, 3); assert.ok(audit.every(row => row.target_id && row.actor_user_id));
    });

  } finally { await f.close(); }
});
