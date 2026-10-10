import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';
import express from 'express';
import { PGlite } from '@electric-sql/pglite';
import type { Pool } from 'pg';
import type { Config } from '../src/config.js';
import type { AgentHub } from '../src/agent.js';
import { AuthService, hashPassword, newToken, tokenHash } from '../src/auth.js';
import { migrate } from '../src/db.js';
import { ApiError } from '../src/http-common.js';
import { assertUserActive } from '../src/user-removal.js';
import { installAuditTrail } from '../src/audit.js';
import { createServerContext } from '../src/server-context.js';
import { registerAdminRoutes } from '../src/routes/admin-routes.js';

const id = () => crypto.randomUUID();
test('user removal protects accounts, revokes all access and preserves history', async () => {
  const db = new PGlite();
  const query = async (sql: string, params?: unknown[]) => {
    const result = params === undefined ? (await db.exec(sql)).at(-1)! : await db.query(sql, params);
    return { ...result, rowCount: result.rows.length || result.affectedRows || 0 };
  };
  const client = { query, release() {} };
  const pool = { query, connect: async () => client } as unknown as Pool;
  let server: ReturnType<typeof createServer> | undefined;
  try {
    await migrate(pool);
    const password = 'initial-password-123';
    const config = { authMode: 'local', localAdminUsername: 'root', localAdminPassword: password, adminSubjects: new Set(), secureCookies: false } as Config;
    const auth = new AuthService(pool, config); await auth.bootstrap();
    const admin = (await query("SELECT id FROM users WHERE username='root'")).rows[0].id as string;
    const target = id(), external = id();
    await db.query(`INSERT INTO users(id,provider,subject,username,display_name,role,password_hash)
      VALUES($1,'local','reader','reader','Reader','user',$3),
      ($2,'ldap','cn=reader','directory','Directory','user',NULL)`, [target, external, await hashPassword(password)]);
    const cookie = async (userId: string) => {
      const raw = newToken();
      await db.query("INSERT INTO browser_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,now()+interval '1 day')", [id(), userId, tokenHash(raw)]);
      return 'rdf_session=' + raw;
    };
    const adminCookie = await cookie(admin), userCookie = await cookie(target);
    const app = express(); app.use(express.json()); installAuditTrail(app, pool);
    registerAdminRoutes(app, createServerContext(pool, config, auth, undefined, {} as AgentHub));
    app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      if (error instanceof ApiError) res.status(error.status).json({ code: error.code });
      else { console.error(error); res.status(500).json({ code: 'internal_error' }); }
    });
    server = createServer(app); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const request = (userId: string, credential = adminCookie) => fetch(`http://127.0.0.1:${address.port}/api/admin/users/${userId}`, { method: 'DELETE', headers: { Cookie: credential } });
    assert.equal((await request(target, '')).status, 401);
    assert.equal((await request(admin, userCookie)).status, 403);
    assert.equal((await request('invalid')).status, 400);
    assert.equal((await request(id())).status, 404);
    assert.equal((await (await request(admin)).json()).code, 'self_removal');
    const system = (await query("SELECT id FROM users WHERE provider='system'")).rows[0].id as string;
    assert.equal((await request(system)).status, 404);
    // A system administrator also cannot remove the last human administrator.
    await db.query("INSERT INTO api_tokens(id,kind,name,token_hash) VALUES($1,'system','Admin',$2)", [id(), tokenHash('system-secret')]);
    const last = await fetch(`http://127.0.0.1:${address.port}/api/admin/users/${admin}`, { method: 'DELETE', headers: { Authorization: 'Bearer system-secret' } });
    assert.equal((await last.json()).code, 'last_admin');
    const session = id();
    await db.query("INSERT INTO hosts(id,name) VALUES('host','Host')");
    await db.query("INSERT INTO sessions(id,owner_user_id,host_id,profile_id,state) VALUES($1,$2,'host','android-30','running')", [session, target]);
    assert.ok(await auth.loginLocal('reader', password));
    await db.query("UPDATE sessions SET state='stopped',ended_at=now() WHERE id=$1", [session]);
    const raw = newToken();
    await db.query("INSERT INTO api_tokens(id,owner_user_id,kind,name,token_hash) VALUES($1,$2,'personal','Test',$3)", [id(), target, tokenHash(raw)]);
    await db.query('INSERT INTO user_adb_keys(user_id,public_key,fingerprint) VALUES($1,$2,$3)', [target, 'test-key', 'a'.repeat(64)]);
    await db.query("INSERT INTO user_adb_public_keys(id,owner_user_id,name,public_key,fingerprint) VALUES($1,$2,'Test',$3,$4)", [id(), target, 'test-key', 'b'.repeat(64)]);
    await db.query("INSERT INTO adb_access_tokens(token_hash,session_id,owner_user_id,expires_at) VALUES('adb-token',$1,$2,now()+interval '1 hour')", [session, target]);
    const queued = id();
    await db.query("INSERT INTO queue_entries(id,user_id,profile_id,expires_at) VALUES($1,$2,'android-30',now()+interval '1 hour')", [queued, target]);
    await db.query("INSERT INTO webhooks(id,user_id,url,secret,events) VALUES($1,$2,'https://hooks.invalid','secret',ARRAY['session.ready'])", [id(), target]);
    const share = id(), grant = id();
    await db.query("INSERT INTO session_shares(id,session_id,created_by,token_hash,mode,max_recipients,expires_at) VALUES($1,$2,$3,'share','view',1,now()+interval '1 hour')", [share, session, admin]);
    await db.query("INSERT INTO session_share_grants(id,share_id,session_id,user_id,mode,expires_at) VALUES($1,$2,$3,$4,'view',now()+interval '1 hour')", [grant, share, session, target]);
    assert.equal((await request(target)).status, 200);
    assert.equal(await auth.loginLocal('reader', password), null);
    assert.equal(await auth.authenticate({ headers: { cookie: userCookie } } as never), null);
    assert.equal(await auth.authenticate({ headers: { authorization: 'Bearer ' + raw } } as never), null);
    assert.equal((await query('SELECT state FROM queue_entries WHERE id=$1', [queued])).rows[0].state, 'cancelled');
    assert.equal((await query('SELECT enabled FROM webhooks WHERE user_id=$1', [target])).rows[0].enabled, false);
    assert.ok((await query('SELECT revoked_at FROM session_share_grants WHERE id=$1', [grant])).rows[0].revoked_at);
    assert.equal((await query('SELECT owner_user_id FROM rental_history WHERE session_id=$1', [session])).rows[0].owner_user_id, target);
    for (const [table, column] of [['browser_sessions','user_id'], ['api_tokens','owner_user_id'], ['adb_access_tokens','owner_user_id'], ['user_adb_keys','user_id'], ['user_adb_public_keys','owner_user_id']]) {
      assert.equal((await query(`SELECT 1 FROM ${table} WHERE ${column}=$1`, [target])).rows.length, 0, table);
    }
    const listing = await fetch(`http://127.0.0.1:${address.port}/api/admin/users`, { headers: { Cookie: adminCookie } });
    assert.equal((await listing.json()).users.some((user: { id: string }) => user.id === target), false);
    await assert.rejects(assertUserActive(client as never, target), (error: unknown) => error instanceof ApiError && error.status === 401);
    assert.equal((await request(target)).status, 404);
    const resetRemoved = await fetch(`http://127.0.0.1:${address.port}/api/admin/users/${target}/password`, {
      method: 'POST', headers: { Cookie: adminCookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ newPassword: password }),
    });
    assert.equal(resetRemoved.status, 404);
    assert.equal((await request(external)).status, 200);
    await assert.rejects(auth.upsertExternalUser('ldap', 'cn=reader', 'directory', 'Directory'), (error: unknown) => error instanceof ApiError && error.status === 401);
    await auth.bootstrap();
    assert.ok((await query('SELECT removed_at FROM users WHERE id=$1', [external])).rows[0].removed_at);
    for (let i=0; i<20; i++) {
      if ((await query("SELECT 1 FROM audit_events WHERE action='admin.user_removed' AND outcome='success' AND target_id=$1", [target])).rows.length) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.ok((await query("SELECT 1 FROM audit_events WHERE action='admin.user_removed' AND outcome='success' AND target_id=$1", [target])).rows.length);
  } finally {
    if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
    await db.close();
  }
});
