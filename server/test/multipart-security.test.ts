import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import multer from 'multer';
import { createServer } from 'node:http';
import { once } from 'node:events';

// Exercise the parser itself: a malicious field must be rejected before append-field
// expands a sparse array. Use a modest index to avoid risking the test runner.
test('multipart rejects indexed fields and oversized metadata without hanging', async () => {
  const app = express();
  const upload = multer({ storage: multer.memoryStorage(), limits: {
    files: 1, fields: 4, parts: 5, fieldNameSize: 100, fieldSize: 4096, fieldArrayIndexLimit: 0,
  } });
  app.post('/', upload.single('file'), (_req, res) => res.sendStatus(204));
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(400).json({ code: error instanceof multer.MulterError ? error.code : 'unexpected' });
  });
  const server = createServer(app).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as { port: number };
  try {
    for (const [name, value] of [['items[100000]', 'x'], ['note', 'x'.repeat(4097)]]) {
      const data = new FormData(); data.append(name!, value!);
      const response = await fetch(`http://127.0.0.1:${address.port}/`, { method: 'POST', body: data, signal: AbortSignal.timeout(2000) });
      assert.equal(response.status, 400);
      assert.notEqual((await response.json() as { code: string }).code, 'unexpected');
    }
    const data = new FormData(); data.append('note', 'normal note');
    assert.equal((await fetch(`http://127.0.0.1:${address.port}/`, { method: 'POST', body: data })).status, 204);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
