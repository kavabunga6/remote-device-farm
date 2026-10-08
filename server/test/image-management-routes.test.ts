import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import express from 'express';
import { PGlite } from '@electric-sql/pglite';
import type { Pool } from 'pg';
import { migrate } from '../src/db.js';
import { AuthService, newToken, tokenHash } from '../src/auth.js';
import type { Config } from '../src/config.js';
import type { AgentHub } from '../src/agent.js';
import { createServerContext } from '../src/server-context.js';
import { ApiError } from '../src/http-common.js';
import { registerImageManagementRoutes } from '../src/routes/image-management-routes.js';
import type { ImageManagement } from '../src/image-management.js';
import { defaultPolicy } from '../src/image-retention.js';

test('image management API enforces independent view, node, settings, cleanup and delete grants', async () => {
  const db = new PGlite();
  const query = async (sql: string, params?: unknown[]) => {
    const result = params === undefined ? (await db.exec(sql)).at(-1)! : await db.query(sql, params);
    return { ...result, rowCount: result.rows.length || result.affectedRows || 0 };
  };
  const pool = { query, connect: async () => ({ query, release() { } }) } as unknown as Pool;
  const config = { authMode: 'local', localAdminUsername: 'root', localAdminPassword: 'initial-password-123', adminSubjects: new Set(), secureCookies: false, maxSessionsPerUser: 3 } as Config;
  let server: ReturnType<typeof createServer> | undefined;
  try {
    await migrate(pool);
    const auth = new AuthService(pool, config); await auth.bootstrap();
    const uid = randomUUID(), role = randomUUID();
    await query("INSERT INTO access_roles(id,name,permissions) VALUES($1,'Image reader',ARRAY['images.view'])", [role]);
    await query("INSERT INTO users(id,provider,subject,username,display_name,access_role_id) VALUES($1,'local','reader','reader','Reader',$2)", [uid, role]);
    const cookie = async (id: string) => { const raw = newToken(); await query("INSERT INTO browser_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,now()+interval '1 day')", [randomUUID(), id, tokenHash(raw)]); return 'rdf_session=' + raw; };
    const credential = await cookie(uid);
    const calls: string[] = [];
    const manager = {
      registryImages: async () => ({ supported: true, repository: 'registry/rdf-emulator', items: [], maintenance: false }),
      cache: async () => { calls.push('cache'); return { hostId: 'node', items: [] }; },
      policy: async () => defaultPolicy, savePolicy: async () => { calls.push('save'); return defaultPolicy; }, jobs: async () => [],
      preview: async () => { calls.push('preview'); return { scope: 'cache', action: 'retention', items: [], token: 'test', blocked: false }; },
      enqueue: async () => { calls.push('enqueue'); return { id: randomUUID(), state: 'queued' }; }
    } as unknown as ImageManagement;
    const app = express(); app.use(express.json());
    registerImageManagementRoutes(app, createServerContext(pool, config, auth, undefined, {} as AgentHub), manager);
    app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(error instanceof ApiError ? error.status : 500).json({ code: error instanceof ApiError ? error.code : 'internal' });
    });
    server = createServer(app); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const request = (path: string, method = 'GET', body?: unknown, session = credential) => fetch('http://127.0.0.1:' + address.port + '/api/admin/image-management' + path, { method, headers: { Cookie: session, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    assert.equal((await request('/registry', 'GET', undefined, '')).status, 401);
    for (const path of ['/registry', '/policy', '/jobs']) assert.equal((await request(path)).status, 200);
    assert.equal((await request('/cache/node')).status, 403);
    assert.equal((await request('/preview', 'POST', { scope: 'cache', action: 'retention', hostId: 'node' })).status, 403);
    assert.equal((await request('/preview', 'POST', { scope: 'registry', action: 'retention' })).status, 200);
    assert.equal((await request('/jobs', 'POST', { scope: 'registry', action: 'delete' })).status, 403);
    assert.equal((await request('/policy', 'PUT', defaultPolicy)).status, 403);
    assert.equal(calls.includes('cache'), false);
    assert.equal(calls.includes('enqueue'), false);
    const grant = async (permissions: string[]) => query('UPDATE access_roles SET permissions=$2 WHERE id=$1', [role, permissions]);
    await grant(['images.view', 'nodes.view', 'images.cleanup']);
    assert.equal((await request('/cache/node')).status, 200);
    assert.equal((await request('/jobs', 'POST', { scope: 'cache', action: 'retention', hostId: 'node', token: 'test' })).status, 202);
    assert.equal((await request('/jobs', 'POST', { scope: 'registry', action: 'delete' })).status, 403);
    assert.equal((await request('/policy', 'PUT', defaultPolicy)).status, 403);
    await grant(['images.view', 'images.settings']);
    assert.equal((await request('/policy', 'PUT', defaultPolicy)).status, 200);
    assert.equal((await request('/policy', 'PUT', { ...defaultPolicy, cacheEnabled: true })).status, 403);
    await grant(['images.view', 'profiles.view', 'profiles.manage', 'images.delete']);
    assert.equal((await request('/jobs', 'POST', { scope: 'registry', action: 'delete', token: 'test' })).status, 202);
    assert.equal((await request('/jobs', 'POST', { scope: 'registry', action: 'gc' })).status, 403);
    assert.equal((await request('/preview', 'POST', { scope: 'registry', action: 'delete', force: true })).status, 400);
    assert.equal((await request('/preview', 'POST', [])).status, 400);
  } finally { if (server) await new Promise<void>(resolve => server!.close(() => resolve())); await db.close(); }
});
