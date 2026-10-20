import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, rm, access } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ManagedAppium, sessionCapabilities, validateAppiumRequest, assertAppiumAndroid } from './managed-appium.mjs';

test('Appium pins the device and rejects host paths, downloads, external servers and shell execution', () => {
  assert.doesNotThrow(() => assertAppiumAndroid(26));
  assert.throws(() => assertAppiumAndroid(25));
  assert.throws(() => assertAppiumAndroid(null));
  const capabilities = alwaysMatch => ({ capabilities: { alwaysMatch } });
  const caps = sessionCapabilities(capabilities({ 'appium:appPackage': 'com.android.settings', 'appium:deviceName': 'Android Emulator' }), 'rdf-owned:5555', 8201);
  assert.equal(caps.capabilities.alwaysMatch['appium:udid'], 'rdf-owned:5555');
  for (const item of [{ 'appium:udid': 'another-device' }, { 'appium:app': '/etc/passwd' },
    { 'appium:remoteAdbHost': 'other-host' }, { 'appium:chromedriverExecutable': '/tmp/run' },
    { 'appium:systemPort': 1234 }, { 'appium:settings': {} }, { 'appium:newCommandTimeout': 0 }])
    assert.throws(() => sessionCapabilities(capabilities(item), 'rdf-owned:5555', 8201));
  for (const item of [{ method: 'GET', path: '/sessions' }, { method: 'POST', path: '/session/id/../../session' },
    { method: 'POST', path: '/session/id/execute/sync', body: { script: 'mobile: shell', args: [{ command: 'id' }] } },
    { method: 'GET', path: '/session/id/source?host=other' }]) assert.throws(() => validateAppiumRequest(item));
  assert.ok(validateAppiumRequest({ method: 'POST', path: '/session/id/element', body: { using: 'id', value: 'login' } }));
});

test('JavaScript is limited to a confirmed web context and executable capabilities stay broker-owned', async () => {
  assert.equal(sessionCapabilities({ capabilities: { alwaysMatch: { browserName: 'Chrome', 'appium:autoWebview': true } } }, 'owned', 8201).capabilities.alwaysMatch.browserName, 'Chrome');
  for (const input of [{ 'appium:chromedriverExecutableDir': '/host' }, { 'appium:chromedriverChromeMappingFile': '/host/map' }, { browserName: 'Safari' }])
    assert.throws(() => sessionCapabilities({ capabilities: { alwaysMatch: input } }, 'owned', 8201));
  const directory = await mkdtemp(path.join(os.tmpdir(), 'rdf-appium-'));
  let context = 'NATIVE_APP', executions = 0;
  const manager = new ManagedAppium({ entry: process.execPath, fetchImpl: async url => {
    if (url.endsWith('/context')) return new Response(JSON.stringify({ value: context }));
    executions++; return new Response(JSON.stringify({ value: 2 }));
  } });
  manager.workers.set('session', { origin: 'http://127.0.0.1:4723', driverId: 'owned', signal: new AbortController().signal, life: new AbortController(), directory });
  const request = { method: 'POST', path: '/session/owned/execute/sync', body: { script: 'return 1 + 1', args: [] } };
  try {
    await assert.rejects(manager.request('session', 'owned-device', request));
    assert.equal(executions, 0);
    context = 'WEBVIEW_example';
    assert.equal((await manager.request('session', 'owned-device', request)).body.value, 2);
    assert.equal(executions, 1);
    await assert.rejects(manager.request('session', 'owned-device', { ...request, body: { script: 'mobile: shell', args: [] } }));
    assert.equal(executions, 1);
  } finally { await manager.close(); }
});

test('loopback workers bind one driver, redact upstream errors and terminate with their lease', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rdf-appium-test-'));
  const directory = path.join(root, 'node_modules', 'appium');
  await mkdir(directory, { recursive: true });
  const entry = path.join(directory, 'index.cjs');
  await writeFile(entry, "const http=require('node:http');const p=process.argv[process.argv.indexOf('--port')+1];http.createServer(async(req,res)=>{for await(const c of req){}res.setHeader('content-type','application/json');if(req.url==='/status')return res.end(JSON.stringify({value:{ready:true}}));if(req.url==='/session')return res.end(JSON.stringify({value:{sessionId:'driver-owned',capabilities:{}}}));if(req.url.endsWith('/source'))return res.end(JSON.stringify({value:'<hierarchy/>'}));if(req.url.endsWith('/element')){res.statusCode=404;return res.end(JSON.stringify({value:{error:'no such element',message:'private host path',stacktrace:'private stack'}}));}res.end(JSON.stringify({value:null}));}).listen(p,'127.0.0.1');");
  const manager = new ManagedAppium({ entry, startTimeoutMs: 10_000 });
  const signal = new AbortController();
  try {
    const creating = manager.request('owned', 'device-1', { method: 'POST', path: '/session', body: { capabilities: { alwaysMatch: {} } } }, { signal: signal.signal });
    await assert.rejects(manager.request('owned', 'device-1', { method: 'POST', path: '/session', body: { capabilities: { alwaysMatch: {} } } }), /already active/);
    const created = await creating;
    assert.equal(created.body.value.sessionId, 'driver-owned');
    const worker = manager.workers.get('owned'), temporary = worker.directory;
    await assert.rejects(manager.request('owned', 'device-1', { method: 'POST', path: '/session', body: { capabilities: { alwaysMatch: {} } } }));
    await assert.rejects(manager.request('owned', 'device-1', { method: 'GET', path: '/session/driver-other/source' }));
    assert.equal(manager.workers.get('owned'), worker);
    const source = await manager.request('owned', 'device-1', { method: 'GET', path: '/session/driver-owned/source' });
    assert.equal(source.body.value, '<hierarchy/>');
    const error = await manager.request('owned', 'device-1', { method: 'POST', path: '/session/driver-owned/element', body: { using: 'id', value: 'missing' } });
    assert.equal(error.status, 404);
    assert.ok(!JSON.stringify(error).includes('private'));
    const deletion = await manager.request('owned', 'device-1', { method: 'DELETE', path: '/session/driver-owned' });
    assert.equal(deletion.status, 200);
    assert.equal(manager.workers.size, 0);
    await assert.rejects(access(temporary));
    await assert.rejects(manager.request('owned', 'device-1', { method: 'GET', path: '/session/driver-other/source' }));
    signal.abort();
    await assert.rejects(manager.request('owned', 'device-1', { method: 'POST', path: '/session', body: { capabilities: { alwaysMatch: {} } } }, { signal: signal.signal }));
    assert.equal(manager.workers.size, 0);
  } finally {
    await manager.close();
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('rdf-appium-test-'));
    await rm(root, { recursive: true, force: true });
  }
});
