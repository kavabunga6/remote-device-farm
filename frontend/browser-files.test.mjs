import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { transform } from 'esbuild';
const source = await transform(await readFile(new URL('./src/browser-files.ts', import.meta.url), 'utf8'), { loader: 'ts', format: 'esm' });
const { downloadFile } = await import('data:text/javascript;base64,' + Buffer.from(source.code).toString('base64'));

test('downloads set the filename and type and release the anchor and URL even after a failed click', async () => {
  const previous = { document: globalThis.document, window: globalThis.window, create: URL.createObjectURL, revoke: URL.revokeObjectURL };
  try {
    for (const fails of [false, true]) {
      const events = []; let blob;
      const link = { href: '', download: '', click() { events.push('click'); if (fails) throw new Error('Download failed'); }, remove() { events.push('removed'); } };
      globalThis.document = { createElement: () => link, body: { append: () => events.push('attached') } };
      globalThis.window = { setTimeout(callback, delay) { events.push(delay); callback(); } };
      URL.createObjectURL = value => { blob = value; return 'blob:fixture'; };
      URL.revokeObjectURL = value => events.push(value);
      const download = () => downloadFile('config.txt', 'synthetic contents', { type: 'text/plain', revokeAfterMs: 1000 });
      if (fails) assert.throws(download, /Download failed/); else download();
      assert.equal(link.download, 'config.txt'); assert.equal(link.href, 'blob:fixture');
      assert.equal(blob.type, 'text/plain'); assert.equal(await blob.text(), 'synthetic contents');
      assert.deepEqual(events, ['attached', 'click', 'removed', 1000, 'blob:fixture']);
    }
  } finally {
    globalThis.document = previous.document; globalThis.window = previous.window;
    URL.createObjectURL = previous.create; URL.revokeObjectURL = previous.revoke;
  }
});
