import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, copyFile, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createSession } from '../../examples/appium/client.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
const key = 'element-6066-11e4-a52e-4f735466cecf';
async function temporary(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'rdf-appium-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
async function server(t, handler) {
  const requests = [];
  const instance = http.createServer(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk;
    requests.push({ method: req.method, path: req.url, body: text ? JSON.parse(text) : undefined });
    const result = handler(requests.at(-1), requests.length);
    if (result === 'hang') return;
    res.writeHead(result.status ?? 200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ value: result.value }));
  });
  await new Promise(resolve => instance.listen(0, '127.0.0.1', resolve));
  t.after(() => { instance.closeAllConnections(); return new Promise(resolve => instance.close(resolve)); });
  return { port: instance.address().port, requests };
}

test('Appium smoke client uses W3C session/element commands, waits, captures PNG and deletes session', async t => {
  let lookups = 0;
  const f = await server(t, req => {
    if (req.path === '/session') return { value: { sessionId: 'test session' } };
    if (req.path.endsWith('/element')) return ++lookups === 1
      ? { status: 404, value: { error: 'no such element', message: 'not ready' } }
      : { value: { [key]: 'network/internet' } };
    if (req.path.endsWith('/displayed')) return { value: true };
    if (req.path.endsWith('/screenshot')) return { value: png.toString('base64') };
    return { value: null };
  });
  const capabilities = { platformName: 'Android', 'appium:udid': '127.0.0.1:15555' };
  const session = await createSession({ port: f.port, capabilities });
  await session.waitForDisplayed('new UiSelector().text("Settings")');
  const dir = await temporary(t);
  await session.saveScreenshot(path.join(dir, 'screen.png'));
  await session.deleteSession();
  assert.deepEqual(f.requests[0].body, { capabilities: { alwaysMatch: capabilities, firstMatch: [{}] } });
  assert.equal(f.requests[1].body.using, '-android uiautomator');
  assert.equal(f.requests[3].path, '/session/test%20session/element/network%2Finternet/displayed');
  assert.deepEqual(await readFile(path.join(dir, 'screen.png')), png);
  assert.equal(f.requests.at(-1).method, 'DELETE');
});

test('Appium client fails immediately on invalid selector and rejects malformed screenshots', async t => {
  const f = await server(t, req => req.path === '/session' ? { value: { sessionId: 'one' } }
    : req.path.endsWith('/screenshot') ? { value: 'not-a-png' }
      : { status: 400, value: { error: 'invalid selector', message: 'selector syntax' } });
  const session = await createSession({ port: f.port, capabilities: {} });
  await assert.rejects(session.waitForDisplayed('bad'), { message: 'selector syntax', code: 'invalid selector' });
  await assert.rejects(session.saveScreenshot('unused.png'), /invalid PNG/);
  assert.equal(f.requests.length, 3);
});

test('Appium client cancels pending requests but still deletes the session after test timeout', async t => {
  const f = await server(t, req => req.path === '/session' ? { value: { sessionId: 'one' } }
    : req.method === 'DELETE' ? { value: null } : 'hang');
  const controller = new AbortController();
  const session = await createSession({ port: f.port, capabilities: {}, signal: controller.signal });
  const pending = session.waitForDisplayed('Settings');
  controller.abort(new Error('test timed out'));
  await assert.rejects(pending, /test timed out/);
  await session.deleteSession();
  assert.equal(f.requests.at(-1).method, 'DELETE');
});

test('Appium client rejects malformed session replies and honors the element deadline', async t => {
  const malformed = await server(t, () => ({ value: {} }));
  await assert.rejects(createSession({ port: malformed.port, capabilities: {} }), /session ID/);
  const f = await server(t, req => req.path === '/session' ? { value: { sessionId: 'one' } }
    : { status: 404, value: { error: 'no such element', message: 'not ready' } });
  const session = await createSession({ port: f.port, capabilities: {} });
  await assert.rejects(session.waitForDisplayed('missing', { timeout: 25 }), /not displayed within 25 ms/);
});


test('Appium element deadline cancels stalled lookup and displayed requests with a search error', async t => {
  for (const stalledRoute of ['/element', '/displayed']) {
    await t.test(stalledRoute, async t => {
      const deadline = new AbortController();
      const timeout = AbortSignal.timeout.bind(AbortSignal);
      t.mock.method(AbortSignal, 'timeout', ms => ms === 25 ? deadline.signal : timeout(ms));
      const started = Promise.withResolvers();
      t.mock.method(globalThis, 'fetch', async (url, options) => {
        if (url.endsWith('/session')) return Response.json({ value: { sessionId: 'one' } });
        if (url.endsWith(stalledRoute)) {
          return new Promise((resolve, reject) => {
            options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
            started.resolve(options.signal);
          });
        }
        return Response.json({ value: { [key]: 'settings' } });
      });
      const session = await createSession({ capabilities: {} });
      const waiting = session.waitForDisplayed('Settings', { timeout: 25 });
      const requestSignal = await started.promise;
      assert.equal(requestSignal.aborted, false);
      const rejected = assert.rejects(waiting, /Element was not displayed within 25 ms: Settings/);
      deadline.abort(new DOMException('Controlled element deadline', 'TimeoutError'));
      await rejected;
      assert.equal(requestSignal.aborted, true);
    });
  }
});

test('Appium element deadline preserves explicit cancellation even when it is a TimeoutError', async t => {
  const controller = new AbortController();
  const started = Promise.withResolvers();
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url.endsWith('/session')) return Response.json({ value: { sessionId: 'one' } });
    return new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
      started.resolve();
    });
  });
  const session = await createSession({ capabilities: {}, signal: controller.signal });
  const waiting = session.waitForDisplayed('Settings');
  await started.promise;
  const reason = new DOMException('Caller test deadline', 'TimeoutError');
  const rejected = assert.rejects(waiting, error => error === reason);
  controller.abort(reason);
  await rejected;
});


test('Appium request timeout remains a transport error before the element deadline', async t => {
  const requestTimeout = new AbortController();
  const timeout = AbortSignal.timeout.bind(AbortSignal);
  t.mock.method(AbortSignal, 'timeout', ms => ms === 5000 ? requestTimeout.signal : timeout(ms));
  const started = Promise.withResolvers();
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url.endsWith('/session')) return Response.json({ value: { sessionId: 'one' } });
    return new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
      started.resolve();
    });
  });
  const session = await createSession({ capabilities: {} });
  const waiting = session.waitForDisplayed('Settings');
  await started.promise;
  const reason = new DOMException('Appium request timed out', 'TimeoutError');
  const rejected = assert.rejects(waiting, error => error === reason);
  requestTimeout.abort(reason);
  await rejected;
});

async function unusedPort() {
  const instance = net.createServer();
  await new Promise(resolve => instance.listen(0, '127.0.0.1', resolve));
  const port = instance.address().port;
  await new Promise(resolve => instance.close(resolve));
  return port;
}
async function runner(t, mode) {
  const dir = await temporary(t);
  await mkdir(path.join(dir, 'node_modules/appium'), { recursive: true });
  await mkdir(path.join(dir, 'artifacts'));
  for (const file of ['run.mjs', 'process.mjs']) await copyFile(path.join(root, 'examples/appium', file), path.join(dir, file));
  await writeFile(path.join(dir, 'package.json'), '{"type":"module"}');
  for (const name of ['appium.log', 'appium.xml', 'settings-home.png', 'failure.png', 'other.log']) {
    await writeFile(path.join(dir, 'artifacts', name), 'stale');
  }
  await writeFile(path.join(dir, 'node_modules/appium/index.js'), `
    const http = require('node:http');
    if (process.env.RDF_TOKEN) throw new Error('farm token leaked');
    if (process.env.MOCK_MODE === 'fail') { console.error('startup fixture failure'); process.exit(12); }
    const port = Number(process.argv[process.argv.indexOf('--port') + 1]);
    http.createServer((req,res)=> {res.setHeader('Content-Type','application/json');res.end(JSON.stringify({value:{ready:true}}));}).listen(port,'127.0.0.1');
    console.log('Appium fixture listening');
  `);
  await writeFile(path.join(dir, 'settings.test.mjs'), `
    import test from 'node:test'; import assert from 'node:assert/strict';
    test('smoke fixture',()=> {assert.equal(process.env.RDF_TOKEN,undefined); assert.equal(process.env.ANDROID_SERIAL,'example:15555'); if(process.env.MOCK_MODE==='test-fail') throw new Error('test fixture failure');});
  `);
  const port = await unusedPort();
  let occupied;
  if (mode === 'busy') {
    occupied = net.createServer();
    await new Promise(resolve => occupied.listen(port, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => occupied.close(resolve)));
  }
  if (mode === 'locked') await writeFile(path.join(dir, 'artifacts/.appium.lock'), 'someone else');
  const child = spawn(process.execPath, [path.join(dir, 'run.mjs')], {
    cwd: dir, env: { ...process.env, MOCK_MODE: mode, APPIUM_PORT: String(port), ANDROID_SERIAL: 'example:15555',
      RDF_ARTIFACTS_DIR: path.join(dir, 'artifacts'), RDF_TOKEN: 'must-not-reach-child' }, windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  const result = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => resolve(code)); });
  // The runner owns this local Appium port and must close it before it exits.
  if (!occupied) {
  const probe = net.createServer();
  await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(port, '127.0.0.1', resolve); });
  await new Promise(resolve => probe.close(resolve));
  }
  return { result, output, artifacts: path.join(dir, 'artifacts') };
}

test('Appium runner cleans old reports/screenshots, preserves unrelated artifacts and closes its server', { timeout: 15000 }, async t => {
  const f = await runner(t, 'success');
  assert.equal(f.result, 0, f.output);
  assert.deepEqual((await readdir(f.artifacts)).sort(), ['appium.log', 'appium.xml', 'other.log']);
  assert.match(await readFile(path.join(f.artifacts, 'appium.xml'), 'utf8'), /smoke fixture/);
});

test('Appium startup failure cannot publish an earlier successful report', { timeout: 15000 }, async t => {
  const f = await runner(t, 'fail');
  assert.equal(f.result, 1, f.output);
  assert.deepEqual((await readdir(f.artifacts)).sort(), ['appium.log', 'other.log']);
  assert.match(await readFile(path.join(f.artifacts, 'appium.log'), 'utf8'), /startup fixture failure/);
});

test('Appium runner preserves a failing test result and publishes its JUnit report', { timeout: 15000 }, async t => {
  const f = await runner(t, 'test-fail');
  assert.equal(f.result, 1, f.output);
  assert.match(await readFile(path.join(f.artifacts, 'appium.xml'), 'utf8'), /test fixture failure/);
});


test('Appium busy port leaves no old logs or success report and releases its artifact lock', { timeout: 15000 }, async t => {
  const f = await runner(t, 'busy');
  assert.equal(f.result, 1, f.output);
  assert.match(f.output, /port .* is busy/);
  assert.deepEqual(await readdir(f.artifacts), ['other.log']);
});

test('Appium refuses a shared artifact directory without erasing another run outputs or lock', { timeout: 15000 }, async t => {
  const f = await runner(t, 'locked');
  assert.equal(f.result, 1, f.output);
  assert.match(f.output, /artifacts are locked/);
  assert.deepEqual((await readdir(f.artifacts)).sort(), ['.appium.lock', 'appium.log', 'appium.xml', 'failure.png', 'other.log', 'settings-home.png']);
  assert.equal(await readFile(path.join(f.artifacts, 'appium.xml'), 'utf8'), 'stale');
  assert.equal(await readFile(path.join(f.artifacts, '.appium.lock'), 'utf8'), 'someone else');
});
