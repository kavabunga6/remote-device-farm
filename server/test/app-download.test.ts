import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { downloadToFile } from '../src/app-store.js';

test('following a redirect closes its response even when the source keeps streaming', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'rdf-download-'));
  let redirectClosed: Promise<unknown> | undefined;
  const server = createServer((req, res) => {
    if (req.url === '/redirect') {
      redirectClosed = once(req.socket, 'close');
      res.writeHead(302, { Location: '/app.apk' });
      res.write('unfinished redirect body');
    } else { res.end('downloaded'); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const port = (server.address() as { port: number }).port;
    const file = path.join(directory, 'app.apk');
    const result = await downloadToFile(`http://127.0.0.1:${port}/redirect`, file,
      { allowHttp: true, allowPrivate: true, maxFileBytes: 1024 }, 2000);
    assert.equal(result.size, 10);
    assert.equal(await readFile(file, 'utf8'), 'downloaded');
    assert.ok(redirectClosed);
    const closed = await Promise.race([redirectClosed.then(() => true), delay(1000, false)]);
    assert.equal(closed, true, 'the redirect connection must be released before its body ends');
  } finally {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('rdf-download-'));
    await rm(directory, { recursive: true, force: true });
  }
});
