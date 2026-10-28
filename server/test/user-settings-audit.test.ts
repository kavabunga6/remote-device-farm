import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import express from 'express';
import { Client as LdapClient } from 'ldapts';
import { PGlite } from '@electric-sql/pglite';
import type { Pool } from 'pg';
import type { AgentHub } from '../src/agent.js';
import type { Config } from '../src/config.js';
import { AuthService, newToken, tokenHash } from '../src/auth.js';
import { installAuditTrail } from '../src/audit.js';
import { ApiError } from '../src/http-common.js';
import { generateAdbKeyPair } from '../src/adb-key.js';
import { createServerContext } from '../src/server-context.js';
import { registerAdminRoutes } from '../src/routes/admin-routes.js';
import { registerAuthRoutes } from '../src/routes/auth-routes.js';
import { registerUserSettingsRoutes } from '../src/routes/user-settings-routes.js';

test('user settings, managed identity, password rotation, rental history and safe audit pagination', async () => {
  const database = new PGlite();
  let server: ReturnType<typeof createServer> | null = null;
  try {
    for (const file of ['001_init.sql', '005_host_settings.sql', '006_adb_port_access.sql',
      '008_user_adb_keys.sql', '009_uploaded_adb_public_keys.sql', '010_user_settings_audit.sql', '037_interface_scale.sql', '046_session_diagnostics.sql', '048_user_removal.sql', '049_access_roles.sql']) {
      await database.exec(await readFile(new URL('../migrations/' + file, import.meta.url), 'utf8'));
    }
    const client = { query: database.query.bind(database), release: () => {} };
    const pool = { query: database.query.bind(database), connect: async () => client } as unknown as Pool;
    const config = {
      authMode: 'local', localAdminUsername: 'owner', localAdminPassword: 'initial-password-123',
      adminSubjects: new Set<string>(), secureCookies: false,
    } as Config;
    const auth = new AuthService(pool, config);
    await auth.bootstrap();
    const beforeCompanyMigration = await database.query<Record<string, unknown>>('SELECT * FROM users ORDER BY id');
    await database.exec(await readFile(new URL('../migrations/019_user_company.sql', import.meta.url), 'utf8'));
    const afterCompanyMigration = await database.query<Record<string, unknown>>('SELECT * FROM users ORDER BY id');
    assert.ok(afterCompanyMigration.rows.every(row => row.company === null));
    assert.deepEqual(afterCompanyMigration.rows.map(({ company: _company, ...row }) => row), beforeCompanyMigration.rows);
    const owner = await database.query<{ id: string }>("SELECT id FROM users WHERE provider='local' AND username='owner'");
    const ownerId = owner.rows[0]!.id;
    const external = await auth.upsertExternalUser('ldap', 'cn=guest,dc=example', 'guest', 'Directory User',
      { firstName: 'Directory', lastName: 'User', jobTitle: 'QA engineer', company: 'Directory Company' });
    const cookieFor = async (userId: string): Promise<string> => {
      const raw = newToken();
      await database.query(
        'INSERT INTO browser_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,now()+interval \'1 day\')',
        [crypto.randomUUID(), userId, tokenHash(raw)],
      );
      return 'rdf_session=' + raw;
    };
    const ownerCookie = await cookieFor(ownerId);
    const externalCookie = await cookieFor(external.id);
    const hub = {} as AgentHub;
    const context = createServerContext(pool, config, auth, undefined, hub);
    const app = express();
    app.use(express.json());
    installAuditTrail(app, pool);
    registerAuthRoutes(app, context);
    registerUserSettingsRoutes(app, context);
    registerAdminRoutes(app, context);
    app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      if (error instanceof ApiError) res.status(error.status).json({ code: error.code });
      else { console.error(error); res.status(500).json({ code: 'internal_error' }); }
    });
    server = createServer(app);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const base = 'http://127.0.0.1:' + address.port;
    const request = (path: string, cookie: string, method = 'GET', body?: unknown) => fetch(base + path, {
      method, headers: { Cookie: cookie, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    const managed = await request('/api/me/profile', externalCookie);
    const managedProfile = (await managed.json() as { profile: { firstName: string; jobTitle: string; company: string } }).profile;
    assert.equal(managedProfile.firstName, 'Directory');
    assert.equal(managedProfile.company, 'Directory Company');
    assert.equal(managedProfile.jobTitle, 'QA engineer');
    assert.equal((await request('/api/me/profile', externalCookie, 'PATCH',
      { company: 'Changed locally', jobTitle: 'Changed locally' })).status, 409);
    assert.equal((await request('/api/me/password', externalCookie, 'POST',
      { currentPassword: 'x', newPassword: 'new-password-456' })).status, 409);

    const profile = await request('/api/me/profile', ownerCookie, 'PATCH',
      { firstName: 'Owner', lastName: 'Tester', jobTitle: 'SECRET_MARKER', company: '  COMPANY_SECRET_MARKER  ' });
    assert.equal(profile.status, 200);
    const savedProfile = (await profile.json() as { profile: { displayName: string; company: string } }).profile;
    assert.equal(savedProfile.displayName, 'Owner Tester');
    assert.equal(savedProfile.company, 'COMPANY_SECRET_MARKER');
    assert.equal((await (await request('/api/me', ownerCookie)).json() as { user: { company: string } }).user.company, 'COMPANY_SECRET_MARKER');
    for (const invalid of ['x'.repeat(151), 'Invalid\nCompany', 42, {}]) {
      assert.equal((await request('/api/me/profile', ownerCookie, 'PATCH', { company: invalid })).status, 400);
    }
    const cleared = await request('/api/me/profile', ownerCookie, 'PATCH', { company: '' });
    assert.equal((await cleared.json() as { profile: { company: string | null } }).profile.company, null);

    assert.equal((await request('/api/admin/users', externalCookie)).status, 403);
    const created = await request('/api/admin/users', ownerCookie, 'POST', {
      username: 'new-user', displayName: 'New User', password: 'initial-password-789',
      company: 'COMPANY_SECRET_MARKER', jobTitle: 'Engineer',
    });
    assert.equal(created.status, 201);
    const createdUser = (await created.json() as { user: { id: string; company: string; jobTitle: string } }).user;
    assert.equal(createdUser.company, 'COMPANY_SECRET_MARKER');
    assert.equal(createdUser.jobTitle, 'Engineer');
    const invalidCreated = await request('/api/admin/users', ownerCookie, 'POST', {
      username: 'invalid-user', password: 'initial-password-789', company: 'x'.repeat(151),
    });
    assert.equal(invalidCreated.status, 400);
    const userPath = '/api/admin/users/' + createdUser.id;
    assert.equal((await request(userPath, externalCookie, 'PATCH', { company: 'forbidden' })).status, 403);
    assert.equal((await request('/api/admin/users/' + external.id, ownerCookie, 'PATCH', { company: 'forbidden' })).status, 409);
    const updated = await request(userPath, ownerCookie, 'PATCH', { displayName: 'Updated User', company: 'Updated Company', jobTitle: 'QA engineer' });
    assert.equal(updated.status, 200);
    const updatedUser = (await updated.json() as { user: { displayName: string; company: string; jobTitle: string } }).user;
    assert.deepEqual([updatedUser.displayName, updatedUser.company, updatedUser.jobTitle], ['Updated User', 'Updated Company', 'QA engineer']);
    const newUserCookie = await cookieFor(createdUser.id);
    const fullProfile = await request('/api/me/profile', newUserCookie, 'PATCH', {
      firstName: '', lastName: '', company: 'Updated Company', jobTitle: 'QA engineer',
    });
    assert.equal(fullProfile.status, 200);
    assert.equal((await fullProfile.json() as { profile: { displayName: string } }).profile.displayName, 'Updated User');
    const listed = await request('/api/admin/users', ownerCookie);
    const listedUser = (await listed.json() as { users: Array<{ id: string; company: string; jobTitle: string; password_hash?: unknown }> }).users.find(user => user.id === createdUser.id);
    assert.equal(listedUser?.company, 'Updated Company');
    assert.equal(listedUser?.jobTitle, 'QA engineer');
    assert.equal(listedUser?.password_hash, undefined);
    assert.equal((await request(userPath, ownerCookie, 'PATCH', { role: 'admin' })).status, 400);
    assert.equal((await request(userPath, ownerCookie, 'PATCH', { displayName: '  ' })).status, 400);
    assert.equal((await request(userPath, ownerCookie, 'PATCH', { jobTitle: 'x'.repeat(151) })).status, 400);
    assert.equal((await request(userPath, ownerCookie, 'PATCH', { company: 'x\u0000y' })).status, 400);
    assert.equal((await request('/api/admin/users/not-a-uuid', ownerCookie, 'PATCH', { company: '' })).status, 400);
    assert.equal((await request('/api/admin/users/99999999-9999-4999-8999-999999999999', ownerCookie, 'PATCH', { company: '' })).status, 404);
    const emptyFields = await request(userPath, ownerCookie, 'PATCH', { company: null, jobTitle: '' });
    const emptyUser = (await emptyFields.json() as { user: { company: null; jobTitle: null; displayName: string } }).user;
    assert.deepEqual([emptyUser.company, emptyUser.jobTitle, emptyUser.displayName], [null, null, 'Updated User']);
    const resetPath = userPath + '/password';
    const resetSecret = 'admin-reset-password-SECRET_MARKER';
    const secondUserCookie = await cookieFor(createdUser.id);
    assert.equal((await request(resetPath, '', 'POST', { newPassword: resetSecret })).status, 401);
    assert.equal((await request(resetPath, newUserCookie, 'POST', { newPassword: resetSecret })).status, 403);
    assert.equal((await request('/api/admin/users/' + external.id + '/password', ownerCookie, 'POST', { newPassword: resetSecret })).status, 409);
    const systemId = (await database.query<{ id: string }>("SELECT id FROM users WHERE provider='system'")).rows[0]!.id;
    assert.equal((await request('/api/admin/users/' + systemId + '/password', ownerCookie, 'POST', { newPassword: resetSecret })).status, 404);
    assert.equal((await request('/api/admin/users/not-a-uuid/password', ownerCookie, 'POST', { newPassword: resetSecret })).status, 400);
    assert.equal((await request('/api/admin/users/99999999-9999-4999-8999-999999999999/password', ownerCookie, 'POST', { newPassword: resetSecret })).status, 404);
    for (const body of [{}, { newPassword: 'short' }, { newPassword: 'x'.repeat(2049) }, { newPassword: null }, { newPassword: resetSecret, role: 'admin' }, []]) {
      assert.equal((await request(resetPath, ownerCookie, 'POST', body)).status, 400);
    }
    assert.ok(await auth.loginLocal('new-user', 'initial-password-789'));
    assert.equal((await request('/api/me/profile', newUserCookie)).status, 200, 'denied resets preserve the existing login');
    const reset = await request(resetPath, ownerCookie, 'POST', { newPassword: resetSecret });
    assert.equal(reset.status, 200);
    assert.deepEqual(await reset.json(), { ok: true });
    assert.equal((await request('/api/me/profile', newUserCookie)).status, 401);
    assert.equal((await request('/api/me/profile', secondUserCookie)).status, 401);
    assert.equal(await auth.loginLocal('new-user', 'initial-password-789'), null);
    assert.ok(await auth.loginLocal('new-user', resetSecret));
    const resetHash = (await database.query<{ password_hash: string }>('SELECT password_hash FROM users WHERE id=$1', [createdUser.id])).rows[0]!.password_hash;
    assert.ok(resetHash.startsWith('scrypt$'));
    assert.equal(resetHash.includes(resetSecret), false);
    assert.equal((await request('/api/me/profile', ownerCookie)).status, 200, 'other users keep their browser login');

    const defaults = await request('/api/me/preferences', ownerCookie);
    assert.deepEqual(await defaults.json(), { preferences: {
      theme: 'system', fontFamily: 'system', fontScale: 0, defaultAdbKeyId: null,
    } });
    const accountChanged = await request('/api/me/preferences', externalCookie, 'PATCH',
      { expectedUserId: ownerId, theme: 'dark' });
    assert.equal(accountChanged.status, 409);
    assert.equal((await database.query('SELECT count(*)::integer AS count FROM user_preferences WHERE user_id=$1', [external.id])).rows[0]?.count, 0);
    assert.equal((await request('/api/me/preferences?expectedUserId=' + ownerId, externalCookie)).status, 409);
    assert.equal((await request('/api/me/preferences', ownerCookie, 'PATCH', { expectedUserId: ownerId, theme: 'system' })).status, 200);
    const pair = await generateAdbKeyPair();
    const ownKey = '22222222-2222-4222-8222-222222222222';
    const foreignKey = '33333333-3333-4333-8333-333333333333';
    await database.query(
      'INSERT INTO user_adb_public_keys(id,owner_user_id,name,public_key,fingerprint) VALUES($1,$2,$3,$4,$5),($6,$7,$8,$4,$5)',
      [ownKey, ownerId, 'Owner key', pair.publicKey, pair.fingerprint,
        foreignKey, external.id, 'Directory key'],
    );
    const deniedDefault = await request('/api/me/preferences', ownerCookie, 'PATCH',
      { defaultAdbKeyId: foreignKey });
    assert.equal(deniedDefault.status, 404);
    const changed = await request('/api/me/preferences', ownerCookie, 'PATCH',
      { theme: 'dark', fontFamily: 'mono', fontScale: 1.15, defaultAdbKeyId: ownKey });
    assert.equal(changed.status, 200);
    for (const [fontScale, status] of [[0, 200], [1.5, 200], [1.51, 400], [0.5, 400], [0.9, 200]] as const) {
      assert.equal((await request('/api/me/preferences', ownerCookie, 'PATCH', { fontScale })).status, status, String(fontScale));
    }
    await request('/api/me/preferences', ownerCookie, 'PATCH', { fontScale: 1.15 });
    assert.deepEqual(await changed.json(), { preferences: {
      theme: 'dark', fontFamily: 'mono', fontScale: 1.15, defaultAdbKeyId: ownKey,
    } });
    await database.query('DELETE FROM user_adb_public_keys WHERE id=$1', [ownKey]);
    const afterDelete = await request('/api/me/preferences', ownerCookie);
    assert.equal((await afterDelete.json() as { preferences: { defaultAdbKeyId: string | null } }).preferences.defaultAdbKeyId, null);

    const wrongPassword = await request('/api/me/password', ownerCookie, 'POST',
      { currentPassword: 'bad-password', newPassword: 'new-password-456' });
    assert.equal(wrongPassword.status, 403);
    const passwordChanged = await request('/api/me/password', ownerCookie, 'POST',
      { currentPassword: 'initial-password-123', newPassword: 'new-password-456' });
    assert.equal(passwordChanged.status, 200);
    const newCookie = passwordChanged.headers.get('set-cookie')?.split(';')[0] || '';
    assert.match(newCookie, /^rdf_session=/);
    assert.equal((await request('/api/me/profile', ownerCookie)).status, 401);
    await auth.bootstrap();
    assert.equal(await auth.loginLocal('owner', 'initial-password-123'), null);
    assert.ok(await auth.loginLocal('owner', 'new-password-456'));

    await database.query("INSERT INTO hosts(id,name,slots) VALUES('host-1','Host',1)");
    const sessionId = '44444444-4444-4444-8444-444444444444';
    await database.query(
      "INSERT INTO sessions(id,owner_user_id,host_id,profile_id,state) VALUES($1,$2,'host-1','android-30','starting')",
      [sessionId, external.id],
    );
    await database.query("UPDATE sessions SET state='running',started_at=now() WHERE id=$1", [sessionId]);
    await database.query('DELETE FROM sessions WHERE id=$1', [sessionId]);
    assert.equal((await database.query('SELECT id FROM sessions WHERE id=$1', [sessionId])).rows.length, 0);
    const ownHistory = await request('/api/me/rentals', externalCookie);
    const ownRentals = await ownHistory.json() as { rentals: Array<{ sessionId: string; endedAt: string }> };
    assert.equal(ownRentals.rentals[0]?.sessionId, sessionId);
    assert.ok(ownRentals.rentals[0]?.endedAt);
    assert.equal((await request('/api/admin/rentals', externalCookie)).status, 403);
    const adminRentals = await request('/api/admin/rentals', newCookie);
    assert.equal((await adminRentals.json() as { rentals: Array<{ sessionId: string }> }).rentals[0]?.sessionId, sessionId);
    const today = new Date().toISOString().slice(0, 10);
    const matchingRentals = await request('/api/admin/rentals?owner=guest&host=host-1&from=' + today, newCookie);
    assert.equal((await matchingRentals.json() as { rentals: unknown[] }).rentals.length, 1);
    const missingRentals = await request('/api/admin/rentals?owner=someone-else', newCookie);
    assert.equal((await missingRentals.json() as { rentals: unknown[] }).rentals.length, 0);
    assert.equal((await request('/api/admin/rentals?from=2026-02-30', newCookie)).status, 400);
    assert.equal((await request('/api/admin/audit', externalCookie)).status, 403);
    assert.equal((await request('/api/admin/logs', externalCookie)).status, 403);
    const logsPage = await request('/api/admin/logs?limit=1', newCookie);
    const logs = await logsPage.json() as { events: Array<{ code: string }>; nextCursor: string | null };
    assert.equal(logs.events.length, 1);
    assert.ok(['emulator.released', 'agent.online'].includes(logs.events[0]!.code));
    assert.ok(logs.nextCursor);
    const olderLogs = await request('/api/admin/logs?limit=1&before=' + logs.nextCursor, newCookie);
    assert.equal((await olderLogs.json() as { events: Array<{ code: string }> }).events.length, 1);
    const filteredLogs = await request('/api/admin/logs?severity=info&service=emulator&host=host-1', newCookie);
    const filteredLogRows = (await filteredLogs.json() as { events: Array<{ code: string; severity: string }> }).events;
    assert.ok(filteredLogRows.length > 0);
    assert.ok(filteredLogRows.every(row => row.severity === 'info'));
    assert.equal((await request('/api/admin/logs?severity=verbose', newCookie)).status, 400);

    // Response logging is asynchronous by design; wait for the last relevant event.
    for (let index = 0; index < 30; index++) {
      const total = await database.query<{ count: number }>(
        "SELECT count(*)::integer AS count FROM audit_events WHERE action='account.password_changed'",
      );
      if (total.rows[0]!.count >= 2) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const filteredActions = await request('/api/admin/audit?actor=owner&action=account.password_changed&from=' + today, newCookie);
    const filteredActionRows = (await filteredActions.json() as { events: Array<{ action: string; actorUsername: string }> }).events;
    assert.ok(filteredActionRows.length >= 2);
    assert.ok(filteredActionRows.every(row => row.action === 'account.password_changed' && row.actorUsername === 'owner'));
    assert.equal((await request('/api/admin/audit?action=not/a/code', newCookie)).status, 400);
    const firstPage = await request('/api/admin/audit?limit=2', newCookie);
    const first = await firstPage.json() as { events: Array<{ id: string }>; nextCursor: string | null };
    assert.equal(first.events.length, 2);
    assert.ok(first.nextCursor);
    const secondPage = await request('/api/admin/audit?limit=2&before=' + first.nextCursor, newCookie);
    const second = await secondPage.json() as { events: Array<{ id: string }> };
    assert.ok(second.events.every(item => !first.events.some(previous => previous.id === item.id)));
    const allAudit = await database.query<Record<string, unknown>>('SELECT * FROM audit_events ORDER BY id');
    const allLogs = await database.query<Record<string, unknown>>('SELECT * FROM service_logs ORDER BY id');
    assert.equal(JSON.stringify(allLogs.rows).includes('SECRET_MARKER'), false);
    assert.equal(JSON.stringify(allAudit.rows).includes('SECRET_MARKER'), false);
    assert.ok(allAudit.rows.some(row => row.action === 'admin.user_updated' && row.target_id === createdUser.id && row.outcome === 'success'));
    assert.ok(allAudit.rows.some(row => row.action === 'admin.user_password_reset' && row.target_id === createdUser.id && row.actor_user_id === ownerId && row.outcome === 'success'));
    assert.ok(allAudit.rows.some(row => row.action === 'admin.user_password_reset' && row.outcome === 'denied'));
    assert.equal(JSON.stringify(allAudit.rows).includes(resetSecret), false);
    assert.equal(JSON.stringify(allAudit.rows).includes('new-password-456'), false);
    assert.equal(JSON.stringify(allAudit.rows).includes(pair.publicKey.slice(0, 20)), false);
    const wrongAudit = allAudit.rows.find(row => row.action === 'account.password_changed' && row.outcome === 'denied');
    assert.ok(wrongAudit);
    const diagnosticId = '11111111-1111-4111-8111-111111111111';
    await database.query("INSERT INTO service_logs(service,severity,code,session_id,message) VALUES('emulator','error','session.start_failed',$1,'Vulkan init failed; exit 139')",[diagnosticId]);
    const diagnosticLogs=await request('/api/admin/logs?session=11111111',newCookie);
    assert.equal(diagnosticLogs.status,200);
    const filteredBody=await diagnosticLogs.json() as {events:Array<{sessionId:string;message:string}>};
    assert.equal(filteredBody.events.length,1);
    assert.equal(filteredBody.events[0].sessionId,diagnosticId);
    assert.match(filteredBody.events[0].message,/exit 139/);
    assert.equal((await request('/api/admin/logs?session=%25',newCookie)).status,400);
    assert.equal((await request('/api/admin/logs?session=11111111',externalCookie)).status,403);
    const sessionLogPage=await request('/api/admin/session-diagnostics?session=11111111&limit=1',newCookie);
    assert.equal(sessionLogPage.status,200);
    const sessionLogBody=await sessionLogPage.json() as {events:Array<{id:string;message:string}>;nextCursor:string;hasMore:boolean};
    assert.match(sessionLogBody.events[0].message,/exit 139/);
    assert.equal(sessionLogBody.hasMore,false);
    const tail=await (await request('/api/admin/session-diagnostics?session=11111111&after='+sessionLogBody.nextCursor,newCookie)).json() as {events:unknown[]};
    assert.deepEqual(tail.events,[]);
    assert.equal((await request('/api/admin/session-diagnostics?session=11111111',externalCookie)).status,403);
    const otherAdminCookie = await cookieFor(ownerId);
    const selfReset = await request('/api/admin/users/' + ownerId + '/password', newCookie, 'POST', { newPassword: 'admin-self-reset-password' });
    assert.equal(selfReset.status, 200);
    const renewedCookie = selfReset.headers.get('set-cookie')?.split(';')[0] || '';
    assert.ok(renewedCookie);
    assert.equal((await request('/api/me/profile', renewedCookie)).status, 200);
    assert.equal((await request('/api/me/profile', newCookie)).status, 401);
    assert.equal((await request('/api/me/profile', otherAdminCookie)).status, 401);
    config.authMode = 'ldap';
    assert.equal((await request(resetPath, renewedCookie, 'POST', { newPassword: resetSecret })).status, 409);

  } finally {
    if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
    await database.close();
  }
});


test('LDAP maps company and title, updates provider data and falls back to organization', async context => {
  const database = new PGlite();
  try {
    for (const file of ['001_init.sql', '005_host_settings.sql', '006_adb_port_access.sql', '008_user_adb_keys.sql',
      '009_uploaded_adb_public_keys.sql', '010_user_settings_audit.sql', '019_user_company.sql', '037_interface_scale.sql', '046_session_diagnostics.sql', '048_user_removal.sql', '049_access_roles.sql']) {
      await database.exec(await readFile(new URL('../migrations/' + file, import.meta.url), 'utf8'));
    }
    const pool = { query: database.query.bind(database) } as unknown as Pool;
    const config = { adminSubjects: new Set<string>(), ldap: {
      url: 'ldap://directory.invalid', bindDn: 'cn=service', bindPassword: 'test',
      baseDn: 'dc=example', userFilter: '(uid={{username}})',
    } } as Config;
    const auth = new AuthService(pool, config);
    let entry: Record<string, unknown> = {
      dn: 'cn=reader,dc=example', displayName: 'Directory Reader',
      givenName: 'Directory', sn: 'Reader', title: ['QA engineer'], company: [' Company Name '],
    };
    context.mock.method(LdapClient.prototype, 'bind', async () => {});
    context.mock.method(LdapClient.prototype, 'unbind', async () => {});
    context.mock.method(LdapClient.prototype, 'search', async (_base: string, options: { attributes: string[] }) => {
      assert.ok(options.attributes.includes('company'));
      assert.ok(options.attributes.includes('o'));
      return { searchEntries: [entry], searchReferences: [] };
    });
    const first = await auth.loginLdap('reader', 'test');
    assert.equal(first?.company, 'Company Name');
    assert.equal(first?.jobTitle, 'QA engineer');
    entry = { ...entry, company: undefined, o: ['Other Organization'], title: 'Developer' };
    const changed = await auth.loginLdap('reader', 'test');
    assert.equal(changed?.id, first?.id);
    assert.equal(changed?.company, 'Other Organization');
    assert.equal(changed?.jobTitle, 'Developer');
    entry = { ...entry, o: 'x'.repeat(151), title: 'bad\nrole' };
    const invalid = await auth.loginLdap('reader', 'test');
    assert.equal(invalid?.company, null);
    assert.equal(invalid?.jobTitle, null);
  } finally { await database.close(); }
});
