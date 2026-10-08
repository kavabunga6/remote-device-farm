import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';
import express from 'express';
import { PGlite } from '@electric-sql/pglite';
import type { Pool } from 'pg';
import type { AuthService } from '../src/auth.js';
import type { AgentHub } from '../src/agent.js';
import type { Config } from '../src/config.js';
import { migrate } from '../src/db.js';
import { ApiError } from '../src/http-common.js';
import { createServerContext } from '../src/server-context.js';
import { registerAdminRoutes } from '../src/routes/admin-routes.js';

const ADMIN = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const SYSTEM = '33333333-3333-4333-8333-333333333333';

test('sidebar counts respect ownership, hide admin totals, include disabled records and exceed the session list limit', async () => {
  const db = new PGlite();
  let server: ReturnType<typeof createServer> | undefined;
  try {
    const query = async (sql: string, values?: unknown[]) => {
      const result = values === undefined ? (await db.exec(sql)).at(-1) : await db.query(sql, values);
      return { ...result, rowCount: result?.rows?.length || result?.affectedRows || 0 };
    };
    const pool = { query, connect: async () => ({ query, release() {} }) } as unknown as Pool;
    await migrate(pool);
    for (const [id, provider, role] of [[ADMIN, 'local', 'admin'], [USER, 'ldap', 'user'], [SYSTEM, 'system', 'admin']]) {
      await db.query("INSERT INTO users(id,provider,subject,username,display_name,role) VALUES($1::uuid,$2,$1::text,$1::text,$1::text,$3)", [id, provider, role]);
    }
    await db.query('DELETE FROM profiles');
    for (const [id, enabled, removed] of [['enabled', true, false], ['disabled', false, false], ['removed', false, true], ['device-phone', true, false]]) {
      await db.query("INSERT INTO profiles(id,name,android_version,image,cpu,memory_mb,disk_gb,enabled,removed_at) VALUES($1,$1,'11','registry/image',2,4096,16,$2,CASE WHEN $3 THEN now() ELSE NULL END)", [id, enabled, removed]);
    }
    await db.query("INSERT INTO hosts(id,name,status,disabled,removed_at) VALUES('online','online','online',false,NULL),('paused','paused','online',true,NULL),('offline','offline','offline',false,NULL),('removed','removed','offline',true,now())");
    for (const [owner, state] of [[ADMIN, 'starting'], [ADMIN, 'running'], [ADMIN, 'stopping'], [ADMIN, 'stopped'], [ADMIN, 'failed'], [USER, 'running']]) {
      await db.query("INSERT INTO sessions(id,owner_user_id,host_id,profile_id,state) VALUES($1,$2,'online','enabled',$3)", [randomUUID(), owner, state]);
    }
    // The session endpoint is capped at 500; totals must count every active session.
    await db.query("INSERT INTO sessions(id,owner_user_id,host_id,profile_id,state) SELECT ('aaaaaaaa-aaaa-4aaa-8aaa-' || lpad(i::text,12,'0'))::uuid,$1,'online','enabled','running' FROM generate_series(1,501) AS i", [USER]);
    for (const [owner, kind, expired] of [[ADMIN, 'personal', true], [USER, 'personal', false], [null, 'system', false]]) {
      await db.query("INSERT INTO api_tokens(id,owner_user_id,kind,name,token_hash,expires_at) VALUES($1,$2,$3,'token',$4,CASE WHEN $5 THEN now()-interval '1 day' ELSE NULL END)", [randomUUID(), owner, kind, randomUUID(), expired]);
    }
    let actor: string | null = ADMIN;
    const auth = { authenticate: async () => actor ? { user: { id: actor, username: actor, role: actor === ADMIN ? 'admin' : 'user' }, via: 'cookie' } : null } as unknown as AuthService;
    const app = express();
    registerAdminRoutes(app, createServerContext(pool, {} as Config, auth, undefined, {} as AgentHub));
    app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      if (!(error instanceof ApiError)) console.error(error);
      res.status(error instanceof ApiError ? error.status : 500).json({ error: 'request_failed' });
    });
    server = createServer(app); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const request = () => fetch(`http://127.0.0.1:${address.port}/api/navigation-counts`);
    assert.deepEqual(await (await request()).json(), { counts: { sessions: 3, allSessions: 505, nodes: 3, profiles: 2, users: 2, tokens: 2 } });
    actor = USER;
    assert.deepEqual(await (await request()).json(), { counts: { sessions: 502, tokens: 1 } });
    await db.query("DELETE FROM sessions WHERE owner_user_id=$1", [USER]);
    await db.query("DELETE FROM api_tokens WHERE owner_user_id=$1", [USER]);
    assert.deepEqual(await (await request()).json(), { counts: { sessions: 0, tokens: 0 } });
    actor = null; assert.equal((await request()).status, 401);
  } finally {
    if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())); }
    await db.close();
  }
});
