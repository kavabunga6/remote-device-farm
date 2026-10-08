import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import express from 'express';
import { PGlite } from '@electric-sql/pglite';
import type { Pool } from 'pg';
import { loadConfig } from '../src/config.js';
import type { AuthService } from '../src/auth.js';
import type { AgentHub } from '../src/agent.js';
import { ApiError } from '../src/http-common.js';
import { createServerContext } from '../src/server-context.js';
import { registerOpsRoutes } from '../src/routes/ops-routes.js';
import { computeSummary, sampleOnce } from '../src/ops-samples.js';
import { resetHttpCounters } from '../src/metrics.js';

const MIGRATIONS = ['001_init', '002_gpu_mode', '003_default_profile_resources', '004_guest_resources', '005_host_settings',
  '006_adb_port_access', '008_user_adb_keys', '009_uploaded_adb_public_keys', '010_user_settings_audit', '011_node_management',
  '012_session_lifecycle', '017_ops_metrics'];
const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const ROOT = '44444444-4444-4444-8444-444444444444';
const sid = (n: number) => `a0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

async function seed(): Promise<PGlite> {
  const db = new PGlite();
  for (const file of MIGRATIONS) await db.exec(await readFile(new URL(`../migrations/${file}.sql`, import.meta.url), 'utf8'));
  await db.query("INSERT INTO users(id,provider,subject,username,display_name) VALUES($1,'local','a','alice','Alice'),($2,'local','b','bob','Bob')", [ALICE, BOB]);
  await db.query("INSERT INTO users(id,provider,subject,username,display_name,role) VALUES($1,'local','r','root','Root','admin')", [ROOT]);
  await db.query("INSERT INTO hosts(id,name,slots,status,last_seen_at) VALUES('host-1','Host 1',2,'online',now()),('host-2','Host 2',1,'offline',NULL)");
  await db.query("INSERT INTO host_slots(host_id,slot_index) VALUES('host-1',0),('host-1',1),('host-2',0)");
  return db;
}

// Creates a finished rental `daysAgo` UTC days back, starting at `hour` and lasting `minutes`.
async function rental(db: PGlite, n: number, owner: string, daysAgo: number, minutes: number, finalState = 'stopped', hour = 12): Promise<void> {
  await db.query("INSERT INTO sessions(id,owner_user_id,host_id,profile_id,state) VALUES($1,$2,'host-1','android-30','running')", [sid(n), owner]);
  await db.query('DELETE FROM sessions WHERE id=$1', [sid(n)]);
  await db.query(`UPDATE rental_history SET
      created_at=date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' - make_interval(days => $2) + make_interval(hours => $3),
      started_at=NULL,
      ended_at=date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' - make_interval(days => $2) + make_interval(hours => $3, mins => $4),
      final_state=$5 WHERE session_id=$1`, [sid(n), daysAgo, hour, minutes, finalState]);
}

test('summary computes durations, per-day counts, peak hour, top users and failures', async () => {
  const db = await seed();
  try {
    await rental(db, 1, ALICE, 1, 30, 'stopped', 10);
    await rental(db, 2, ALICE, 1, 90, 'stopped', 10);
    await rental(db, 3, BOB, 3, 10, 'failed', 10);
    await rental(db, 4, BOB, 20, 500, 'stopped');
    const pool = { query: db.query.bind(db) } as unknown as Pool;
    const s = await computeSummary(pool);
    assert.equal(s.sessionsPerDay.length, 14);
    assert.equal(s.sessionsPerDay[13]!.count, 0);
    assert.equal(s.sessionsPerDay[12]!.count, 2);
    assert.equal(s.sessionsPerDay[10]!.count, 1);
    assert.equal(s.duration.count, 3);
    assert.equal(s.duration.avgSeconds, Math.round((30 + 90 + 10) * 60 / 3));
    assert.ok(s.duration.p90Seconds! > 60 * 30 && s.duration.p90Seconds! <= 90 * 60);
    assert.equal(s.peakHourUtc, 10);
    assert.deepEqual(s.topUsers.map(u => [u.username, u.sessions, u.minutes]), [['alice', 2, 120], ['bob', 1, 10]]);
    assert.equal(s.failures.last14d, 1);
    assert.equal(s.failures.last24h, 0);
    assert.equal(s.utilization24h.series.length, 0);
  } finally { await db.close(); }
});

test('an empty database yields an empty but well-formed summary', async () => {
  const db = await seed();
  try {
    const s = await computeSummary({ query: db.query.bind(db) } as unknown as Pool);
    assert.equal(s.peakHourUtc, null);
    assert.equal(s.duration.avgSeconds, null);
    assert.deepEqual(s.topUsers, []);
    assert.equal(s.sessionsPerDay.every(d => d.count === 0), true);
  } finally { await db.close(); }
});

test('samples record slot usage, downsample into buckets and expire after 14 days', async () => {
  const db = await seed();
  try {
    const pool = { query: db.query.bind(db) } as unknown as Pool;
    const now = new Date();
    await db.query("INSERT INTO sessions(id,owner_user_id,host_id,profile_id,state) VALUES($1,$2,'host-1','android-30','running')", [sid(9), ALICE]);
    await db.query("UPDATE host_slots SET session_id=$1 WHERE host_id='host-1' AND slot_index=0", [sid(9)]);
    await sampleOnce(pool, new Date(now.getTime() - 15 * 86_400_000));
    await sampleOnce(pool, new Date(now.getTime() - 20 * 60_000));
    await sampleOnce(pool, now);
    const rows = (await db.query('SELECT host_id,used,total FROM ops_samples ORDER BY at,host_id')).rows;
    assert.equal(rows.length, 4, 'the 15-day-old sample was pruned by the later runs');
    assert.deepEqual(rows[0], { host_id: 'host-1', used: 1, total: 2 });
    const s = await computeSummary(pool, new Date(now.getTime() + 1000));
    const h1 = s.utilization24h.series.find(item => item.hostId === 'host-1')!;
    assert.ok(h1.points.length >= 1 && h1.points.length <= 2);
    assert.equal(h1.points[0]!.used, 1);
    assert.equal(s.utilization14d.series.length, 2);
    assert.equal(s.sampleCount, 4);
  } finally { await db.close(); }
});

test('GET /metrics is hidden without a token and needs the bearer token; summary is admin only', async () => {
  const db = await seed();
  resetHttpCounters();
  let actor = ROOT;
  const servers: Array<ReturnType<typeof createServer>> = [];
  const start = async (metricsToken?: string) => {
    const pool = { query: db.query.bind(db) } as unknown as Pool;
    const auth = { authenticate: async () => ({ user: actor === ROOT
      ? { id: ROOT, username: 'root', displayName: 'Root', role: 'admin', provider: 'local' }
      : { id: ALICE, username: 'alice', displayName: 'Alice', role: 'user', provider: 'local' }, via: 'cookie' }) } as unknown as AuthService;
    const config = { ...loadConfig({ DATABASE_URL: 'postgres://x', AGENT_TOKEN: 'a'.repeat(32), BOOTSTRAP_AGENT_ID: 'agent-1',
      LOCAL_ADMIN_USERNAME: 'admin', LOCAL_ADMIN_PASSWORD: 'p'.repeat(12), OPS_SAMPLE_SECONDS: '0' }), metricsToken };
    const context = createServerContext(pool, config, auth, undefined, {} as AgentHub);
    const app = express();
    registerOpsRoutes(app, context);
    app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      if (error instanceof ApiError) res.status(error.status).json({ error: { code: error.code, message: error.message } });
      else { console.error(error); res.status(500).json({ error: { code: 'internal_error' } }); }
    });
    const server = createServer(app);
    servers.push(server);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    return 'http://127.0.0.1:' + address.port;
  };
  try {
    const off = await start();
    assert.equal((await fetch(off + '/metrics', { headers: { Authorization: 'Bearer anything-anything' } })).status, 404);
    const base = await start('metrics-token-123456');
    assert.equal((await fetch(base + '/metrics')).status, 401);
    assert.equal((await fetch(base + '/metrics', { headers: { Authorization: 'Bearer wrong-token-1234567' } })).status, 401);
    const ok = await fetch(base + '/metrics', { headers: { Authorization: 'Bearer metrics-token-123456' } });
    assert.equal(ok.status, 200);
    assert.match(ok.headers.get('content-type') ?? '', /^text\/plain.*version=0\.0\.4/);
    const text = await ok.text();
    assert.match(text, /^rdf_sessions\{state="running"\} 0$/m);
    assert.match(text, /^rdf_hosts_online 1$/m);
    assert.match(text, /^rdf_hosts_total 2$/m);
    assert.match(text, /^rdf_slots_total\{host="host-1"\} 2$/m);
    assert.match(text, /^rdf_agent_last_seen_seconds\{host="host-1"\} \d+$/m);
    assert.doesNotMatch(text, /rdf_agent_last_seen_seconds\{host="host-2"\}/);
    assert.match(text, /^rdf_session_duration_seconds_count 0$/m);
    const summary = await fetch(base + '/api/admin/ops/summary');
    assert.equal(summary.status, 200);
    assert.equal(((await summary.json()) as { sessionsPerDay: unknown[] }).sessionsPerDay.length, 14);
    actor = ALICE;
    assert.equal((await fetch(base + '/api/admin/ops/summary')).status, 403);
  } finally {
    for (const server of servers) await new Promise<void>(resolve => server.close(() => resolve()));
    await db.close();
  }
});
