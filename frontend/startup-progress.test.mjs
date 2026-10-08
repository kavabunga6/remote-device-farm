import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
const load = async path => {
  const result = await build({ entryPoints: [fileURLToPath(new URL(path, import.meta.url))], bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent' });
  return import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].contents).toString('base64'));
};
const progress = await load('./src/startup-progress.ts');

test('startup progress never invents an overall percentage or carries one into the next stage', () => {
  assert.equal(progress.startupPercent(undefined), undefined);
  assert.equal(progress.startupPercent({ stage: 'creating' }), undefined);
  assert.equal(progress.startupPercent({ stage: 'ready', percent: 100 }), undefined);
  assert.equal(progress.startupPercent({ stage: 'ready', currentBytes: 100, totalBytes: 100 }), undefined);
  assert.equal(progress.startupSummary({ stage: 'ready', percent: 100 }), 'Подключаем экран');
  assert.equal(progress.startupPercent({ stage: 'downloading', currentBytes: 25, totalBytes: 100 }), 25);
  assert.equal(progress.startupPercent({ stage: 'booting', percent: NaN }), undefined);
  assert.equal(progress.startupPercent({ stage: 'unknown', percent: 50 }), undefined);
  assert.equal(progress.startupPercent({ stage: 'downloading', percent: 140 }), 100);
  assert.equal(progress.startupPercent({ stage: 'downloading', currentBytes: 0, totalBytes: 0 }), undefined);
  assert.match(progress.startupSummary({ stage: 'downloading', percent: 32 }), /32%$/);
  assert.equal(progress.startupTransfer({ stage: 'downloading', currentBytes: -1 }), undefined);
  assert.equal(progress.startupTransfer({ stage: 'downloading', currentBytes: 1024, totalBytes: 2048 }), '1 КиБ из 2 КиБ');
});
