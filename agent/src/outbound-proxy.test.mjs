import test from 'node:test';
import assert from 'node:assert/strict';
import { validateOutboundProxy, proxyAddress, proxyEnvironment, proxySecrets, proxyFingerprint } from './outbound-proxy.mjs';
import { validateControlRequest } from './control-ipc.mjs';

const proxy = { url: 'https://proxy.example:8443', username: 'build user', password: 'p @:#%word' };
test('proxy input is bounded and only accepts credential-free HTTP(S) endpoints', () => {
  assert.equal(validateOutboundProxy(undefined), null);
  assert.deepEqual(validateOutboundProxy(proxy), proxy);
  for (const url of ['socks5://proxy.example', 'file:///etc/passwd', 'http://user:pass@proxy.example', 'http://proxy.example/path', 'http://proxy.example/#x', 'http://proxy.example?x=1', ' http://proxy.example']) {
    assert.throws(() => validateOutboundProxy({ ...proxy, url }), /invalid_outbound_proxy/);
  }
  for (const patch of [{ username: 'a:b' }, { password: 'bad\r\nvalue' }, { password: 'x'.repeat(1001) }, { surprise: true }, { username: '' }]) {
    assert.throws(() => validateOutboundProxy({ ...proxy, ...patch }), /invalid_outbound_proxy/);
  }
  const parsed = new URL(proxyAddress(proxy));
  assert.equal(decodeURIComponent(parsed.username), proxy.username);
  assert.equal(decodeURIComponent(parsed.password), proxy.password);
  assert.equal(proxyEnvironment(null).length, 0); assert.equal(proxyEnvironment(proxy).length, 4);
  assert.ok(proxySecrets(proxy).includes(proxy.password));
  assert.notEqual(proxyFingerprint(proxy), proxyFingerprint({ ...proxy, password: 'different' }));
});

test('catalog and build IPC accept validated proxy settings while other commands reject them', () => {
  assert.deepEqual(validateControlRequest({ op: 'emulatorCatalog', refresh: false, proxy }).proxy, proxy);
  assert.throws(() => validateControlRequest({ op: 'emulatorCatalog', refresh: false, proxy: { ...proxy, url: 'file:///tmp' } }), /invalid_outbound_proxy/);
  assert.throws(() => validateControlRequest({ op: 'emulatorJobs', proxy }), /Invalid|Unexpected|request/i);
});

test('NO_PROXY is normalized, bounded and forwarded in both environment spellings', () => {
  const value = validateOutboundProxy({ ...proxy, noProxy: ' localhost, .Example.COM,127.0.0.1, [::1],localhost ' });
  assert.equal(value.noProxy, 'localhost,example.com,127.0.0.1,::1');
  assert.ok(proxyEnvironment(value).includes('NO_PROXY=' + value.noProxy));
  assert.ok(proxyEnvironment(value).includes('no_proxy=' + value.noProxy));
  assert.notEqual(proxyFingerprint(proxy), proxyFingerprint(value));
  for (const noProxy of ['http://example.com', 'name:80', '10.0.0.0/8', 'user@host', '*.example.com', 'bad\nvalue', 'x'.repeat(4097), null]) {
    assert.throws(() => validateOutboundProxy({ ...proxy, noProxy }), /invalid_outbound_proxy/);
  }
  assert.equal(validateOutboundProxy({ ...proxy, noProxy: '*' }).noProxy, '*');
});
