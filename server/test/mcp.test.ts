import assert from 'node:assert/strict';
import test from 'node:test';
import { runQueuePass } from '../src/queue-dispatcher.js';
import { apiFixture, credentials, memberCredentials } from './support/api-fixture.js';
import { createMcpServer } from '../../integrations/mcp/src/server.mjs';
import { connectTestClient } from '../../integrations/mcp/test/sdk.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jbeQAAAAASUVORK5CYII=', 'base64');
const output = (result: any) => result.structuredContent || JSON.parse(result.content[0].text);
async function wait(check: () => Promise<boolean>) {
  const deadline = Date.now() + 10_000;
  while (!await check()) { assert.ok(Date.now() < deadline); await new Promise(resolve => setTimeout(resolve, 30)); }
}

test('MCP uses production HTTP authentication, queue idempotency, PNG capture and confirmed session cleanup', async () => {
  const f = await apiFixture();
  const clients: any[] = []; const servers: any[] = [];
  const rpc: string[] = []; let invalidScreenshot = false;
  const original = f.hub.command.bind(f.hub);
  f.hub.command = async (host: string, session: string, action: string, params: Record<string, unknown>) => {
    rpc.push(action);
    if (action === 'screenshot') return invalidScreenshot ? { mime: 'text/html', data: 'not-an-image' } :
      { mime: 'image/png', data: png.toString('base64'), width: 1, height: 1 };
    return original(host, session, action, params);
  };
  async function request(method: string, path: string, body?: unknown, token?: string) {
    const response = await fetch(f.url + path, { method, headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { response, body: await response.json() as any };
  }
  async function account(login: typeof credentials) {
    const signed = await request('POST', '/api/login', login);
    assert.equal(signed.response.status, 200);
    const tokenResponse = await fetch(f.url + '/api/tokens', { method: 'POST',
      headers: { cookie: signed.response.headers.get('set-cookie')!.split(';')[0], origin: f.url, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'MCP contract token' }) });
    assert.equal(tokenResponse.status, 201);
    const tokenData = await tokenResponse.json() as any;
    const token = tokenData.token;
    assert.equal(typeof token, 'string');
    const server = createMcpServer({ url: f.url, token, language: 'en', uploadRoot: null });
    servers.push(server); const client = await connectTestClient(server); clients.push(client);
    return { client, token, tokenId: tokenData.item.id };
  }
  try {
    const admin = await account(credentials); const member = await account(memberCredentials);
    const pending = output(await member.client.callTool({ name: 'request_device', arguments: { profileId: 'contract-profile', hostId: 'contract-node', requestKey: 'mcp-contract-1', leaseTtlSeconds: 300 } }));
    assert.equal(pending.state, 'waiting');
    const repeated = output(await member.client.callTool({ name: 'request_device', arguments: { profileId: 'contract-profile', hostId: 'contract-node', requestKey: 'mcp-contract-1', leaseTtlSeconds: 300 } }));
    assert.equal(repeated.id, pending.id);
    assert.equal((await f.pool.query('SELECT count(*)::int AS count FROM queue_entries')).rows[0].count, 1);
    assert.equal(output(await member.client.callTool({ name: 'release_device', arguments: { requestId: pending.id } })).released, true);

    const ordered = output(await member.client.callTool({ name: 'request_device', arguments: {
      profileId: 'contract-profile', hostId: 'contract-node', requestKey: 'mcp-contract-2', leaseTtlSeconds: 300 } }));
    await runQueuePass(f.context);
    await wait(async () => output(await member.client.callTool({ name: 'get_request', arguments: { requestId: ordered.id } })).sessionState === 'running');
    const ready = output(await member.client.callTool({ name: 'get_request', arguments: { requestId: ordered.id } }));
    const sessionId = ready.sessionId;
    assert.equal(ready.leaseTtlSeconds, 300);
    const renewed = output(await member.client.callTool({ name: 'renew_device', arguments: { sessionId } }));
    assert.equal(renewed.session.leaseTtlSeconds, 300);
    const screenshot = await member.client.callTool({ name: 'screenshot', arguments: { sessionId } });
    assert.equal(screenshot.isError, undefined);
    assert.deepEqual(Buffer.from(screenshot.content[0].data, 'base64'), png);
    const imageResponse = await fetch(f.url + '/api/sessions/' + sessionId + '/screenshot', { headers: { Authorization: 'Bearer ' + member.token } });
    assert.equal(imageResponse.headers.get('cache-control'), 'no-store');
    assert.equal(imageResponse.headers.get('content-type'), 'image/png');
    await imageResponse.arrayBuffer();

    const adminSession = await request('POST', '/api/sessions', { hostId: 'contract-node', profileId: 'contract-profile' }, admin.token);
    await wait(async () => (await request('GET', '/api/sessions/' + adminSession.body.session.id, undefined, admin.token)).body.session.state === 'running');
    const before = rpc.length;
    const forbidden = await member.client.callTool({ name: 'screenshot', arguments: { sessionId: adminSession.body.session.id } });
    assert.equal(forbidden.isError, true); assert.equal(output(forbidden).httpStatus, 404); assert.equal(rpc.length, before);

    invalidScreenshot = true;
    const invalid = await member.client.callTool({ name: 'screenshot', arguments: { sessionId } });
    assert.equal(invalid.isError, true); assert.equal(output(invalid).code, 'invalid_screenshot');
    invalidScreenshot = false;
    const input = await member.client.callTool({ name: 'device_input', arguments: { sessionId, action: { kind: 'tap', x: 1, y: 1 } } });
    assert.equal(output(input).ok, true);
    assert.ok(rpc.includes('input'));

    await f.pool.query("UPDATE users SET access_role_id=(SELECT id FROM access_roles WHERE builtin='user') WHERE username=$1", [memberCredentials.username]);
    const roleId = (await f.pool.query("SELECT access_role_id AS id FROM users WHERE username=$1", [memberCredentials.username])).rows[0].id;
    const permissionList = (await f.pool.query('SELECT permissions FROM access_roles WHERE id=$1', [roleId])).rows[0].permissions;
    await f.pool.query('UPDATE access_roles SET permissions=$2 WHERE id=$1', [roleId, permissionList.filter((p: string) => p !== 'sessions.control')]);
    const denied = await member.client.callTool({ name: 'device_input', arguments: { sessionId, action: { kind: 'key', keyCode: 3 } } });
    assert.equal(denied.isError, true); assert.equal(output(denied).httpStatus, 403);
    const releasing = output(await member.client.callTool({ name: 'release_device', arguments: { requestId: ordered.id } }));
    assert.equal(releasing.released, false);
    await wait(async () => output(await member.client.callTool({ name: 'get_request', arguments: { requestId: ordered.id } })).released === true);
    // Revocation is checked on every API call, including reads.
    const tokens = await request('GET', '/api/tokens', undefined, member.token);
    const ownedToken = tokens.body.tokens.find((token: any) => token.name === 'MCP contract token');
    await request('DELETE', '/api/tokens/' + ownedToken.id, undefined, member.token);
    assert.equal(output(await member.client.callTool({ name: 'list_profiles', arguments: {} })).httpStatus, 401);
  } finally {
    for (const client of clients) await client.close();
    for (const server of servers) await server.close();
    await f.close();
  }
});
