import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const entry = fileURLToPath(new URL('./src/queue-api.ts', import.meta.url));
const bundle = await build({ entryPoints: [entry], bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent' });
const m = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].contents).toString('base64'));

const NOW = Date.parse('2026-10-03T12:00:00Z');
const item = (id, minutesAgo, title = 'T', body = '') => ({ id, kind: 'session.ready', title, body, sessionId: null, createdAt: new Date(NOW - minutesAgo * 60000).toISOString() });

test('expiresIn rounds up to minutes and is empty when over', () => {
  assert.equal(m.expiresIn(new Date(NOW + 61000).toISOString(), NOW), '2 мин');
  assert.equal(m.expiresIn(new Date(NOW - 1000).toISOString(), NOW), '');
});

test('only unseen, recent notifications become toasts, oldest first', () => {
  const seen = new Set(['b']);
  const fresh = m.freshNotifications([item('a', 1), item('b', 2), item('c', 30), item('d', 3)], seen, NOW);
  assert.deepEqual(fresh.map(n => n.id), ['d', 'a']);
});

test('toast text shows the latest notification and a count of the rest', () => {
  assert.equal(m.toastText([]), '');
  assert.equal(m.toastText([item('a', 1, 'Готово', 'Pixel')]), 'Готово. Pixel');
  assert.equal(m.toastText([item('a', 2, 'Первое'), item('b', 1, 'Второе')]), 'Второе (и ещё 1)');
});
