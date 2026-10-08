import test from 'node:test';
import assert from 'node:assert/strict';
import { tarArchive } from './tar-archive.mjs';
import { archiveFile } from './docker-archive.mjs';
async function* chunks(data, step = 23) { for (let offset = 0; offset < data.length; offset += step) yield data.subarray(offset, offset + step); }
const collect = async (data, limit) => { const pieces = []; for await (const chunk of archiveFile(chunks(data), 'rdf-image.tar', limit)) pieces.push(chunk); return Buffer.concat(pieces); };
test('Docker archive extraction handles fragmented headers, payload and padding with backpressure', async () => {
  const data = Buffer.alloc(1400, 17), tar = tarArchive([{ name: 'rdf-image.tar', mode: 0o600, data }]);
  assert.deepEqual(await collect(tar), data);
});
test('archive extraction rejects wrong files, duplicates, oversized payloads, corruption and truncation', async () => {
  const file = { name: 'rdf-image.tar', mode: 0o600, data: Buffer.from('abc') }, valid = tarArchive([file]);
  for (const archive of [tarArchive([{ ...file, name: 'other.tar' }]), tarArchive([file, file]), valid.subarray(0, 514)]) await assert.rejects(collect(archive));
  await assert.rejects(collect(valid, 2));
  const corrupt = Buffer.from(valid); corrupt[2] ^= 1; await assert.rejects(collect(corrupt), /invalid_header/);
});

import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DockerClient } from './docker.mjs';
async function transport(handler) {
  const socketPath = process.platform === 'win32' ? '\\\\.\\pipe\\rdf-image-import-' + randomUUID() : path.join(os.tmpdir(), 'rdf-image-import-' + randomUUID() + '.sock');
  const server = http.createServer((request, response) => {
    if (request.url.endsWith('/version')) { response.end(JSON.stringify({ ApiVersion: '1.54' })); return; }
    void handler(request, response);
  });
  await new Promise(resolve => server.listen(socketPath, resolve));
  return { docker: new DockerClient(socketPath), close: async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}
test('the real Docker transport streams only image contents into load and verifies final JSON progress', async () => {
  const payload = Buffer.alloc(2 * 1024 ** 2, 27), archive = tarArchive([{ name: 'rdf-image.tar', mode: 0o600, data: payload }]);
  let received = 0;
  const fixture = await transport(async (request, response) => {
    if (request.url.includes('/archive?')) { response.writeHead(200); response.end(archive); return; }
    assert.equal(request.url, '/v1.54/images/load?quiet=1');
    assert.equal(request.headers['content-type'], 'application/x-tar');
    for await (const chunk of request) { assert.ok(chunk.every(byte => byte === 27)); received += chunk.length; }
    response.end('{"stream":"Loaded image"}\n');
  });
  try { await fixture.docker.importImageArchive('worker'); assert.equal(received, payload.length); }
  finally { await fixture.close(); }
});
test('abort stops both the archive producer and load request while output is incomplete', { timeout: 5000 }, async () => {
  const controller = new AbortController(); let producerClosed, consumerClosed;
  const producer = new Promise(resolve => { producerClosed = resolve; }), consumer = new Promise(resolve => { consumerClosed = resolve; });
  const full = tarArchive([{ name: 'rdf-image.tar', mode: 0o600, data: Buffer.alloc(1024 ** 2, 17) }]);
  const fixture = await transport(async (request, response) => {
    if (request.url.includes('/archive?')) { response.on('close', producerClosed); response.writeHead(200); response.write(full.subarray(0, 1536)); return; }
    request.on('close', consumerClosed); request.on('data', () => controller.abort(new Error('test cancellation')));
  });
  try { await assert.rejects(fixture.docker.importImageArchive('worker', { signal: controller.signal }), /test cancellation/); await Promise.all([producer, consumer]); }
  finally { await fixture.close(); }
});
