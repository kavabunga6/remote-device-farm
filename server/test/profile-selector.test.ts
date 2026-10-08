import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool } from 'pg';
import { matchesSelector, parseProfileSelector, profileForm, rankProfiles, selectProfileId } from '../src/profile-selector.js';
import { ApiError } from '../src/http-common.js';

const rows = [
  { id: 'emu-34-play', name: 'Android 14 · Google Play', recommended: true, android_version: '14', api_level: 34, device_type: 'mobile', resolution: '1080x2400', image_flavor: 'google_play', abi: 'x86_64', enabled: true },
  { id: 'emu-34-play-tablet', name: 'Планшет · Android 14', recommended: false, android_version: '14', api_level: 34, device_type: 'mobile', resolution: '2560x1600', image_flavor: 'google_play', abi: 'x86_64', enabled: true },
  { id: 'emu-34-tv', name: 'Android TV · Android 14', recommended: false, android_version: '14', api_level: 34, device_type: 'tv', resolution: '1920x1080', image_flavor: 'google_play', abi: 'x86', enabled: true },
  { id: 'emu-33-auto', name: 'Android Automotive · Android 13', recommended: false, android_version: '13', api_level: 33, device_type: 'automotive', resolution: '1408x792', image_flavor: 'google_play', abi: 'x86_64', enabled: true },
  { id: 'emu-30-apis', name: 'Android 11 · Google APIs', recommended: false, android_version: '11', api_level: 30, device_type: 'mobile', resolution: null, image_flavor: 'google_apis', abi: 'x86_64', enabled: true },
];
const pool = { query: async () => ({ rows }) } as unknown as Pool;
const admin = { id: 'a', role: 'admin' };

test('selector validates its fields and rejects unknown ones', () => {
  assert.deepEqual(parseProfileSelector({ android: 14, deviceType: 'tv' }), { android: '14', deviceType: 'tv' });
  assert.deepEqual(parseProfileSelector({ api: '33', form: 'tablet', flavor: 'google_play', abi: 'x86_64' }), { api: 33, form: 'tablet', flavor: 'google_play', abi: 'x86_64' });
  for (const bad of [{ os: 'ios' }, { deviceType: 'fridge' }, { api: 'x' }, { android: '14; drop' }, { form: 'watch' }, null, []]) {
    assert.throws(() => parseProfileSelector(bad), (error: unknown) => error instanceof ApiError && error.status === 400, JSON.stringify(bad));
  }
});

test('phones and tablets are told apart by screen size', () => {
  assert.equal(profileForm(rows[0]!), 'phone');
  assert.equal(profileForm(rows[1]!), 'tablet');
  assert.equal(profileForm(rows[2]!), null);
  assert.equal(profileForm(rows[4]!), 'phone');
});

test('the best match is recommended, then newest API', async () => {
  assert.equal(await selectProfileId(pool, admin, {}), 'emu-34-play');
  assert.equal(await selectProfileId(pool, admin, { android: '14', deviceType: 'tv' }), 'emu-34-tv');
  assert.equal(await selectProfileId(pool, admin, { form: 'tablet' }), 'emu-34-play-tablet');
  assert.equal(await selectProfileId(pool, admin, { deviceType: 'automotive' }), 'emu-33-auto');
  assert.equal(await selectProfileId(pool, admin, { flavor: 'google_apis' }), 'emu-30-apis');
  await assert.rejects(selectProfileId(pool, admin, { deviceType: 'wear' }), (error: unknown) => error instanceof ApiError && error.status === 404);
  assert.deepEqual(rankProfiles(rows.filter(row => matchesSelector(row, { api: 34 }))).map(row => row.id), ['emu-34-play', 'emu-34-play-tablet', 'emu-34-tv']);
});
