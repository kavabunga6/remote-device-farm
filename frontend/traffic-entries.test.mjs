import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
const bundle = await build({ entryPoints: [fileURLToPath(new URL('./src/tools/traffic-entries.ts', import.meta.url))], bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent' });
const { filterTraffic, trafficTree, trafficAddress, trafficPhase } = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].contents).toString('base64'));
const entry = (id, url, extra = {}) => ({ id, url, method: 'GET', status: 200, durationMs: 42, bytes: 1200, startedAt: id, requestHeaders: [], responseHeaders: [], ...extra });
const rows = [
  entry(3, 'http://api.example.test/api/v1/orders?token=%5Bredacted%5D', { status: 503 }),
  entry(1, 'http://api.example.test/api/v1/items'),
  entry(4, 'https://secure.example.test:8443', { method: 'CONNECT', status: null, durationMs: null }),
  entry(2, 'http://assets.example.test/image.png'),
];
test('filters distinguish HTTP requests, encrypted tunnels and HTTP failures', () => {
  assert.deepEqual(filterTraffic(rows, '', 'all').map(row => row.id), [1, 2, 3, 4]);
  assert.deepEqual(filterTraffic(rows, '', 'http').map(row => row.id), [1, 2, 3]);
  assert.deepEqual(filterTraffic(rows, '', 'tunnels').map(row => row.id), [4]);
  assert.deepEqual(filterTraffic(rows, '', 'errors').map(row => row.id), [3]);
  assert.deepEqual(rows.map(row => row.id), [3, 1, 4, 2]);
});
test('search combines host, path, method and status terms without treating them as regex', () => {
  assert.deepEqual(filterTraffic(rows, 'GET API.example 503 [redacted]', 'all').map(row => row.id), [3]);
  assert.equal(filterTraffic(rows, '.*', 'all').length, 0);
  assert.equal(filterTraffic(rows, 'items', 'errors').length, 0);
  assert.doesNotThrow(() => filterTraffic([entry(1, 'http://example.test/%ZZ')], '%ZZ', 'all'));
});
test('structure groups host and real path directories, keeping queries out of the hierarchy', () => {
  const tree = trafficTree([...rows, entry(5, 'http://api.example.test/api/v1/items?next=https://other.test/a/b')]);
  const host = tree.find(node => node.label === 'http://api.example.test');
  assert.equal(host.count, 3);
  assert.equal(host.children.length, 1);
  assert.equal(host.children[0].label, 'api/');
  const v1 = host.children[0].children[0];
  assert.equal(v1.label, 'v1/');
  assert.equal(v1.children.length, 0);
  assert.ok(v1.entries.some(item => item.label === 'items?next=https://other.test/a/b'));
  const tunnel = tree.find(node => node.label === 'https://secure.example.test:8443');
  assert.equal(tunnel.children.length, 0);
  assert.equal(tunnel.entries[0].entry.method, 'CONNECT');
});
test('deep paths are bounded and retain every path segment in the leaf', () => {
  const segments = Array.from({ length: 40 }, (_, n) => 'segment' + n);
  let node = trafficTree([entry(1, 'http://example.test/' + segments.join('/'))])[0];
  let depth = 0;
  while (node.children.length) { node = node.children[0]; depth++; }
  assert.equal(depth, 8);
  assert.equal(node.entries[0].label, segments.slice(8).join('/'));
});
test('IPv6 authorities, invalid addresses and pending transfers remain inspectable', () => {
  assert.equal(trafficAddress(entry(1, 'https://[2001:db8::1]:8443/a')).host, '[2001:db8::1]:8443');
  assert.equal(trafficAddress(entry(1, 'not a URL')).path, 'not a URL');
  assert.equal(trafficPhase(rows[0]), 'error');
  assert.equal(trafficPhase(rows[1]), 'complete');
  assert.equal(trafficPhase(rows[2]), 'pending');
});
