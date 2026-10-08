import test from 'node:test';
import assert from 'node:assert/strict';
import { parseProfile } from '../src/http-common.js';
import { parseStorageRequest, resolveStorage } from '../src/storage.js';

const profile = { disk_gb: 8, disk_max_gb: 32, sdcard_gb: 2, sdcard_max_gb: 8 };

test('storage defaults come from the profile', () => {
  assert.deepEqual(resolveStorage(profile), { diskGb: 8, sdcardGb: 2 });
  assert.deepEqual(resolveStorage({ disk_gb: 8 }), { diskGb: 8, sdcardGb: null });
});

test('user choice stays inside profile limits', () => {
  assert.deepEqual(resolveStorage(profile, { diskGb: 32, sdcardGb: 8 }), { diskGb: 32, sdcardGb: 8 });
  assert.deepEqual(resolveStorage(profile, { sdcardGb: 0 }), { diskGb: 8, sdcardGb: null });
  for (const request of [{ diskGb: 33 }, { diskGb: 1 }, { sdcardGb: 9 }, { sdcardGb: -1 }]) {
    assert.throws(() => resolveStorage(profile, request), { code: 'storage_out_of_range' });
  }
  assert.throws(() => resolveStorage({ disk_gb: 8 }, { sdcardGb: 1 }), { code: 'storage_out_of_range' });
});

test('request parsing rejects non-integers and ignores absent values', () => {
  assert.deepEqual(parseStorageRequest({}), {});
  assert.deepEqual(parseStorageRequest({ diskGb: 4, sdcardGb: null }), { diskGb: 4 });
  for (const body of [{ diskGb: 1.5 }, { sdcardGb: '3' }, { diskGb: true }]) {
    assert.throws(() => parseStorageRequest(body), { code: 'invalid_storage' });
  }
});

test('profile validation bounds storage and reserved emulator flags', () => {
  const base = { id: 'prof', name: 'P', androidVersion: '14', image: 'x/y:1', cpu: 2, memoryMb: 4096, diskGb: 8, emulatorParams: '', gpuMode: 'software' };
  const ok = parseProfile({ ...base, diskMaxGb: 16, sdcardGb: 2, sdcardMaxGb: 4 });
  assert.deepEqual([ok.diskMaxGb, ok.sdcardGb, ok.sdcardMaxGb], [16, 2, 4]);
  for (const extra of [{ diskMaxGb: 4 }, { diskMaxGb: 200 }, { sdcardGb: 40 }, { sdcardGb: 4, sdcardMaxGb: 2 }, { emulatorParams: '-partition-size 9' }, { sdcardGb: 1, emulatorParams: '-sdcard /a' }]) {
    assert.throws(() => parseProfile({ ...base, ...extra }), { code: 'invalid_profile' }, JSON.stringify(extra));
  }
});
