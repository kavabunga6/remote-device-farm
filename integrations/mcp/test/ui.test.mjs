import test from 'node:test';
import assert from 'node:assert/strict';
import { createMcpServer } from '../src/server.mjs';
import { connectTestClient } from './sdk.mjs';
const sessionId = '11111111-1111-4111-8111-111111111111';
const output = result => result.structuredContent || JSON.parse(result.content[0].text);
test('semantic MCP selectors, read-only wait timeout and tap metadata use the SDK protocol', async () => {
  const requests = [];
  const server = createMcpServer({ language: 'en' }, { request: async (method, resource, options) => {
    requests.push({ method, resource, body: options?.body });
    return method === 'POST' ? { tapped: true } : { nodes: [
      { id: 0, text: 'Sign in', resourceId: 'app:id/login', description: '' },
      { id: 1, text: 'Sign in again', resourceId: 'app:id/retry', description: '' },
    ] };
  } });
  const client = await connectTestClient(server);
  try {
    const tools = (await client.listTools()).tools;
    assert.equal(tools.find(t => t.name === 'wait_ui').annotations.readOnlyHint, true);
    assert.equal(tools.find(t => t.name === 'tap_ui').annotations.idempotentHint, false);
    assert.equal(output(await client.callTool({ name: 'find_ui', arguments: { sessionId, selector: { text: 'Sign in' } } })).count, 1);
    assert.equal(output(await client.callTool({ name: 'find_ui', arguments: { sessionId, selector: { text: 'Sign in', exact: false } } })).count, 2);
    assert.equal(output(await client.callTool({ name: 'wait_ui', arguments: { sessionId, selector: { text: 'Missing' }, gone: true } })).matched, true);
    const before = requests.length;
    const waited = output(await client.callTool({ name: 'wait_ui', arguments: { sessionId, selector: { text: 'Missing' }, timeoutMs: 1000 } }));
    assert.equal(waited.matched, false);
    assert.ok(requests.length - before <= 3);
    assert.ok(requests.slice(before).every(r => r.method === 'GET'));
    assert.equal((await client.callTool({ name: 'tap_ui', arguments: { sessionId, selector: {} } })).isError, true);
    assert.equal(output(await client.callTool({ name: 'tap_ui', arguments: { sessionId, selector: { resourceId: 'app:id/login' } } })).tapped, true);
    assert.equal(requests.at(-1).resource, '/api/sessions/' + sessionId + '/ui/tap');
    assert.equal(requests.at(-1).body.selector.exact, true);
  } finally { await client.close(); await server.close(); }
});
