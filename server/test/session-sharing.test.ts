import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import express from 'express';
import WebSocket from 'ws';
import { PGlite } from '@electric-sql/pglite';
import type { Pool } from 'pg';
import type { Config } from '../src/config.js';
import { tokenHash, type AuthService } from '../src/auth.js';
import type { AgentHub } from '../src/agent.js';
import type { AdbPortBroker } from '../src/adb-port.js';
import { ApiError } from '../src/http-common.js';
import { createServerContext } from '../src/server-context.js';
import { registerSessionRoutes } from '../src/routes/session-routes.js';
import { registerShareRoutes, parseShareRequest, MAX_ACTIVE_SHARES } from '../src/routes/share-routes.js';
import { registerAdbPortRoutes } from '../src/routes/adb-port-routes.js';
import { attachWebSocket } from '../src/websocket.js';
import { classifyStreamMessage, resetSharedAccessAudit } from '../src/session-access.js';

const MIGRATIONS = ['001_init', '002_gpu_mode', '003_default_profile_resources', '004_guest_resources', '005_host_settings',
  '006_adb_port_access', '008_user_adb_keys', '009_uploaded_adb_public_keys', '010_user_settings_audit', '011_node_management',
  '012_session_lifecycle', '014_session_sharing', '048_user_removal', '049_access_roles'];

const OWNER = '11111111-1111-4111-8111-111111111111';
const FRIEND = '22222222-2222-4222-8222-222222222222';
const FRIEND2 = '33333333-3333-4333-8333-333333333333';
const STRANGER = '55555555-5555-4555-8555-555555555555';
const ADMIN = '44444444-4444-4444-8444-444444444444';
const SID = 'a0000000-0000-4000-8000-000000000001';
const NAMES: Record<string, [string, string]> = {
  [OWNER]: ['owner', 'user'], [FRIEND]: ['friend', 'user'], [FRIEND2]: ['friend2', 'user'],
  [STRANGER]: ['stranger', 'user'], [ADMIN]: ['root', 'admin'],
};

async function harness() {
  resetSharedAccessAudit();
  const db = new PGlite();
  for (const file of MIGRATIONS) await db.exec(await readFile(new URL(`../migrations/${file}.sql`, import.meta.url), 'utf8'));
  for (const [id, [name, role]] of Object.entries(NAMES)) {
    await db.query('INSERT INTO users(id,provider,subject,username,display_name,role) VALUES($1,$2,$3,$3,$4,$5)', [id, 'local', name, name[0]!.toUpperCase() + name.slice(1), role]);
  }
  await db.query("INSERT INTO hosts(id,name,slots,status,manual_slots,last_seen_at) VALUES('host-1','Host',4,'online',4,now())");
  await db.query("INSERT INTO sessions(id,owner_user_id,host_id,profile_id,state,adb_key_id) VALUES($1,$2,'host-1','android-30','running',NULL)", [SID, OWNER]);
  const state: { actor: string; onHasAgent?: () => void; onScreenshot?: () => Promise<void> } = { actor: OWNER };
  const commands: Array<{ action: string; params: unknown }> = [];
  const client = { query: db.query.bind(db), release: () => {} };
  const pool = { query: db.query.bind(db), connect: async () => client } as unknown as Pool;
  const auth = { authenticate: async (req: { headers: Record<string, string | string[] | undefined> }) => {
    const actor = String(req.headers['x-test-actor'] || state.actor);
    const [username, role] = NAMES[actor]!;
    return { user: { id: actor, username, displayName: username, role, provider: 'local' }, via: 'cookie' };
  } } as unknown as AuthService;
  const closedListeners: Array<(id: string) => void> = [];
  const viewers: string[] = [];
  const hub = {
    hasAgent: (hostId: string) => { const hook = state.onHasAgent; state.onHasAgent = undefined; hook?.(); return hostId === 'host-1'; },
    openInput: async () => ({ inputEpoch: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', serverTime: Date.now(), inputMaxAgeMs: 1500 }),
    input: async (_sessionId: string, hostId: string, _socket: unknown, _message: unknown, params: unknown) => { assert.equal(hostId, 'host-1'); commands.push({ action: 'input', params }); return {}; },
    setViewerTransport: () => {},
    addViewer: (_sessionId: string, hostId: string) => { assert.equal(hostId, 'host-1'); viewers.push(hostId); },
    requestKeyframe: (_sessionId: string, hostId: string) => { assert.equal(hostId, 'host-1'); return true; },
    onSessionClosed: (listener: (id: string) => void) => { closedListeners.push(listener); },
    command: async (hostId: string, _id: string, action: string, params: unknown) => { assert.equal(hostId, 'host-1'); commands.push({ action, params });
      if (action === 'screenshot') {
        await state.onScreenshot?.();
        return { mime: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlS8AAAAASUVORK5CYII=' };
      }
      return {};
    },
  } as unknown as AgentHub;
  const config = { maxSessionsPerUser: 5, idleTimeoutMinutes: 0, maxSessionHours: 0, allowedOrigins: new Set<string>(), authMode: 'local' } as unknown as Config;
  const context = createServerContext(pool, config, auth, undefined, hub);
  const app = express();
  app.use(express.json());
  registerSessionRoutes(app, context);
  registerShareRoutes(app, context);
  registerAdbPortRoutes(app, context, {} as AdbPortBroker);
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (error instanceof ApiError) res.status(error.status).json({ error: { code: error.code, message: error.message } });
    else { console.error(error); res.status(500).json({ error: { code: 'internal_error' } }); }
  });
  const server = createServer(app);
  attachWebSocket(server, context);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const port = address.port;
  const send = (path: string, method = 'GET', body?: unknown, actor?: string) => fetch(`http://127.0.0.1:${port}${path}`, {
    method, headers: { 'Content-Type': 'application/json', ...(actor ? { 'X-Test-Actor': actor } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const share = async (mode = 'view', ttlMinutes = 60, maxRecipients = 1) => {
    const response = await send(`/api/sessions/${SID}/shares`, 'POST', { mode, ttlMinutes, maxRecipients });
    return { status: response.status, body: await response.json() as { token: string; share: { id: string; expiresAt: string; maxRecipients: number; recipientsUsed: number } } };
  };
  const redeem = async (token: string) => {
    const response = await send('/api/shares/redeem', 'POST', { token });
    return { status: response.status, body: await response.json() as { sessionId?: string; access?: string; error?: { code: string } } };
  };
  const close = async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await db.close();
  };
  return { db, state, send, share, redeem, close, commands, viewers, port, closedListeners, app };
}

const audits = async (db: PGlite) => (await db.query('SELECT action,actor_user_id FROM audit_events ORDER BY id')).rows as Array<{ action: string; actor_user_id: string }>;
const settle = () => new Promise(resolve => setTimeout(resolve, 80));

test('share requests are validated and tokens are stored only as hashes', async () => {
  assert.deepEqual(parseShareRequest({ mode: 'view' }), { mode: 'view', ttlMinutes: 60, maxRecipients: 1 });
  assert.throws(() => parseShareRequest({ mode: 'admin' }));
  assert.throws(() => parseShareRequest({ mode: 'view', ttlMinutes: 0 }));
  assert.throws(() => parseShareRequest({ mode: 'view', ttlMinutes: 481 }));
  assert.throws(() => parseShareRequest({ mode: 'view', ttlMinutes: '5' }));
  assert.throws(() => parseShareRequest({ mode: 'view', maxRecipients: 0 }));
  assert.throws(() => parseShareRequest({ mode: 'view', maxRecipients: 11 }));
  const h = await harness();
  try {
    const { status, body } = await h.share('control', 30);
    assert.equal(status, 201);
    assert.match(body.token, /^rdfs_/);
    const rows = (await h.db.query('SELECT token_hash,mode FROM session_shares')).rows as Array<{ token_hash: string; mode: string }>;
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.token_hash, tokenHash(body.token));
    assert.notEqual(rows[0]!.token_hash, body.token);
    assert.ok(!JSON.stringify((await h.db.query('SELECT * FROM session_shares')).rows).includes(body.token));
    const list = await (await h.send(`/api/sessions/${SID}/shares`)).json();
    assert.ok(!JSON.stringify(list).includes(body.token), 'listing never reveals the token');
  } finally { await h.close(); }
});

test('only five shares may be active and expired or revoked ones free a place', async () => {
  const h = await harness();
  try {
    const created = [];
    for (let i = 0; i < MAX_ACTIVE_SHARES; i++) created.push(await h.share());
    assert.ok(created.every(item => item.status === 201));
    assert.equal((await h.share()).status, 409);
    await h.db.query('UPDATE session_shares SET expires_at=now() - interval \'1 minute\' WHERE id=$1', [created[0]!.body.share.id]);
    assert.equal((await h.share()).status, 201);
    assert.equal((await h.send(`/api/sessions/${SID}/shares/${created[1]!.body.share.id}`, 'DELETE')).status, 200);
    assert.equal((await h.share()).status, 201);
  } finally { await h.close(); }
});

test('redeem: generic errors, expiry, one account per link, owner and revoke', async () => {
  const h = await harness();
  try {
    const { body } = await h.share('view', 10);
    h.state.actor = FRIEND;
    const unknown = await h.redeem('rdfs_' + 'A'.repeat(43));
    const malformed = await h.redeem('nope');
    assert.deepEqual([unknown.status, malformed.status], [404, 404]);
    assert.equal(unknown.body.error?.code, 'share_invalid');
    assert.equal(malformed.body.error?.code, 'share_invalid');

    const first = await h.redeem(body.token);
    assert.deepEqual([first.status, first.body.access, first.body.sessionId], [200, 'view', SID]);
    const again = await h.redeem(body.token);
    assert.equal(again.status, 200);
    assert.equal((await h.db.query('SELECT 1 FROM session_share_grants')).rows.length, 1, 'repeat redeem makes no second grant');
    h.state.actor = FRIEND2;
    assert.equal((await h.redeem(body.token)).status, 404, 'another account cannot reuse the link');
    h.state.actor = OWNER;
    assert.equal((await h.redeem(body.token)).body.access, 'owner');
    assert.equal((await h.db.query('SELECT 1 FROM session_share_grants')).rows.length, 1);
    const grant = (await h.db.query('SELECT g.expires_at,s.expires_at AS share_expiry FROM session_share_grants g JOIN session_shares s ON s.id=g.share_id')).rows[0] as { expires_at: string; share_expiry: string };
    assert.ok(new Date(grant.expires_at).getTime() <= new Date(grant.share_expiry).getTime());

    await h.db.query("UPDATE session_shares SET expires_at=now() - interval '1 second'");
    h.state.actor = STRANGER;
    const expired = await h.redeem(body.token);
    assert.equal(expired.body.error?.code, 'share_invalid');
    assert.equal(JSON.stringify(expired.body), JSON.stringify(unknown.body), 'expired and unknown look identical');
  } finally { await h.close(); }
});

test('parallel redeemers cannot claim the same one-time link', async () => {
  const h = await harness();
  try {
    const { body } = await h.share('view');
    const [first, second] = await Promise.all([
      h.send('/api/shares/redeem', 'POST', { token: body.token }, FRIEND),
      h.send('/api/shares/redeem', 'POST', { token: body.token }, FRIEND2),
    ]);
    assert.deepEqual([first.status, second.status].sort(), [200, 404]);
    const grants = (await h.db.query('SELECT user_id FROM session_share_grants')).rows;
    assert.equal(grants.length, 1);
    const winner = String(grants[0]!.user_id);
    assert.ok(winner === FRIEND || winner === FRIEND2);
    const retry = await h.send('/api/shares/redeem', 'POST', { token: body.token }, winner);
    assert.equal(retry.status, 200, 'the first account can reopen its own link');
    const loser = winner === FRIEND ? FRIEND2 : FRIEND;
    const denied = await h.send('/api/shares/redeem', 'POST', { token: body.token }, loser);
    assert.equal(denied.status, 404);
    const unknown = await h.send('/api/shares/redeem', 'POST', { token: 'rdfs_' + 'A'.repeat(43) }, loser);
    assert.equal(await denied.text(), await unknown.text(), 'used and unknown links answer identically');
  } finally { await h.close(); }
});

test('multiple-recipient links cap distinct accounts, including concurrent last-place claims', async () => {
  const h = await harness();
  try {
    const { status, body } = await h.share('control', 60, 2);
    assert.equal(status, 201);
    assert.deepEqual([body.share.maxRecipients, body.share.recipientsUsed], [2, 0]);
    assert.equal((await h.send('/api/shares/redeem', 'POST', { token: body.token }, FRIEND)).status, 200);
    const [second, third] = await Promise.all([
      h.send('/api/shares/redeem', 'POST', { token: body.token }, FRIEND2),
      h.send('/api/shares/redeem', 'POST', { token: body.token }, STRANGER),
    ]);
    assert.deepEqual([second.status, third.status].sort(), [200, 404]);
    const winner = second.status === 200 ? FRIEND2 : STRANGER;
    const loser = winner === FRIEND2 ? STRANGER : FRIEND2;
    assert.equal((await h.send('/api/shares/redeem', 'POST', { token: body.token }, winner)).status, 200);
    assert.equal((await h.send('/api/shares/redeem', 'POST', { token: body.token }, loser)).status, 404);
    h.state.actor = OWNER;
    let list = await (await h.send(`/api/sessions/${SID}/shares`)).json() as {
      shares: Array<{ id: string; maxRecipients: number; recipientsUsed: number; redeemers: Array<{ grantId: string }> }>;
    };
    const share = list.shares.find(item => item.id === body.share.id)!;
    assert.deepEqual([share.maxRecipients, share.recipientsUsed, share.redeemers.length], [2, 2, 2]);
    await h.send(`/api/sessions/${SID}/shares/${body.share.id}/grants/${share.redeemers[0]!.grantId}`, 'DELETE');
    list = await (await h.send(`/api/sessions/${SID}/shares`)).json() as typeof list;
    assert.equal(list.shares[0]!.recipientsUsed, 2, 'revocation cannot recycle an already-shared link');
    assert.equal((await h.send('/api/shares/redeem', 'POST', { token: body.token }, loser)).status, 404);
  } finally { await h.close(); }
});

test('rate limit on redeem answers 429 after ten attempts a minute', async () => {
  const h = await harness();
  try {
    h.state.actor = STRANGER;
    let last = 0;
    for (let i = 0; i < 11; i++) last = (await h.redeem('rdfs_' + 'B'.repeat(43))).status;
    assert.equal(last, 429);
  } finally { await h.close(); }
});

test('every session route answers a grant holder 404 except the stream, read, screenshot and input', async () => {
  const h = await harness();
  try {
    const { body } = await h.share('control');
    const shareId = body.share.id;
    h.state.actor = FRIEND;
    await h.redeem(body.token);
    const grantId = String((await h.db.query('SELECT id FROM session_share_grants')).rows[0]!.id);

    type Layer = { route?: { path: string; methods: Record<string, boolean> } };
    const stack = (h.app as unknown as { _router: { stack: Layer[] } })._router.stack;
    const routes = stack.filter(layer => layer.route).flatMap(layer =>
      Object.keys(layer.route!.methods).map(method => ({ method: method.toUpperCase(), path: layer.route!.path })));
    const scoped = routes.filter(route => route.path.startsWith('/api/sessions/:id'));
    assert.ok(scoped.length >= 20, 'found ' + scoped.length);
    const fill = (path: string) => path.replace(':id', SID).replace(':shareId', shareId).replace(':grantId', grantId);
    const allowed = new Set(['GET /api/sessions/:id', 'GET /api/sessions/:id/screenshot', 'POST /api/sessions/:id/input']);
    const denied = (route: { path: string }) => route.path.endsWith('/kill') ? 403 : 404; // the admin-only gate answers first
    for (const route of scoped) {
      const key = route.method + ' ' + route.path;
      const probe = route.path.endsWith('/input') ? { kind: 'key', keyCode: 4 } : route.method === 'GET' ? undefined : {};
      for (const [who, expected] of [[STRANGER, denied(route)], [FRIEND, allowed.has(key) ? 200 : denied(route)]] as const) {
        h.state.actor = who;
        const response = await h.send(fill(route.path), route.method, probe);
        assert.equal(response.status, expected, `${who === FRIEND ? 'grant holder' : 'stranger'} ${key} answered ${response.status}`);
      }
      // The admin keeps existing rights; share management stays owner-only.
      if (route.path.includes('/shares')) {
        h.state.actor = ADMIN;
        assert.equal((await h.send(fill(route.path), route.method, route.method === 'POST' ? { mode: 'view' } : undefined)).status, 403, key);
      }
    }
    // Revoke through the API must still be available to the owner after all those probes.
    h.state.actor = OWNER;
    assert.equal((await h.send(`/api/sessions/${SID}/shares/${shareId}`, 'DELETE')).status, 200);
  } finally { await h.close(); }
});

test('the session JSON hides owner data from grant holders and lists keep the session private', async () => {
  const h = await harness();
  try {
    await h.db.query("UPDATE sessions SET container_id='abc123'");
    const { body } = await h.share('view');
    h.state.actor = OWNER;
    const own = await (await h.send(`/api/sessions/${SID}`)).json() as { session: Record<string, unknown> };
    assert.equal(own.session.access, 'owner');
    assert.equal(own.session.containerId, 'abc123');
    h.state.actor = ADMIN;
    assert.equal(((await (await h.send(`/api/sessions/${SID}`)).json()) as { session: { access: string } }).session.access, 'admin');
    h.state.actor = FRIEND;
    await h.redeem(body.token);
    const seen = await (await h.send(`/api/sessions/${SID}`)).json() as { session: Record<string, unknown> };
    assert.equal(seen.session.access, 'view');
    assert.equal(seen.session.adminAccess, null);
    assert.equal(seen.session.adbKeyId, null);
    assert.equal(seen.session.containerId, null);
    assert.ok(!JSON.stringify(seen).includes('abc123'));
    const list = await (await h.send('/api/sessions')).json() as { sessions: unknown[] };
    assert.equal(list.sessions.length, 0, 'the overview never lists shared sessions');
  } finally { await h.close(); }
});

test('REST input needs a control grant and view-only grants are refused', async () => {
  const h = await harness();
  try {
    const view = await h.share('view');
    const control = await h.share('control');
    h.state.actor = FRIEND;
    await h.redeem(view.body.token);
    assert.equal((await h.send(`/api/sessions/${SID}/input`, 'POST', { kind: 'key', keyCode: 4 })).status, 404);
    assert.equal(h.commands.filter(c => c.action === 'input').length, 0);
    h.state.actor = FRIEND2;
    await h.redeem(control.body.token);
    assert.equal((await h.send(`/api/sessions/${SID}/input`, 'POST', { kind: 'key', keyCode: 4 })).status, 200);
    assert.equal(h.commands.filter(c => c.action === 'input').length, 1);
  } finally { await h.close(); }
});

test('revoking, expiry and session end remove access immediately', async () => {
  const h = await harness();
  try {
    const { body } = await h.share('control');
    h.state.actor = FRIEND;
    await h.redeem(body.token);
    assert.equal((await h.send(`/api/sessions/${SID}`)).status, 200);
    h.state.actor = OWNER;
    assert.equal((await h.send(`/api/sessions/${SID}/shares/${body.share.id}`, 'DELETE')).status, 200);
    assert.equal((await h.send(`/api/sessions/${SID}/shares/${body.share.id}`, 'DELETE')).status, 404);
    h.state.actor = FRIEND;
    assert.equal((await h.send(`/api/sessions/${SID}`)).status, 404);
    assert.equal((await h.redeem(body.token)).status, 404, 'a revoked link cannot be redeemed again');

    h.state.actor = OWNER;
    const second = await h.share('view');
    h.state.actor = FRIEND2;
    await h.redeem(second.body.token);
    assert.equal((await h.send(`/api/sessions/${SID}`)).status, 200);
    await h.db.query("UPDATE session_share_grants SET expires_at=now() - interval '1 second' WHERE user_id=$1", [FRIEND2]);
    assert.equal((await h.send(`/api/sessions/${SID}`)).status, 404, 'expired grant');
    await h.db.query("UPDATE session_share_grants SET expires_at=now() + interval '1 hour'");
    assert.equal((await h.send(`/api/sessions/${SID}`)).status, 200);
    await h.db.query("UPDATE sessions SET state='stopping'");
    assert.equal((await h.send(`/api/sessions/${SID}`)).status, 404, 'a stopping session is closed to grant holders');
    await h.db.query("UPDATE sessions SET state='running'");
    await h.db.query('DELETE FROM sessions WHERE id=$1', [SID]);
    assert.equal((await h.db.query('SELECT 1 FROM session_share_grants')).rows.length, 0, 'ending the session deletes grants');
    assert.equal((await h.db.query('SELECT 1 FROM session_shares')).rows.length, 0);
  } finally { await h.close(); }
});

test('listing shows redeemers, and a single redeemer can be removed', async () => {
  const h = await harness();
  try {
    const { body } = await h.share('view');
    const { body: other } = await h.share('view');
    h.state.actor = FRIEND;
    await h.redeem(body.token);
    h.state.actor = FRIEND2;
    await h.redeem(other.token);
    h.state.actor = OWNER;
    const list = await (await h.send(`/api/sessions/${SID}/shares`)).json() as { shares: Array<{ id: string; redeemers: Array<{ grantId: string; userId: string; name: string; mode: string }> }> };
    const first = list.shares.find(share => share.id === body.share.id)!;
    const second = list.shares.find(share => share.id === other.share.id)!;
    assert.deepEqual(first.redeemers.map(r => [r.userId, r.name, r.mode]), [[FRIEND, 'Friend', 'view']]);
    assert.deepEqual(second.redeemers.map(r => [r.userId, r.name, r.mode]), [[FRIEND2, 'Friend2', 'view']]);
    const kick = first.redeemers[0]!.grantId;
    assert.equal((await h.send(`/api/sessions/${SID}/shares/${body.share.id}/grants/${kick}`, 'DELETE')).status, 200);
    h.state.actor = FRIEND;
    assert.equal((await h.send(`/api/sessions/${SID}`)).status, 404);
    assert.equal((await h.redeem(body.token)).status, 404, 'a removed user is not let back by the same link');
    h.state.actor = FRIEND2;
    assert.equal((await h.send(`/api/sessions/${SID}`)).status, 200);
  } finally { await h.close(); }
});

test('audit trail records creation, redemption, revoke and shared access', async () => {
  const h = await harness();
  try {
    const { body } = await h.share('view');
    h.state.actor = FRIEND;
    await h.redeem(body.token);
    await h.send(`/api/sessions/${SID}`);
    h.state.actor = OWNER;
    await h.send(`/api/sessions/${SID}/shares/${body.share.id}`, 'DELETE');
    await settle();
    const events = await audits(h.db);
    assert.deepEqual(events.map(e => e.action).sort(), ['session.created', 'session.shared_access', 'share.created', 'share.redeemed', 'share.revoked']);
    assert.equal(events.find(e => e.action === 'share.redeemed')!.actor_user_id, FRIEND);
    assert.equal(events.find(e => e.action === 'share.created')!.actor_user_id, OWNER);
  } finally { await h.close(); }
});

test('the stream permission function rejects input for view access only', () => {
  assert.equal(classifyStreamMessage('view', { type: 'input', kind: 'tap' }), 'reject');
  assert.equal(classifyStreamMessage('view', { type: 'request-keyframe' }), 'keyframe');
  assert.equal(classifyStreamMessage('view', { type: 'something' }), 'ignore');
  for (const access of ['control', 'owner', 'admin'] as const) assert.equal(classifyStreamMessage(access, { type: 'input' }), 'input');
});

test('the stream WebSocket enforces access levels and revoke closes it at once', async () => {
  const h = await harness();
  const open = (path: string) => new Promise<WebSocket>((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${h.port}${path}`);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
    ws.once('unexpected-response', (_req, res) => reject(new Error('status ' + res.statusCode)));
  });
  const closed = (ws: WebSocket) => new Promise<number>(resolve => ws.once('close', code => resolve(code)));
  try {
    const view = await h.share('view');
    const control = await h.share('control');
    h.state.actor = STRANGER;
    await assert.rejects(open(`/api/sessions/${SID}/stream`), /404/);
    h.state.actor = FRIEND;
    await h.redeem(view.body.token);
    await assert.rejects(open(`/api/sessions/${SID}/adb-tunnel`), /404/, 'the ADB tunnel never accepts grants');
    const viewer = await open(`/api/sessions/${SID}/stream`);
    const viewerClosed = closed(viewer);
    viewer.send(JSON.stringify({ type: 'input', kind: 'key', keyCode: 4 }));
    assert.equal(await viewerClosed, 1008);

    h.state.actor = FRIEND2;
    await h.redeem(control.body.token);
    const controller = await open(`/api/sessions/${SID}/stream`);
    controller.send(JSON.stringify({ type: 'input', kind: 'key', keyCode: 4 }));
    await settle();
    assert.equal(h.commands.filter(c => c.action === 'input').length, 1, 'only the control grant reached the device');

    const list = await (await (async () => { h.state.actor = OWNER; return h.send(`/api/sessions/${SID}/shares`); })()).json() as { shares: Array<{ redeemers: Array<{ connected: boolean; name: string }> }> };
    assert.deepEqual(list.shares.flatMap(s => s.redeemers).filter(r => r.connected).map(r => r.name), ['Friend2']);

    const controllerClosed = closed(controller);
    assert.equal((await h.send(`/api/sessions/${SID}/shares/${control.body.share.id}`, 'DELETE')).status, 200);
    assert.equal(await controllerClosed, 4003);
  } finally { await h.close(); }
});

test('a grant revoked between pre-upgrade authorization and socket registration receives no frames', async () => {
  const h = await harness();
  try {
    const { body } = await h.share('control');
    h.state.actor = FRIEND;
    await h.redeem(body.token);
    const grant = (await h.db.query('SELECT id FROM session_share_grants')).rows[0]!.id;
    let revoked: Promise<unknown> | undefined;
    // hasAgent runs after the first grant SELECT and before handleUpgrade.
    h.state.onHasAgent = () => {
      revoked = h.db.query('UPDATE session_share_grants SET revoked_at=now() WHERE id=$1', [grant]);
    };
    const ws = new WebSocket(`ws://127.0.0.1:${h.port}/api/sessions/${SID}/stream`);
    await once(ws, 'open');
    const [code] = await once(ws, 'close') as [number];
    await revoked;
    assert.equal(code, 4003);
    assert.equal(h.viewers.length, 0, 'the revoked viewer was never attached to the emulator');
  } finally { await h.close(); }
});

test('session end notifies the share module and shared access stays limited to viewer routes', async () => {
  const h = await harness();
  try { assert.equal(h.closedListeners.length, 1); } finally { await h.close(); }
  const files: string[] = [];
  for (const dir of ['src', 'src/routes']) for (const name of await readdir(new URL(`../${dir}/`, import.meta.url))) if (name.endsWith('.ts')) files.push(`${dir}/${name}`);
  const users: string[] = [];
  for (const file of files) if ((await readFile(new URL(`../${file}`, import.meta.url), 'utf8')).includes('accessibleSession')) users.push(file);
  assert.deepEqual(users.sort(), ['src/routes/session-routes.ts', 'src/session-access.ts', 'src/websocket.ts']);
});

test('GET /api/shares/mine lists only live grants of the caller without internals', async () => {
  const h = await harness();
  try {
    const mine = async () => (await (await h.send('/api/shares/mine')).json() as { shares: Array<Record<string, unknown>> }).shares;
    const view = await h.share('view', 30);
    const control = await h.share('control', 30);
    h.state.actor = STRANGER;
    assert.deepEqual(await mine(), [], 'a stranger sees nothing');
    h.state.actor = OWNER;
    assert.deepEqual(await mine(), [], 'the owner has no grants');
    h.state.actor = FRIEND;
    await h.redeem(view.body.token);
    let list = await mine();
    assert.equal(list.length, 1);
    assert.equal(list[0]!.sessionId, SID);
    assert.equal(list[0]!.mode, 'view');
    assert.equal(list[0]!.ownerName, 'Owner');
    assert.deepEqual(Object.keys(list[0]!).sort(), ['expiresAt', 'label', 'mode', 'ownerName', 'profileName', 'sessionId']);
    h.state.actor = FRIEND2;
    assert.deepEqual(await mine(), [], 'a grant of another user is not returned');
    h.state.actor = FRIEND;
    await h.redeem(control.body.token);
    assert.equal((await mine()).length, 2);
    await h.db.query("UPDATE session_share_grants SET expires_at=now() - interval '1 minute' WHERE share_id=$1", [view.body.share.id]);
    list = await mine();
    assert.deepEqual(list.map(item => item.mode), ['control'], 'expired grants are hidden');
    h.state.actor = OWNER;
    assert.equal((await h.send(`/api/sessions/${SID}/shares/${control.body.share.id}`, 'DELETE')).status, 200);
    h.state.actor = FRIEND;
    assert.deepEqual(await mine(), [], 'revoked grants are hidden');
  } finally { await h.close(); }
});


test('non-object WebSocket messages close safely before signaling or input dispatch', async () => {
  const h = await harness();
  try {
    for (const body of ['null', '[]', '"input"']) {
      const ws = new WebSocket(`ws://127.0.0.1:${h.port}/api/sessions/${SID}/stream`);
      await once(ws, 'open');
      const closed = once(ws, 'close');
      ws.send(body);
      assert.equal((await closed)[0], 1003);
    }
    assert.equal(h.commands.some(command => command.action === 'input'), false);
  } finally { await h.close(); }
});


test('share redemption and creation reject an account removed after initial authentication', async () => {
 const h=await harness();
 try {
  const link=await h.share();assert.equal(link.status,201);
  h.state.actor=FRIEND;
  await h.db.query('UPDATE users SET removed_at=now() WHERE id=$1',[FRIEND]);
  assert.equal((await h.redeem(link.body.token)).status,401);
  h.state.actor=OWNER;
  await h.db.query('UPDATE users SET removed_at=now() WHERE id=$1',[OWNER]);
  assert.equal((await h.share()).status,401);
  assert.equal((await h.db.query('SELECT count(*) AS n FROM session_share_grants')).rows[0].n,0);
 } finally {await h.close();}
});

test('a view grant permits PNG capture and revocation during capture prevents delivery', async () => {
  const h = await harness();
  try {
    const { body } = await h.share('view');
    h.state.actor = FRIEND;
    await h.redeem(body.token);
    const capture = await h.send(`/api/sessions/${SID}/screenshot`);
    assert.equal(capture.status, 200);
    assert.equal(capture.headers.get('content-type'), 'image/png');
    assert.equal(capture.headers.get('cache-control'), 'no-store');
    assert.equal(Buffer.from(await capture.arrayBuffer()).subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    h.state.onScreenshot = async () => {
      await h.db.query('UPDATE session_share_grants SET revoked_at=now() WHERE share_id=$1', [body.share.id]);
    };
    const denied = await h.send(`/api/sessions/${SID}/screenshot`);
    assert.equal(denied.status, 404);
    assert.ok(denied.headers.get('content-type')?.startsWith('application/json'));
  } finally { await h.close(); }
});
