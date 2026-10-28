import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const entry = fileURLToPath(new URL('./src/apps-api.ts', import.meta.url));
const bundle = await build({ entryPoints: [entry], bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent' });
const m = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].contents).toString('base64'));
const { formatMb, formatAppSize, checkUploadFile } = m;

const usage = { count: 2, usedBytes: 100 * 1048576, maxBytes: 150 * 1048576, maxApps: 3, maxFileBytes: 60 * 1048576 };

test('sizes are shown in megabytes with a decimal comma for small values', () => {
  assert.equal(formatMb(1024 * 1048576), '1024');
  assert.equal(formatMb(2.5 * 1048576), '2,5');
  assert.equal(formatAppSize(18.4 * 1048576), '18 МБ');
  assert.equal(formatAppSize(300 * 1024), '300 КБ');
});

test('upload checks catch wrong type, empty and oversize files before sending', () => {
  assert.equal(checkUploadFile({ name: 'a.APK', size: 10 * 1048576 }, usage), null);
  assert.equal(checkUploadFile({ name: 'a.zip', size: 5 }, usage), null);
  assert.equal(checkUploadFile({ name: 'a.apks', size: 5 }, usage), null);
  assert.match(checkUploadFile({ name: 'a.aab', size: 5 }, usage), /APK/i);
  assert.match(checkUploadFile({ name: 'a.apk', size: 0 }, usage), /пустой/);
  assert.match(checkUploadFile({ name: 'a.apk', size: 61 * 1048576 }, usage), /больше 60/);
  assert.match(checkUploadFile({ name: 'a.apk', size: 55 * 1048576 }, usage), /не хватает места/);
  assert.match(checkUploadFile({ name: 'a.apk', size: 1 }, { ...usage, count: 3 }), /слишком много/);
  assert.equal(checkUploadFile({ name: 'a.apk', size: 1 }, null), null);
});
