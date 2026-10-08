import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseSdkList } from './emulator-catalog.mjs';
import { verifiedManifest } from '../../deploy/emulator/verified-manifest.mjs';

const catalog = parseSdkList(readFileSync(new URL('./fixtures/sdkmanager-list.txt', import.meta.url), 'utf8'));
const phone = 'system-images;android-34;google_apis_playstore;x86_64';
const tv = 'system-images;android-30;android-tv;x86';
const digest = 'sha256:' + 'a'.repeat(64);

test('published manifest contains only confirmed builds and pins each profile to its verified digest', () => {
  const manifest = verifiedManifest(catalog, phone + '\t' + digest + '\n', { registry: 'registry.example:5000/rdf-emulator', abi: 'x86_64', requireDigest: true });
  assert.equal(manifest.profiles.length, 2, 'phone and tablet share the successfully built image');
  assert.ok(manifest.profiles.every(profile => profile.image.digest === digest));
  assert.ok(manifest.profiles.every(profile => profile.image.repository === 'registry.example:5000/rdf-emulator'));
  assert.ok(!manifest.profiles.some(profile => profile.android.deviceType === 'tv'), 'failed or unattempted TV builds are not exported');
});

test('a push without a verified digest cannot produce a published profile', () => {
  assert.throws(() => verifiedManifest(catalog, phone + '\t\n', { registry: 'farm/rdf-emulator', abi: 'x86_64', requireDigest: true }), /verified registry digest/);
  assert.throws(() => verifiedManifest(catalog, phone + '\tsha256:bad\n', { registry: 'farm/rdf-emulator', abi: 'x86_64' }), /verified registry digest/);
  assert.throws(() => verifiedManifest(catalog, phone + '\t' + digest + '\n' + phone + '\t' + digest, { registry: 'farm/rdf-emulator', abi: 'x86_64' }), /Duplicate/);
  assert.throws(() => verifiedManifest(catalog, 'unknown\t' + digest, { registry: 'farm/rdf-emulator', abi: 'x86_64' }), /absent/);
});

test('local manifests contain only successful local builds; an all-failed batch is empty', () => {
  assert.deepEqual(verifiedManifest(catalog, '', { registry: 'rdf-emulator', abi: 'x86_64' }), { version: 2, profiles: [] });
  const local = verifiedManifest(catalog, tv + '\t\n', { registry: 'rdf-emulator', abi: 'x86_64' });
  assert.equal(local.profiles.length, 1);
  assert.equal(local.profiles[0].android.deviceType, 'tv');
  assert.equal(local.profiles[0].image.digest, undefined);
});
