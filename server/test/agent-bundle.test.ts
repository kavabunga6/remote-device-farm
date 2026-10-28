import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { registerAgentBundleRoutes } from '../src/routes/agent-bundle-routes.js';
import { ApiError } from '../src/http-common.js';

test('anonymous archive and metadata disclose distribution files only; legacy aliases stay protected', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'rdf-agent-package-'));
  const bytes = Buffer.from('synthetic archive payload'), digest = createHash('sha256').update(bytes).digest('hex');
  const app = express();
  let checks = 0;
  const auth: express.RequestHandler = (_req, res) => { checks++; res.sendStatus(401); };
  registerAgentBundleRoutes(app, { requireAuth: auth, requireAdmin: auth }, directory);
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(error instanceof ApiError ? error.status : 500).json({ error: { code: (error as ApiError).code } });
  });
  const server = createServer(app); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    assert.equal((await fetch(base + '/api/downloads/agent')).status, 503);
    await writeFile(path.join(directory, 'version.txt'), '../private'); await writeFile(path.join(directory, 'sha256.txt'), digest);
    assert.equal((await fetch(base + '/api/downloads/agent/info')).status, 503);
    await writeFile(path.join(directory, 'version.txt'), 'test-1'); await writeFile(path.join(directory, 'rdf-linux-agent-test-1.tar.gz'), bytes);
    await writeFile(path.join(directory, 'sha256.txt'), '0'.repeat(64));
    assert.equal((await fetch(base + '/api/downloads/agent')).status, 503);
    await writeFile(path.join(directory, 'sha256.txt'), digest);
    const info = await fetch(base + '/api/downloads/agent/info?token=ignored');
    assert.deepEqual(await info.json(), { version: 'test-1', filename: 'rdf-linux-agent-test-1.tar.gz', sha256: digest, sizeBytes: bytes.length });
    const download = await fetch(base + '/api/downloads/agent');
    assert.equal(download.status, 200); assert.equal(download.headers.get('content-type'), 'application/gzip');
    assert.equal(download.headers.get('x-content-type-options'), 'nosniff');
    assert.match(download.headers.get('content-disposition')!, /rdf-linux-agent-test-1.tar.gz/);
    assert.deepEqual(Buffer.from(await download.arrayBuffer()), bytes);
    assert.equal((await fetch(base + '/api/downloads/agent', { headers: { 'if-none-match': download.headers.get('etag')!, 'cache-control': 'max-age=0' } })).status, 304);
    const head = await fetch(base + '/api/downloads/agent', { method: 'HEAD' }); assert.equal(head.status, 200); assert.equal((await head.arrayBuffer()).byteLength, 0);
    assert.equal(checks, 0);
    assert.equal((await fetch(base + '/api/admin/agent-bundle')).status, 401);
    assert.equal((await fetch(base + '/api/admin/agent-bundle/info')).status, 401); assert.equal(checks, 2);
  } finally { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); await rm(directory, { recursive: true, force: true }); }
});
