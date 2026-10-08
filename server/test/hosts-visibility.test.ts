import assert from 'node:assert/strict';
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

const OWNER = '11111111-1111-4111-8111-111111111111';
const ADMIN = '33333333-3333-4333-8333-333333333333';
async function fixture() {
  const db = new PGlite();
  const query = async (sql: string, values?: unknown[]) => {
    const result = values === undefined ? (await db.exec(sql)).at(-1) : await db.query(sql, values);
    return { ...result, rowCount: result?.rows?.length || result?.affectedRows || 0 };
  };
  const pool = { query, connect: async () => ({ query, release() {} }) } as unknown as Pool;
  await migrate(pool);
  for (const [id, role] of [[OWNER, 'user'], [ADMIN, 'admin']]) {
    await db.query("INSERT INTO users(id,provider,subject,username,display_name,role) VALUES($1::uuid,'local',$1::text,$1::text,$1::text,$2)", [id, role]);
  }
  let actor: string | null = OWNER;
  const auth = { authenticate: async () => actor ? { user: { id: actor, role: actor === ADMIN ? 'admin' : 'user' }, via: 'cookie' } : null } as unknown as AuthService;
  const context = createServerContext(pool, {} as Config, auth, undefined, {} as AgentHub);
  const app = express(); app.use(express.json()); registerAdminRoutes(app, context);
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (error instanceof SyntaxError && (error as { type?: string }).type === 'entity.parse.failed') { res.status(400).json({ error: { code: 'invalid_json' } }); return; }
    res.status(error instanceof ApiError ? error.status : 500).json({ error: { code: error instanceof ApiError ? error.code : 'internal_error' } });
  });
  const server = createServer(app); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const request = () => fetch(`http://127.0.0.1:${address.port}/api/hosts`);
  const close = async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await db.close(); };
  return { db, request, close, actor: (id: string | null) => { actor = id; } };
}

test('hosts hide addresses, hardware and telemetry from non-administrators', async () => {
  const f = await fixture();
  try {
    await f.db.query(`INSERT INTO hosts(id,name,status,slots,metrics,last_seen_at) VALUES('h1','worker-01','online',2,$1::jsonb,now())`,
      [JSON.stringify({ hostIp: '192.0.2.20', cpuModel: 'Example CPU', memoryTotalMb: 65536, diskTotalGb: 1024, gpuModel: 'Example GPU', architecture: 'x86_64', gpuCapabilities: ['cuda'], nvidiaGpuAvailable: true })]);
    await f.db.query(`INSERT INTO hosts(id,name,status,slots,metrics,last_seen_at) VALUES('h2','sleepy','offline',1,'{}'::jsonb,now())`);
    f.actor(OWNER);
    const listed = (await (await f.request()).json() as { hosts: unknown[] }).hosts;
    assert.equal(listed.length, 1);
    const user = (await (await f.request()).json() as { hosts: Array<Record<string, unknown>> }).hosts[0]!;
    assert.deepEqual(user.metrics, { architecture: 'x86_64', gpuCapabilities: ['cuda'], nvidiaGpuAvailable: true, driGpuAvailable: false });
    assert.ok(!JSON.stringify(user).includes('192.0.2.20') && !JSON.stringify(user).includes('Example CPU'));
    f.actor(ADMIN);
    const admin = (await (await f.request()).json() as { hosts: Array<{ id: string; metrics: Record<string, unknown> }> }).hosts.find(host => host.id === 'h1')!;
    assert.equal(admin.metrics.hostIp, '192.0.2.20');
    assert.equal((await (await f.request()).json() as { hosts: unknown[] }).hosts.length, 2);
  } finally { await f.close(); }
});
