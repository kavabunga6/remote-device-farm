import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import WebSocket from 'ws';
import { apiFixture, credentials, memberCredentials } from './support/api-fixture.js';
import { agentIdForToken } from '../../shared/agent-identity.mjs';
import { loadConfig } from '../../agent/src/config.mjs';
import { tokenHash } from '../src/auth.js';

test('a server address and new token enroll exactly one node; forged IDs and revoked tokens fail', async () => {
  const f = await apiFixture(); let socket: WebSocket | undefined;
  const request = (path: string, method = 'GET', data?: unknown, cookie = '') => fetch(f.url + path, { method, headers: { origin: f.url, cookie, 'content-type': 'application/json' }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  const rejected = (token: string) => new Promise<number>((resolve, reject) => {
    const ws = new WebSocket(f.url.replace('http:', 'ws:') + '/agent/connect', { headers: { authorization: 'Bearer ' + token } });
    ws.on('error', () => {}); ws.on('open', () => { ws.terminate(); reject(Error('Unauthenticated agent connected')); });
    ws.on('unexpected-response', (_req, res) => { res.resume(); ws.terminate(); resolve(res.statusCode!); });
  });
  try {
    assert.ok([200, 503].includes((await request('/api/downloads/agent/info')).status));
    assert.equal((await request('/api/admin/agents', 'POST', {})).status, 401);
    const member = await request('/api/login', 'POST', memberCredentials), memberCookie = member.headers.get('set-cookie')!.split(';')[0];
    assert.equal((await request('/api/admin/agents', 'POST', {}, memberCookie)).status, 403);
    const login = await request('/api/login', 'POST', credentials), cookie = login.headers.get('set-cookie')!.split(';')[0];
    for (const invalid of [[], { hostId: null }, { hostId: '' }]) assert.equal((await request('/api/admin/agents', 'POST', invalid, cookie)).status, 400);
    const issued = await request('/api/admin/agents', 'POST', {}, cookie); assert.equal(issued.status, 201);
    const { token, agent } = await issued.json();
    const config = loadConfig({ AGENT_SERVER_URL: f.url, AGENT_TOKEN: token });
    assert.equal(config.agentId, agent.hostId); assert.equal(agent.hostId, agentIdForToken(token));
    assert.equal((await f.pool.query('SELECT 1 FROM hosts WHERE id=$1', [agent.hostId])).rowCount, 0);
    assert.equal((await f.pool.query('SELECT token_hash FROM agent_credentials WHERE host_id=$1', [agent.hostId])).rows[0].token_hash, tokenHash(token));
    const another = await (await request('/api/admin/agents', 'POST', {}, cookie)).json(); assert.notEqual(another.agent.hostId, agent.hostId);
    const manual = await (await request('/api/admin/agents', 'POST', { hostId: 'legacy-node' }, cookie)).json(); assert.equal(manual.agent.hostId, 'legacy-node');
    assert.equal(await rejected(token + 'invalid'), 401);
    socket = new WebSocket(config.brokerUrl, { headers: { authorization: 'Bearer ' + token } }); socket.on('error', () => {}); await once(socket, 'open');
    const wrong = once(socket, 'close'); socket.send(JSON.stringify({ type: 'hello', hostId: 'other-node', name: 'Example', slots: 1 })); assert.equal((await wrong)[0], 1008);
    socket = new WebSocket(config.brokerUrl, { headers: { authorization: 'Bearer ' + token } }); socket.on('error', () => {}); await once(socket, 'open');
    const welcome = once(socket, 'message'); socket.send(JSON.stringify({ type: 'hello', hostId: config.agentId, name: 'Example node', slots: 1, metrics: {} }));
    assert.equal(JSON.parse((await welcome)[0].toString()).type, 'welcome');
    const hosts = await (await request('/api/hosts', 'GET', undefined, cookie)).json(); assert.equal(hosts.hosts.find((host: { id: string }) => host.id === agent.hostId).name, 'Example node');
    const closed = once(socket, 'close'); assert.equal((await request('/api/admin/agents/' + agent.hostId, 'DELETE', undefined, cookie)).status, 200); await closed;
    assert.equal(await rejected(token), 401);
  } finally { socket?.terminate(); await f.close(); }
});
