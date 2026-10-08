import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DockerClient } from './docker.mjs';
import { progressReporter } from './startup-progress.mjs';
import { ControlClient, createControlServer } from './control-ipc.mjs';

const socketPath = () => process.platform === 'win32' ? '\\\\.\\pipe\\rdf-progress-' + randomUUID() : path.join(os.tmpdir(), 'rdf-progress-' + randomUUID() + '.sock');
async function dockerServer(handler) {
  const socket = socketPath(), server = http.createServer(handler);
  await new Promise(resolve => server.listen(socket, resolve));
  return { docker: new DockerClient(socket), close: () => new Promise(resolve => server.close(resolve)) };
}

test('Docker progress parses fragmented NDJSON and final JSON without waiting for body completion', async () => {
  let continueStream;
  const gate = new Promise(resolve => { continueStream = resolve; });
  const fixture = await dockerServer(async (req, res) => {
    res.writeHead(200); res.write('{"status":"Down');
    res.write('loading","progressDetail":{"current":4,"total":8}}\n');
    await gate;
    res.end('{"status":"Download complete"}');
  });
  try {
    const events = [];
    await fixture.docker._request('POST', '/pull', undefined, { onJsonEvent: event => { events.push(event); continueStream(); } });
    assert.equal(events.length, 2); assert.equal(events[0].progressDetail.current, 4);
    assert.equal(events[1].status, 'Download complete');
  } finally { await fixture.close(); }
});

test('Docker streaming rejects a single JSON error and oversized progress records', async () => {
  for (const [body, error] of [['{"errorDetail":{"message":"registry access denied"}}', /registry access denied/], ['x'.repeat(256 * 1024 + 1), /progress event exceeds limit/]]) {
    const fixture = await dockerServer((req, res) => res.end(body));
    try { await assert.rejects(fixture.docker._request('POST', '/pull', undefined, { onJsonEvent() {} }), error); }
    finally { await fixture.close(); }
  }
});

test('Docker build HTTP errors abort at one MiB despite a large streaming budget', async () => {
  let closed;
  const disconnected = new Promise(resolve => { closed = resolve; });
  const fixture = await dockerServer((req, res) => {
    res.on('close', closed);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    // Leave the response open: the client must reject at the error-body limit,
    // not wait for EOF or its ordinary one-GiB build-stream limit.
    res.write(Buffer.alloc(1024 * 1024 + 1, 120));
  });
  try {
    await assert.rejects(fixture.docker._request('POST', '/build', undefined, {
      maxBytes: 1024 * 1024 * 1024, timeoutMs: 2000,
      onJsonEvent() { assert.fail('HTTP error bodies are not progress events'); },
    }), /Docker API HTTP 500 error response too large/);
    await disconnected;
  } finally { await fixture.close(); }
});

test('Docker build HTTP errors preserve the daemon message below the body limit', async () => {
  const fixture = await dockerServer((req, res) => {
    res.writeHead(403); res.end(JSON.stringify({ message: 'build denied by daemon policy' }));
  });
  try {
    await assert.rejects(fixture.docker._request('POST', '/build', undefined, {
      maxBytes: 1024 * 1024 * 1024, onJsonEvent() { assert.fail('Not a progress event'); },
    }), /build denied by daemon policy/);
  } finally { await fixture.close(); }
});

test('Docker cached images never pull; uncached progress uses actual byte counts', async () => {
  const docker = new DockerClient('/unused'); let pulls = 0, checks = 0; const progress = [];
  docker.request = async (method, url, body, options) => {
    if (method === 'GET') { checks++; if (checks === 1) throw new Error('404 No such image'); return {}; }
    pulls++;
    options.onJsonEvent({ status: 'Pulling fs layer', id: 'one' });
    options.onJsonEvent({ status: 'Downloading', id: 'one', progressDetail: { current: 25, total: 100 } });
    options.onJsonEvent({ status: 'Downloading', id: 'two', progressDetail: { current: 5, total: 50 } });
  };
  await docker.ensureImage('example/image:1', event => progress.push(event));
  assert.equal(pulls, 1);
  assert.deepEqual(progress.at(-1), { stage: 'downloading', detail: 'Downloading', currentBytes: 30, totalBytes: 150, percent: 20 });
  assert.equal(progress.find(event => event.detail === 'Pulling fs layer').percent, undefined);
  await docker.ensureImage('example/image:1'); assert.equal(pulls, 1);
  docker.request = async method => { if (method === 'GET') throw new Error('No such image'); return { error: 'single-object pull failure' }; };
  await assert.rejects(docker.ensureImage('example/image:2'), /single-object pull failure/);
});

test('agent Docker client exposes no SDK build operation', () => {
  assert.equal(new DockerClient('/unused').buildImage, undefined);
});

test('progress throttles same-stage chatter and bounds details without invented percentages', () => {
  let now = 0; const events = [], report = progressReporter(event => events.push(event), { now: () => now });
  report({ stage: 'checking_image' }); report({ stage: 'checking_image' });
  report({ stage: 'downloading', detail: 'x'.repeat(800), currentBytes: 5, totalBytes: 0 });
  now = 300; report({ stage: 'downloading', currentBytes: 8, totalBytes: 20, percent: 40 });
  report({ stage: 'booting' });
  assert.equal(events.length, 4); assert.equal(events[1].detail.length, 512);
  assert.equal(events[0].percent, undefined); assert.equal(events.at(-1).percent, undefined);
});

test('IPC carries progress before the final response and disconnect aborts the in-flight operation', async () => {
  const socket = socketPath(); let aborted;
  const server = await createControlServer({ handle: async (request, { onProgress, signal }) => {
    onProgress({ stage: 'checking_image' }); onProgress({ stage: 'downloading', currentBytes: 3, totalBytes: 10 });
    if (request.sessionId === 'session-cancel') {
      await new Promise(resolve => { signal.addEventListener('abort', () => { aborted = true; resolve(); }, { once: true }); });
    }
    return { created: true };
  } }, socket);
  const client = new ControlClient(socket), profile = { image: 'example/android:1', cpu: 2, memoryMb: 4096, diskGb: 8 }, key = 'QUJDRA== rdf@farm';
  try {
    const events = [];
    assert.deepEqual(await client.start('session-good', profile, key, event => events.push(event)), { created: true });
    assert.deepEqual(events.map(event => event.stage), ['checking_image', 'downloading']);
    const controller = new AbortController();
    await assert.rejects(client.start('session-cancel', profile, key, () => controller.abort(new Error('cancelled by test')), { signal: controller.signal }), /cancelled by test/);
    await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(aborted, true);
  } finally { await new Promise(resolve => server.close(resolve)); }
});


for (const requestPath of ['/build', '/images/rdf-emulator/push?tag=test']) {
  test(`cancelling ${requestPath} closes the actual streaming Docker connection`, { timeout: 5000 }, async () => {
    let closed;
    const disconnected = new Promise(resolve => { closed = resolve; });
    const controller = new AbortController();
    const fixture = await dockerServer((req, res) => {
      assert.equal(req.url, requestPath);
      res.on('close', closed);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.write('{"status":"Working"}\n');
      // Never send EOF. Abort must end this stream, not wait for the build timeout.
    });
    try {
      await assert.rejects(fixture.docker._request('POST', requestPath, undefined, {
        signal: controller.signal, timeoutMs: 3000,
        onJsonEvent() { controller.abort(new Error('Selected image build cancelled')); },
      }), /cancelled|aborted/);
      await disconnected;
    } finally { controller.abort(); await fixture.close(); }
  });
}
