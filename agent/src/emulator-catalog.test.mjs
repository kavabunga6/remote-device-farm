import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { buildManifest, imageTag, parsePackage, parseSdkList, selectEntries } from './emulator-catalog.mjs';

const list = readFileSync(new URL('./fixtures/sdkmanager-list.txt', import.meta.url), 'utf8');

test('parses available stable system images and ignores installed, updates, previews, XR and old APIs', () => {
  const catalog = parseSdkList(list);
  const paths = catalog.map(entry => entry.package);
  assert.ok(paths.includes('system-images;android-30;android-tv;x86'));
  assert.ok(!paths.some(path => /VanillaIceCream|google-xr|android-19/.test(path)));
  assert.equal(paths.filter(path => path === 'system-images;android-30;google_apis;x86_64').length, 1);
  const tv = catalog.find(entry => entry.tag === 'google-tv');
  assert.deepEqual([tv.device, tv.flavor, tv.androidVersion], ['tv', 'google_play', '14']);
  assert.equal(catalog.find(entry => entry.tag === 'android-automotive-playstore').device, 'automotive');
  assert.equal(catalog.find(entry => entry.api === 36 && entry.minor === 1).androidVersion, '16');
});

test('selects one build per image for x86_64 hosts with x86 fallback, no extension or 16 KB duplicates', () => {
  const selected = selectEntries(parseSdkList(list), { abi: 'x86_64' }).map(imageTag);
  assert.ok(selected.includes('30-google_apis-x86_64'));
  assert.ok(!selected.includes('30-google_apis-x86'), 'x86 only when no x86_64 build exists');
  assert.ok(selected.includes('30-android-tv-x86') && selected.includes('34-google-tv-x86') && selected.includes('23-google_apis-x86'));
  assert.ok(selected.includes('36.1-google_apis_playstore-x86_64'));
  assert.ok(!selected.some(tag => /ext10|ps16k|arm64/.test(tag)));
  assert.deepEqual(selectEntries(parseSdkList(list), { abi: 'arm64-v8a' }).map(imageTag), ['34-google_apis_playstore-arm64-v8a']);
  assert.deepEqual(selectEntries(parseSdkList(list), { filter: 'tv' }).map(imageTag).sort(), ['30-android-tv-x86', '34-google-tv-x86']);
});

test('AOSP, Google APIs and Google Play images stay separate profiles, each also as a tablet', () => {
  const profiles = buildManifest(parseSdkList(list)).profiles.filter(profile => profile.android.api === 36 || profile.android.api === 34);
  const flavors = new Set(profiles.filter(profile => profile.android.deviceType === 'mobile').map(profile => profile.android.flavor));
  assert.ok(flavors.has('aosp') && flavors.has('google_play'));
  assert.ok(profiles.some(profile => profile.android.flavor === 'aosp' && profile.android.resolution === '2560x1600'));
  assert.ok(profiles.find(profile => profile.android.flavor === 'aosp').name.includes('AOSP'));
  const catalog = parseSdkList(list);
  assert.equal(catalog.find(entry => entry.tag === 'android-tv').flavor, 'aosp');
  assert.equal(catalog.find(entry => entry.tag === 'google-tv').flavor, 'google_play');
  assert.equal(catalog.find(entry => entry.tag === 'android-wear').flavor, 'google_play');
  assert.equal(catalog.find(entry => entry.tag === 'google_apis' && entry.api === 30).flavor, 'google_apis');
});

test('manifest offers phones, tablets, TV, automotive and wear with unique ids and container room for the emulator', () => {
  const manifest = buildManifest(parseSdkList(list), { registry: 'registry.local/rdf-emulator' });
  assert.equal(manifest.version, 2);
  const ids = manifest.profiles.map(profile => profile.id);
  assert.equal(new Set(ids).size, ids.length);
  const types = new Set(manifest.profiles.map(profile => profile.android.deviceType));
  for (const type of ['mobile', 'tv', 'automotive', 'wear']) assert.ok(types.has(type), type);
  assert.ok(manifest.profiles.some(profile => profile.name.startsWith('Планшет') && profile.android.resolution === '2560x1600'));
  for (const profile of manifest.profiles) {
    assert.ok(profile.resources.memoryMb - profile.resources.guestMemoryMb >= 1024, profile.id);
    assert.ok(profile.resources.guestCores <= profile.resources.cpu, profile.id);
    assert.equal(profile.image.repository, 'registry.local/rdf-emulator');
    assert.ok(/^[a-z0-9-]{1,64}$/.test(profile.id), profile.id);
  }
  assert.equal(manifest.profiles.filter(profile => profile.recommended).length, 1);
});


test('saved phone and tablet profiles distinguish ATD and unknown system-image variants', () => {
  const tags = ['default', 'aosp_atd', 'google_apis', 'google_atd', 'google_apis_playstore', 'aosp_custom'];
  const entries = tags.map(tag => parsePackage(`system-images;android-34;${tag};x86_64`));
  const profiles = buildManifest(entries).profiles;
  assert.equal(profiles.length, tags.length * 2);
  assert.equal(new Set(profiles.map(profile => profile.name)).size, profiles.length);
  for (const [tag, name] of [['default', 'AOSP'], ['aosp_atd', 'AOSP ATD'], ['google_apis', 'Google APIs'],
    ['google_atd', 'Google APIs ATD'], ['google_apis_playstore', 'Google Play'], ['aosp_custom', 'AOSP · aosp_custom']]) {
    const pair = profiles.filter(profile => profile.image.tag === `34-${tag}-x86_64`);
    assert.equal(pair.length, 2);
    assert.ok(pair.every(profile => profile.name.includes(` · ${name} (API 34)`)), tag);
  }
  const extension = parsePackage('system-images;android-34-ext10;google_apis;x86_64');
  const extended = buildManifest([...entries, extension], { extensions: true }).profiles;
  assert.equal(new Set(extended.map(profile => profile.name)).size, extended.length);
  assert.ok(extended.some(profile => profile.name.endsWith('(API 34, ext 10)')));
});
