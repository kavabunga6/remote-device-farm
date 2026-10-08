import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { liveProxy } from './live-proxy.mjs';

const options = { target: 'https://192.0.2.10:8443', origin: 'http://localhost:5173' };
const request = (headers = {}, url = '/api/me') => ({ url, headers: { host: 'localhost:5173', ...headers } });

function boundary() {
  const server = {
    httpServer: new EventEmitter(),
    middlewares: { use(handler) { server.handle = handler; } },
  };
  liveProxy(options).plugin.configureServer(server);
  return {
    http(req) {
      const result = { next: false, status: undefined, body: undefined };
      server.handle(req, {
        writeHead(status) { result.status = status; },
        end(body) { result.body = body; },
      }, () => { result.next = true; });
      return result;
    },
    upgrade(req) {
      let destroyed = false;
      server.httpServer.emit('upgrade', req, { destroy() { destroyed = true; } });
      return destroyed;
    },
  };
}

const blockedRequests = [
  request({ origin: 'https://unrelated.example', referer: 'http://localhost:5173/' }),
  request({ host: 'unrelated.example:5173', origin: 'http://localhost:5173' }),
  request({ origin: 'http://localhost:5174' }),
  request({ origin: 'null' }),
  request({ origin: 'not a URL' }),
  request({ referer: 'http://localhost:5173.unrelated.example/' }),
  request({ cookie: 'rdf_session=test-only' }),
];

const allowedRequests = [
  request({ origin: 'http://localhost:5173', cookie: 'rdf_session=test-only' }),
  request({ referer: 'http://localhost:5173/#/sessions', cookie: 'rdf_session=test-only' }),
  request({ host: '127.0.0.1:5173', origin: 'http://127.0.0.1:5173' }),
  request({ host: '[::1]:5173', origin: 'http://[::1]:5173' }),
  request(),
  request({ authorization: 'Bearer test-only', cookie: 'rdf_session=test-only' }),
];

test('HTTP boundary accepts local browser requests and explicit API authentication', () => {
  const guard = boundary();
  for (const req of allowedRequests) {
    assert.deepEqual(guard.http(req), { next: true, status: undefined, body: undefined });
  }
});

test('HTTP boundary rejects foreign origins, hosts and source-less cookies', () => {
  const guard = boundary();
  for (const req of blockedRequests) {
    const result = guard.http(req);
    assert.equal(result.next, false);
    assert.equal(result.status, 403);
  }
  // Exact API root, query string and descendants receive the same protection.
  for (const url of ['/api', '/api?format=json', '/api/sessions/example/stream']) {
    assert.equal(guard.http(request({ origin: 'https://unrelated.example' }, url)).status, 403);
  }
  assert.equal(guard.http(request({ origin: 'https://unrelated.example' }, '/@vite/client')).next, true);
});

test('WebSocket boundary rejects foreign sources without blocking Vite HMR', () => {
  const guard = boundary();
  for (const req of blockedRequests) assert.equal(guard.upgrade(req), true);
  for (const req of allowedRequests) assert.equal(guard.upgrade(req), false);
  assert.equal(guard.upgrade(request({ origin: 'https://unrelated.example' }, '/?token=hmr')), false);
});

test('HTTP and WebSocket proxy hooks rewrite only validated local request origins', () => {
  const emitter = new EventEmitter();
  liveProxy(options).proxy.configure(emitter);
  for (const event of ['proxyReq', 'proxyReqWs']) {
    for (const req of allowedRequests) {
      const headers = {};
      let destroyed = false;
      emitter.emit(event, {
        setHeader(name, value) { headers[name] = value; },
        destroy() { destroyed = true; },
      }, req);
      assert.equal(destroyed, false);
      assert.equal(headers.origin, options.target);
      assert.equal(headers.referer, req.headers.referer ? `${options.target}/` : undefined);
    }
    for (const req of blockedRequests) {
      let destroyed = false;
      emitter.emit(event, {
        setHeader() { assert.fail('A rejected request must never receive a trusted Origin'); },
        destroy() { destroyed = true; },
      }, req);
      assert.equal(destroyed, true);
    }
  }
});

test('TLS validation is enabled unless the caller explicitly opts out', () => {
  const proxy = liveProxy(options).proxy;
  assert.equal(proxy.target, options.target);
  assert.equal(proxy.ws, true);
  assert.equal(proxy.changeOrigin, true);
  assert.equal(proxy.secure, true);
  assert.equal(liveProxy({ ...options, insecure: false }).proxy.secure, true);
  assert.equal(liveProxy({ ...options, insecure: true }).proxy.secure, false);
});

test('upstream target rejects credentials, non-HTTP protocols, paths and query strings', () => {
  for (const target of [
    'https://user:password@example.test',
    'https://user@example.test',
    'ftp://example.test',
    'https://example.test/api',
    'https://example.test?token=test-only',
    'https://example.test#fragment',
  ]) {
    assert.throws(() => liveProxy({ ...options, target }), /HTTP\(S\) origin without credentials or path/);
  }
  assert.equal(liveProxy({ ...options, target: 'http://127.0.0.1:8080/' }).proxy.target, 'http://127.0.0.1:8080');
});
