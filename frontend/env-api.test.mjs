import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

// env-api.ts imports ./api (browser code); the tests only need the pure presets and patterns.
const entry = fileURLToPath(new URL('./src/env-api.ts', import.meta.url));
const bundle = await build({ entryPoints: [entry], bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent' });
const m = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].contents).toString('base64'));

test('package pattern matches the agent rules', () => {
  assert.ok(m.PACKAGE_RE.test('com.example.app'));
  for (const bad of ['com', 'com.example; reboot', '1a.b', 'a..b', 'a.b\n']) assert.ok(!m.PACKAGE_RE.test(bad), bad);
});

test('city presets stay inside coordinate bounds', () => {
  for (const c of m.CITIES) assert.ok(Math.abs(c.lat) <= 90 && Math.abs(c.lon) <= 180);
  assert.ok(m.getTimeZones().length > 5 && m.NETWORK_PRESETS[0].id === 'full');
});
