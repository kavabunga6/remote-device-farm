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
