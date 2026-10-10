import assert from 'node:assert/strict';
import test from 'node:test';
import type { Config } from '../src/config.js';
import { AuthService } from '../src/auth.js';
import { apiFixture, credentials } from './support/api-fixture.js';

async function fixture() {
  const f = await apiFixture();
  const request = (method: string, path: string, cookie = '', body?: unknown) => fetch(f.url + path, {
    method,
    headers: { origin: f.url, Cookie: cookie, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const login = async (username: string, password: string) => {
    const response = await request('POST', '/api/login', '', { username, password });
    assert.equal(response.status, 200);
    return response.headers.get('set-cookie')!.split(';')[0]!;
  };
  try {
    return { ...f, request, login, adminCookie: await login(credentials.username, credentials.password) };
  } catch (error) {
    await f.close();
    throw error;
  }
}

test('reusing a deleted login creates an isolated account and keeps old access revoked', async () => {
  const f = await fixture();
  try {
    const username = 'reusable-user', oldPassword = 'original-password-123', newPassword = 'replacement-password-456';
    const original = await f.request('POST', '/api/admin/users', f.adminCookie, {
      username, password: oldPassword, role: 'admin', displayName: 'Original User', company: 'Original Company',
    });
    assert.equal(original.status, 201);
    const oldId = (await original.json()).user.id as string;
    const oldCookie = await f.login(username, oldPassword);
    assert.equal((await f.request('PATCH', '/api/me/preferences', oldCookie, { theme: 'dark', fontFamily: 'mono' })).status, 200);
    const issued = await f.request('POST', '/api/tokens', oldCookie, { name: 'Original token' });
    assert.equal(issued.status, 201);
    const oldToken = (await issued.json()).token as string;
    assert.equal(typeof oldToken, 'string');
    const withOldToken = () => fetch(f.url + '/api/me/preferences', { headers: { Authorization: 'Bearer ' + oldToken } });
    assert.equal((await withOldToken()).status, 200);
    const sessionId = crypto.randomUUID();
    await f.pool.query(
      "INSERT INTO sessions(id,owner_user_id,host_id,profile_id,state,ended_at) VALUES($1,$2,'contract-node','contract-profile','stopped',now())",
      [sessionId, oldId],
    );
    await f.pool.query(
      "INSERT INTO user_adb_public_keys(id,owner_user_id,name,public_key,fingerprint) VALUES($1,$2,'Original key','test-key',$3)",
      [crypto.randomUUID(), oldId, 'a'.repeat(64)],
    );
    assert.equal((await f.request('GET', '/api/sessions/' + sessionId, oldCookie)).status, 200);
    assert.equal((await f.request('DELETE', '/api/admin/users/' + oldId, f.adminCookie)).status, 200);
    // Retained deleted identities must support explicit account creation.
    const replacement = await f.request('POST', '/api/admin/users', f.adminCookie, { username, password: newPassword });
    assert.equal(replacement.status, 201);
    const newId = (await replacement.json()).user.id as string;
    assert.notEqual(newId, oldId);
    const newCookie = await f.login(username, newPassword);
    const { user } = await (await f.request('GET', '/api/me', newCookie)).json();
    assert.equal(user.id, newId);
    assert.equal(user.role, 'user');
    assert.equal(user.company, null);
    assert.equal((await f.request('GET', '/api/admin/users', newCookie)).status, 403);
    assert.equal((await f.request('POST', '/api/login', '', { username, password: oldPassword })).status, 401);
    assert.equal((await f.request('GET', '/api/me/preferences', oldCookie)).status, 401);
    assert.equal((await withOldToken()).status, 401);
    assert.equal((await (await f.request('GET', '/api/me/preferences', newCookie)).json()).preferences.theme, 'system');
    assert.deepEqual((await (await f.request('GET', '/api/me/rentals', newCookie)).json()).rentals, []);
    assert.deepEqual((await (await f.request('GET', '/api/me/adb-public-keys', newCookie)).json()).keys, []);
    assert.equal((await f.request('GET', '/api/sessions/' + sessionId, newCookie)).status, 404);
    const history = await f.pool.query('SELECT owner_user_id FROM rental_history WHERE session_id=$1', [sessionId]);
    assert.equal(history.rows[0].owner_user_id, oldId);
    const removed = await f.pool.query('SELECT username,removed_at,password_hash FROM users WHERE id=$1', [oldId]);
    assert.equal(removed.rows[0].username, username);
    assert.ok(removed.rows[0].removed_at);
    assert.equal(removed.rows[0].password_hash, null);
    const listing = await (await f.request('GET', '/api/admin/users', f.adminCookie)).json();
    assert.deepEqual(listing.users.filter((u: { username: string }) => u.username === username).map((u: { id: string }) => u.id), [newId]);
    const duplicate = await f.request('POST', '/api/admin/users', f.adminCookie, { username, password: oldPassword });
    assert.equal(duplicate.status, 409);
    assert.equal((await duplicate.json()).error.code, 'user_exists');
    assert.equal((await f.request('DELETE', '/api/admin/users/' + newId, f.adminCookie)).status, 200);
    const attempts = await Promise.all([newPassword, oldPassword].map(password =>
      f.request('POST', '/api/admin/users', f.adminCookie, { username, password })));
    assert.deepEqual(attempts.map(r => r.status).sort(), [201, 409]);
    const thirdId = (await attempts.find(r => r.status === 201)!.json()).user.id as string;
    assert.notEqual(thirdId, oldId);
    assert.notEqual(thirdId, newId);
    assert.equal((await f.request('GET', '/api/me/preferences', newCookie)).status, 401);
  } finally {
    await f.close();
  }
});

test('a removed bootstrap administrator stays disabled until explicitly recreated', async () => {
  const f = await fixture();
  try {
    const created = await f.request('POST', '/api/admin/users', f.adminCookie, {
      username: 'other-admin', password: 'other-admin-password-123', role: 'admin',
    });
    assert.equal(created.status, 201);
    const otherCookie = await f.login('other-admin', 'other-admin-password-123');
    const oldId = (await (await f.request('GET', '/api/me', f.adminCookie)).json()).user.id as string;
    assert.equal((await f.request('DELETE', '/api/admin/users/' + oldId, otherCookie)).status, 200);
    const auth = new AuthService(f.pool, {
      authMode: 'local', localAdminUsername: credentials.username, localAdminPassword: credentials.password,
    } as Config);
    await auth.bootstrap();
    assert.equal(await auth.loginLocal(credentials.username, credentials.password), null);
    // A rejected request must not release the deleted identity for bootstrap to recreate.
    const rejected = await f.request('POST', '/api/admin/users', otherCookie, {
      ...credentials, roleId: '22222222-2222-4222-8222-222222222222',
    });
    assert.equal(rejected.status, 400);
    await auth.bootstrap();
    assert.equal(await auth.loginLocal(credentials.username, credentials.password), null);
    const password = 'new-admin-login-password-456';
    const recreated = await f.request('POST', '/api/admin/users', otherCookie, { username: credentials.username, password });
    assert.equal(recreated.status, 201);
    const newId = (await recreated.json()).user.id as string;
    assert.notEqual(newId, oldId);
    await auth.bootstrap();
    assert.equal(await auth.loginLocal(credentials.username, credentials.password), null);
    const user = await auth.loginLocal(credentials.username, password);
    assert.equal(user?.id, newId);
    assert.equal(user?.role, 'user');
  } finally {
    await f.close();
  }
});
