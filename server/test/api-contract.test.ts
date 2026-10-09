import assert from 'node:assert/strict';
import test from 'node:test';
import ts from 'typescript';
import { requestPermission } from '../src/request-permissions.js';
import { apiFixture, credentials, memberCredentials } from './support/api-fixture.js';
import {
  clientOperations,
  serverOperations,
  operationKey,
  typeSchema,
  resolvePath,
} from './support/api-sources.mjs';
import {
  readContract,
  checkCoverage,
  createContractValidator,
  schemaValidator,
  pathPattern,
  documentedOperations,
} from './support/openapi-contract.mjs';
async function waitFor(check: () => Promise<boolean>) {
  const deadline = Date.now() + 10_000;
  while (!(await check())) {
    assert.ok(Date.now() < deadline, 'Asynchronous session operation did not finish');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
const doc = readContract(),
  clients = clientOperations(),
  validate = createContractValidator(doc);
test('every production HTTP route and UI API call is documented', () => {
  assert.deepEqual(checkCoverage(serverOperations(), clients, doc), []);
  for (const key of [
    'PUT /api/admin/teams/{}/members',
    'POST /api/me/password',
    'POST /api/apps',
    'GET /api/admin/emulator-images',
  ])
    assert.ok(
      clients.some((c) => operationKey(c.method, c.path) === key),
      key,
    );
});
test('documented permission gates track production authorization', () => {
  for (const { method, path, operation } of documentedOperations(doc)) {
    if (operation['x-external']) continue;
    assert.equal(operation['x-permission'], requestPermission(method, path), `${method} ${path}`);
  }
  assert.equal(doc.components.securitySchemes.cookieAuth.name, 'rdf_session');
  assert.deepEqual(doc.security, [{ bearerAuth: [] }, { cookieAuth: [] }]);
});
test('route drift and unresolved URL helpers fail the contract check', () => {
  assert.ok(
    checkCoverage([{ method: 'GET', path: '/api/undocumented' }], [], doc).some((s) =>
      s.includes('Undocumented'),
    ),
  );
  assert.ok(
    checkCoverage(serverOperations(), [{ method: 'PUT', path: '/api/me/password' }], doc).some((s) =>
      s.includes('Client operation'),
    ),
  );
  const node = ts.createSourceFile('url.ts', 'customUrl(id)', ts.ScriptTarget.Latest, true).statements[0]
    .expression;
  assert.equal(resolvePath(node), null);
});
test('OpenAPI schemas compile and reject malformed responses/statuses', () => {
  const compile = schemaValidator(doc);
  for (const name of Object.keys(doc.components.schemas)) compile({ $ref: '#/components/schemas/' + name });
  assert.notDeepEqual(
    validate({ method: 'GET', url: '/api/config', status: 200, body: { authMode: 42 } }),
    [],
  );
  assert.notDeepEqual(validate({ method: 'GET', url: '/api/config', status: 299, body: {} }), []);
  assert.ok(
    validate({ method: 'POST', url: '/api/tokens', status: 201, body: {} }).includes(
      'Missing JSON request body',
    ),
  );
  assert.ok(
    validate({ method: 'GET', url: '/api/admin/session-diagnostics', status: 200, body: {} }).includes(
      'Missing query parameter: session',
    ),
  );
  assert.ok(
    validate({ method: 'GET', url: '/api/queue/not-a-uuid', status: 200, body: {} }).some((message) =>
      message.startsWith('path id:'),
    ),
  );
  assert.notDeepEqual(
    validate({ method: 'GET', url: '/api/sessions', status: 401, body: { error: 'invalid envelope' } }),
    [],
  );
  assert.notDeepEqual(
    validate({ method: 'GET', url: '/api/config', status: 200, contentType: 'text/plain', body: 'wrong' }),
    [],
  );
});
test('real routes satisfy OpenAPI and UI wire types with cookie and bearer auth', async () => {
  const f = await apiFixture(),
    compile = schemaValidator({ components: { schemas: {} } });
  const request = async (
    method: string,
    path: string,
    data?: unknown,
    headers: Record<string, string> = {},
  ) => {
    const response = await fetch(f.url + path, {
        method,
        headers: { origin: f.url, ...(data ? { 'content-type': 'application/json' } : {}), ...headers },
        body: data ? JSON.stringify(data) : undefined,
      }),
      body = await response.json();
    assert.deepEqual(
      validate({
        method,
        url: path,
        status: response.status,
        contentType: response.headers.get('content-type'),
        body,
        ...(response.ok ? { requestBody: data } : {}),
      }),
      [],
      `${method} ${path}`,
    );
    if (response.ok)
      for (const c of clients.filter(
        (c) => c.method === method && pathPattern(c.path).test(path.split('?')[0]),
      )) {
        const check = compile(typeSchema(c.responseType, c.checker));
        assert.ok(check(body), `${method} ${path} UI type: ${JSON.stringify(check.errors)}`);
      }
    return { response, body };
  };
  try {
    assert.equal((await request('GET', '/api/me')).body.user, null);
    assert.equal((await request('GET', '/api/sessions')).response.status, 401);
    await request('GET', '/api/config');
    const login = await request('POST', '/api/login', credentials),
      cookie = login.response.headers.get('set-cookie')!.split(';')[0];
    assert.match(cookie, /^rdf_session=/);
    assert.match(login.response.headers.get('set-cookie')!, /HttpOnly/);
    const auth = { cookie };
    for (const route of [
      '/api/me',
      '/api/hosts',
      '/api/profiles',
      '/api/admin/users',
      '/api/admin/roles',
      '/api/me/profile',
      '/api/me/preferences',
      '/api/admin/teams',
      '/api/teams/mine',
      '/api/me/limits',
      '/api/me/notifications',
      '/api/me/webhooks',
      '/api/apps',
      '/api/queue',
      '/api/tokens',
      '/api/me/adb-public-keys',
      '/api/me/adb-key',
      '/api/navigation-counts',
      '/api/admin/profiles',
      '/api/admin/profiles/export',
      '/api/admin/launch-settings',
      '/api/admin/hosts/contract-node/slots',
      '/api/admin/rentals',
      '/api/admin/audit',
      '/api/admin/logs',
      '/api/admin/session-diagnostics?session=11111111',
      '/api/me/rentals',
      '/api/admin/agents',
      '/api/admin/ops/summary',
      '/api/admin/image-management/policy',
      '/api/admin/image-management/jobs',
      '/api/admin/registry',
      '/api/admin/emulator-images',
      '/api/admin/emulator-images/prewarm',
    ])
      assert.equal((await request('GET', route, undefined, auth)).response.status, 200, route);
    const token = await request('POST', '/api/tokens', { name: 'Contract automation' }, auth);
    assert.equal(token.response.status, 201, token.body.error?.code);
    const bearer = { authorization: 'Bearer ' + token.body.token };
    assert.equal(
      (
        await request(
          'POST',
          '/api/tokens',
          { name: 'Rejected origin' },
          { ...auth, origin: 'https://untrusted.example.invalid' },
        )
      ).response.status,
      403,
    );
    await request('GET', '/api/me', undefined, bearer);
    const queued = await request(
      'POST',
      '/api/queue',
      { profileId: 'contract-profile', hostId: 'contract-node' },
      auth,
    );
    assert.equal(queued.response.status, 201);
    await request('GET', '/api/queue', undefined, auth);
    await request('GET', '/api/queue/' + queued.body.id, undefined, auth);
    assert.equal(
      (await request('DELETE', '/api/queue/' + queued.body.id, undefined, auth)).response.status,
      200,
    );
    const started = await request(
      'POST',
      '/api/sessions',
      { hostId: 'contract-node', profileId: 'contract-profile' },
      bearer,
    );
    assert.equal(started.response.status, 202);
    const id = started.body.session.id;
    await waitFor(
      async () =>
        (await request('GET', '/api/sessions/' + id, undefined, bearer)).body.session.state === 'running',
    );
    await request('GET', '/api/sessions', undefined, auth);
    await request('GET', '/api/sessions/' + id, undefined, bearer);
    for (const input of [
      { kind: 'tap', x: 50, y: 100 },
      { kind: 'swipe', x1: 50, y1: 100, x2: 100, y2: 200, durationMs: 300 },
      { kind: 'key', keyCode: 3 },
      { kind: 'text', text: 'Contract text' },
      { type: 'input', kind: 'touch', action: 'down', pointerId: 0, x: 50, y: 100 },
    ])
      assert.equal((await request('POST', `/api/sessions/${id}/input`, input, auth)).response.status, 200);
    assert.equal(
      (
        await request(
          'POST',
          `/api/sessions/${id}/input`,
          { kind: 'touch', action: 'down', pointerId: 1, x: 50, y: 100 },
          auth,
        )
      ).response.status,
      400,
    );
    await request(
      'POST',
      `/api/sessions/${id}/env`,
      { op: 'proxy', params: { enabled: true, host: 'proxy.example.invalid', port: 8080 } },
      auth,
    );
    await request('GET', `/api/sessions/${id}/env`, undefined, auth);
    const member = await request('POST', '/api/login', memberCredentials),
      memberAuth = { cookie: member.response.headers.get('set-cookie')!.split(';')[0] };
    assert.equal((await request('GET', '/api/admin/users', undefined, memberAuth)).response.status, 403);
    assert.equal((await request('GET', `/api/sessions/${id}`, undefined, memberAuth)).response.status, 404);
    assert.equal((await request('DELETE', `/api/sessions/${id}`, undefined, auth)).response.status, 202);
    await waitFor(
      async () => (await request('GET', '/api/sessions', undefined, bearer)).body.sessions.length === 0,
    );
    assert.equal((await request('GET', '/api/sessions', undefined, bearer)).body.sessions.length, 0);
    await request('POST', '/api/logout', undefined, auth);
    assert.equal((await request('GET', '/api/sessions', undefined, auth)).response.status, 401);
    await request('DELETE', '/api/tokens/' + token.body.item.id, undefined, bearer);
    assert.equal((await request('GET', '/api/sessions', undefined, bearer)).response.status, 401);
  } finally {
    await f.close();
  }
});
