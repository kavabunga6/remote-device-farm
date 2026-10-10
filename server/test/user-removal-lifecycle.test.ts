import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import test from 'node:test';
import WebSocket from 'ws';
import { generateAdbKeyPair } from '../src/adb-key.js';
import type { AgentHub } from '../src/agent.js';
import { closeGrantSockets, registerGrantSocket } from '../src/session-access.js';
import { attachRtcSignaling } from '../src/rtc-signaling.js';
import { registerAccessResource } from '../src/access-connections.js';
import { launchSession } from '../src/session-create.js';
import { apiFixture, credentials, memberCredentials } from './support/api-fixture.js';

const id = () => crypto.randomUUID();
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
async function eventually(check: () => Promise<boolean>) {
  for (let i = 0; i < 150; i++) {
    if (await check()) return;
    await new Promise(r => setTimeout(r, 20));
  }
  assert.fail('Expected state was not reached');
}

test('deletion stops owned devices, closes access immediately and isolates a reused login', async () => {
  const f = await apiFixture();
  const cleanup = deferred<Record<string, unknown>>(), boot = deferred<Record<string, unknown>>();
  const sockets: WebSocket[] = [];
  const request = async (method: string, path: string, cookie: string, body?: unknown, status = 200) => {
    const response = await fetch(f.url + path, { method, headers: {
      Origin: f.url, Cookie: cookie, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    }, body: body === undefined ? undefined : JSON.stringify(body) });
    assert.equal(response.status, status, method + ' ' + path);
    return response.json();
  };
  const login = async (username: string, password: string) => {
    const response = await fetch(f.url + '/api/login', { method: 'POST', headers: {
      Origin: f.url, 'Content-Type': 'application/json',
    }, body: JSON.stringify({ username, password }) });
    assert.equal(response.status, 200);
    return response.headers.get('set-cookie')!.split(';')[0]!;
  };
  const command = f.hub.command.bind(f.hub);
  const stops: Array<{ sessionId: string; action: string }> = [];
  let holdNextStart = false, viewers = 0, tunnels = 0;
  f.hub.command = async (hostId, sessionId, action, params) => {
    if (action === 'start' && holdNextStart) { holdNextStart = false; return boot.promise; }
    if (action === 'stop' || action === 'kill') {
      stops.push({ sessionId, action });
      return cleanup.promise;
    }
    return command(hostId, sessionId, action, params);
  };
  f.hub.openInput = async () => ({ inputEpoch: id(), serverTime: Date.now(), inputMaxAgeMs: 1000 });
  f.hub.addViewer = () => { viewers++; };
  f.hub.addTunnel = () => { tunnels++; };
  let detach = () => {};
  try {
    await f.pool.query("UPDATE hosts SET slots=3,manual_slots=3 WHERE id='contract-node'");
    await f.pool.query("INSERT INTO host_slots(host_id,slot_index) VALUES('contract-node',2)");
    const admin = await login(credentials.username, credentials.password);
    const guest = await login(memberCredentials.username, memberCredentials.password);
    const username = 'device-owner', oldPassword = 'Original-account-password-42';
    const original = await request('POST', '/api/admin/users', admin, {
      username, password: oldPassword, role: 'admin', company: 'Original company',
    }, 201);
    const oldId = original.user.id as string, oldCookie = await login(username, oldPassword);
    const pair = await request('POST', '/api/me/adb-key', oldCookie, {}, 201);
    const uploaded = await generateAdbKeyPair();
    const key = (await request('POST', '/api/me/adb-public-keys', oldCookie,
      { name: 'Original workstation', publicKey: uploaded.publicKey }, 201)).key;
    await request('PATCH', '/api/me/preferences', oldCookie, { theme: 'dark', defaultAdbKeyId: key.id });
    const oldToken = (await request('POST', '/api/tokens', oldCookie, { name: 'Original token' }, 201)).token;
    const create = async (cookie: string) => (await request('POST', '/api/sessions', cookie,
      { hostId: 'contract-node', profileId: 'contract-profile' }, 202)).session.id as string;
    const running = await create(oldCookie);
    await eventually(async () => (await f.pool.query('SELECT state FROM sessions WHERE id=$1', [running])).rows[0]?.state === 'running');
    holdNextStart = true;
    const starting = await create(oldCookie);
    const foreign = await create(guest);
    await eventually(async () => (await f.pool.query('SELECT state FROM sessions WHERE id=$1', [foreign])).rows[0]?.state === 'running');
    const share = await request('POST', '/api/sessions/' + running + '/shares', oldCookie,
      { mode: 'view', maxRecipients: 2 }, 201);
    await request('POST', '/api/shares/redeem', guest, { token: share.token });
    const foreignShare = await request('POST', '/api/sessions/' + foreign + '/shares', guest,
      { mode: 'view', maxRecipients: 2 }, 201);
    await request('POST', '/api/shares/redeem', oldCookie, { token: foreignShare.token });
    await f.pool.query("INSERT INTO adb_access_tokens(token_hash,session_id,owner_user_id,expires_at) VALUES('synthetic-adb-token',$1,$2,now()+interval '1 hour')", [running, oldId]);
    await f.pool.query('INSERT INTO adb_port_access(session_id,owner_user_id,port,public_key,fingerprint,expires_at) VALUES($1,$2,15555,$3,$4,now()+interval \'1 hour\')',
      [running, oldId, pair.publicKey, pair.fingerprint]);
    const team = id(), appId = id(), queue = id();
    await f.pool.query("INSERT INTO teams(id,name) VALUES($1,'Original team')", [team]);
    await f.pool.query("INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,'lead')", [team, oldId]);
    await f.pool.query("INSERT INTO stored_apps(id,owner_user_id,name,size_bytes,sha256) VALUES($1,$2,'Original app',4,$3)", [appId, oldId, 'c'.repeat(64)]);
    await f.pool.query("INSERT INTO queue_entries(id,user_id,profile_id,expires_at) VALUES($1,$2,'contract-profile',now()+interval '1 hour')", [queue, oldId]);
    await f.pool.query("INSERT INTO webhooks(id,user_id,url,secret,events) VALUES($1,$2,'https://hooks.invalid','synthetic-secret',ARRAY['session.ready'])", [id(), oldId]);
    let directClosed = 0;
    detach = registerAccessResource(oldId, () => { directClosed++; });
    const open = async (session: string, kind: string, cookie: string) => {
      const ws = new WebSocket(f.url.replace('http:', 'ws:') + '/api/sessions/' + session + '/' + kind,
        { headers: { Origin: f.url, Cookie: cookie } });
      sockets.push(ws); await once(ws, 'open'); return ws;
    };
    const ownerStream = await open(running, 'stream', oldCookie);
    const ownerAdb = await open(running, 'adb-tunnel', oldCookie);
    const guestStream = await open(running, 'stream', guest);
    await eventually(async () => viewers === 2 && tunnels === 1);
    const closed = [ownerStream, ownerAdb, guestStream].map(ws => once(ws, 'close'));
    await request('DELETE', '/api/admin/users/' + oldId, admin);
    await Promise.all(closed);
    assert.equal(directClosed, 1);
    await eventually(async () => stops.length === 2);
    assert.deepEqual(stops.sort((a,b) => a.sessionId.localeCompare(b.sessionId)),
      [{sessionId: running, action: 'stop'}, {sessionId: starting, action: 'kill'}].sort((a,b) => a.sessionId.localeCompare(b.sessionId)));
    for (const sessionId of [running, starting]) {
      assert.equal((await f.pool.query('SELECT state FROM sessions WHERE id=$1', [sessionId])).rows[0]?.state, 'stopping');
      assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM host_slots WHERE session_id=$1', [sessionId])).rows[0].n, 1);
    }
    assert.equal((await request('GET', '/api/sessions/' + foreign, guest)).session.state, 'running');
    await request('POST', '/api/shares/redeem', guest, { token: share.token }, 404);
    await request('GET', '/api/sessions/' + running, guest, undefined, 404);
    await request('GET', '/api/me/preferences', oldCookie, undefined, 401);
    await request('POST', '/api/login', '', { username, password: oldPassword }, 401);
    assert.equal((await fetch(f.url + '/api/me/preferences', { headers: { Authorization: 'Bearer ' + oldToken } })).status, 401);
    for (const [table, column] of [['browser_sessions','user_id'], ['api_tokens','owner_user_id'],
      ['adb_access_tokens','owner_user_id'], ['adb_port_access','owner_user_id'], ['user_adb_keys','user_id'],
      ['user_adb_public_keys','owner_user_id'], ['team_members','user_id']]) {
      assert.equal((await f.pool.query(`SELECT 1 FROM ${table} WHERE ${column}=$1`, [oldId])).rows.length, 0, table);
    }
    assert.ok((await f.pool.query('SELECT revoked_at FROM session_share_grants WHERE user_id=$1 AND session_id=$2', [oldId, foreign])).rows[0]?.revoked_at);
    assert.equal((await f.pool.query('SELECT state FROM queue_entries WHERE id=$1', [queue])).rows[0].state, 'cancelled');
    assert.equal((await f.pool.query('SELECT enabled FROM webhooks WHERE user_id=$1', [oldId])).rows[0].enabled, false);
    const fresh = await request('POST', '/api/admin/users', admin, { username, password: 'Replacement-account-password-43' }, 201);
    assert.notEqual(fresh.user.id, oldId);
    const cookie = await login(username, 'Replacement-account-password-43');
    const me = (await request('GET', '/api/me', cookie)).user;
    assert.equal(me.role, 'user'); assert.equal(me.company, null);
    await request('GET', '/api/admin/users', cookie, undefined, 403);
    for (const sessionId of [running, starting, foreign]) await request('GET', '/api/sessions/' + sessionId, cookie, undefined, 404);
    await request('POST', '/api/shares/redeem', cookie, { token: share.token }, 404);
    assert.equal((await request('GET', '/api/me/adb-key', cookie)).key, null);
    assert.deepEqual((await request('GET', '/api/me/adb-public-keys', cookie)).keys, []);
    assert.deepEqual((await request('GET', '/api/apps', cookie)).apps, []);
    assert.deepEqual((await request('GET', '/api/me/rentals', cookie)).rentals, []);
    assert.deepEqual((await request('GET', '/api/teams/mine', cookie)).teams, []);
    assert.deepEqual((await request('GET', '/api/me/webhooks', cookie)).webhooks, []);
    const prefs = (await request('GET', '/api/me/preferences', cookie)).preferences;
    assert.equal(prefs.theme, 'system'); assert.equal(prefs.defaultAdbKeyId, null);
    // Delayed startup cannot transition the deleted owner's lease back to running.
    boot.resolve({ containerId: 'delayed-original-container' });
    cleanup.resolve({});
    await eventually(async () => !(await f.pool.query('SELECT 1 FROM sessions WHERE id=ANY($1::uuid[])', [[running,starting]])).rows.length);
    assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM host_slots WHERE session_id=ANY($1::uuid[])', [[running,starting]])).rows[0].n, 0);
    const history = await f.pool.query('SELECT owner_user_id FROM rental_history WHERE session_id=ANY($1::uuid[])', [[running,starting]]);
    assert.equal(history.rows.length, 2); assert.ok(history.rows.every(row => row.owner_user_id === oldId));
    assert.equal((await request('GET', '/api/sessions/' + foreign, guest)).session.state, 'running');
  } finally {
    boot.resolve({}); cleanup.resolve({}); detach();
    for (const ws of sockets) ws.terminate();
    await f.close();
  }
});

test('a delayed preparation cannot start after a stop or account deletion', async () => {
  const f = await apiFixture();
  try {
    const owner = '11111111-1111-4111-8111-111111111111';
    for (const state of ['stopping', 'stopped', 'starting']) {
      const session = id();
      await f.pool.query("INSERT INTO sessions(id,owner_user_id,host_id,profile_id,state) VALUES($1,$2,'contract-node','contract-profile',$3)", [session, owner, state]);
      if (state === 'starting') await f.pool.query('UPDATE users SET removed_at=now() WHERE id=$1', [owner]);
      await launchSession({ pool: f.pool, hub: f.hub }, session, 'contract-node', { profile: {} });
      await eventually(async () => (await f.pool.query("SELECT 1 FROM service_logs WHERE session_id=$1 AND code='session.start_failed'", [session])).rows.length > 0);
    }
    assert.equal(f.hub.launches.length, 0);
  } finally { await f.close(); }
});


test('failed cleanup retains the deleted owner lease until a successful retry', async () => {
  const f = await apiFixture();
  try {
    const login = await fetch(f.url + '/api/login', { method: 'POST', headers: {
      Origin: f.url, 'Content-Type': 'application/json',
    }, body: JSON.stringify(credentials) });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    const owner = '11111111-1111-4111-8111-111111111111', session = id();
    await f.pool.query("INSERT INTO sessions(id,owner_user_id,host_id,profile_id,state) VALUES($1,$2,'contract-node','contract-profile','running')", [session, owner]);
    await f.pool.query("UPDATE host_slots SET session_id=$1 WHERE host_id='contract-node' AND slot_index=0", [session]);
    let online = false;
    const command = f.hub.command.bind(f.hub);
    f.hub.hasAgent = () => online;
    f.hub.command = async (...args) => {
      if (!online) throw new Error('Synthetic agent unavailable');
      return command(...args);
    };
    const removed = await fetch(f.url + '/api/admin/users/' + owner, {
      method: 'DELETE', headers: { Origin: f.url, Cookie: cookie },
    });
    assert.equal(removed.status, 200);
    await eventually(async () => (await f.pool.query("SELECT 1 FROM service_logs WHERE session_id=$1 AND code='session.cleanup_deferred'", [session])).rows.length > 0);
    assert.equal((await f.pool.query('SELECT state FROM sessions WHERE id=$1', [session])).rows[0].state, 'stopping');
    assert.equal((await f.pool.query('SELECT session_id FROM host_slots WHERE slot_index=0')).rows[0].session_id, session);
    assert.ok((await f.pool.query('SELECT removed_at FROM users WHERE id=$1', [owner])).rows[0].removed_at);
    online = true;
    f.hub.stopSession('contract-node', session, true);
    await eventually(async () => !(await f.pool.query('SELECT 1 FROM sessions WHERE id=$1', [session])).rows.length);
    assert.equal((await f.pool.query('SELECT session_id FROM host_slots WHERE slot_index=0')).rows[0].session_id, null);
  } finally { await f.close(); }
});


test('revoking a shared stream closes WebRTC before a client acknowledges WebSocket close', async () => {
  class UnresponsiveSocket extends EventEmitter {
    readyState: number = WebSocket.OPEN;
    send() {}
    close() { this.readyState = WebSocket.CLOSING; }
  }
  const socket = new UnresponsiveSocket(), sessionId = id(), grantId = id();
  const commands: string[] = [];
  const hub = {
    setViewerTransport() {},
    command: async (_host: string, _session: string, action: string) => {
      commands.push(action); return { description: { type: 'answer', sdp: 'synthetic-answer' } };
    },
  } as unknown as AgentHub;
  const rtc = attachRtcSignaling({ socket: socket as unknown as WebSocket, hub,
    hostId: 'contract-node', sessionId, canControl: true, activity() {}, enabled: true });
  registerGrantSocket(sessionId, { ws: socket as unknown as WebSocket, grantId,
    userId: id(), name: 'Shared viewer', mode: 'control', beforeClose: rtc.close });
  try {
    assert.equal(rtc.handle({ type: 'rtc-offer', description: { type: 'offer', sdp: 'synthetic-offer' } }), true);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(closeGrantSockets(sessionId, new Set([id()])), 0);
    assert.equal(commands.includes('rtc-close'), false);
    assert.equal(closeGrantSockets(sessionId, new Set([grantId])), 1);
    assert.equal(socket.readyState, WebSocket.CLOSING);
    assert.equal(commands.filter(action => action === 'rtc-close').length, 1);
    rtc.handle({ type: 'ping' });
    assert.equal(commands.includes('rtc-renew'), false);
  } finally { socket.emit('close'); }
});
