import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
const bundle = await build({ entryPoints: ['src/preferences-autosave.ts'], bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent' });
const preferences = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].contents).toString('base64'));
const OLD = '11111111-1111-4111-8111-111111111111';
const NEW = '22222222-2222-4222-8222-222222222222';
const value = { theme: 'system', fontFamily: 'system', fontScale: 1, defaultAdbKeyId: null };

test('late preference writes are rejected when the browser account changed after an earlier identity response', async () => {
  const original = globalThis.fetch; const writes = [];
  globalThis.fetch = async (url, options) => {
    if (url === '/api/me') return Response.json({ user: { id: OLD } });
    assert.equal(url, '/api/me/preferences');
    const body = JSON.parse(options.body);
    if (body.expectedUserId && body.expectedUserId !== NEW) return Response.json({ error: { code: 'account_changed', message: 'Account changed' } }, { status: 409 });
    writes.push({ userId: NEW, body }); return Response.json({ preferences: value });
  };
  try {
    await assert.rejects(preferences.saveUserPreferences(OLD, { theme: 'dark' }));
    assert.deepEqual(writes, []);
  } finally { globalThis.fetch = original; }
});

test('queued writes and subsequent loads stay bound to their intended account', async () => {
  const original = globalThis.fetch; const requests = [];
  globalThis.fetch = async (url, options) => {
    if (url === '/api/me') return Response.json({ user: { id: OLD } });
    requests.push({ url, body: options.body ? JSON.parse(options.body) : null });
    return Response.json({ preferences: value });
  };
  try {
    await Promise.all([preferences.saveUserPreferences(OLD, { theme: 'dark' }), preferences.saveUserPreferences(OLD, { fontScale: 1.1 })]);
    await preferences.loadUserPreferences(OLD);
    assert.deepEqual(requests, [
      { url: '/api/me/preferences', body: { theme: 'dark', expectedUserId: OLD } },
      { url: '/api/me/preferences', body: { fontScale: 1.1, expectedUserId: OLD } },
      { url: '/api/me/preferences?expectedUserId=' + OLD, body: null },
    ]);
  } finally { globalThis.fetch = original; }
});
