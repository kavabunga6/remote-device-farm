import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
const bundle = await build({ entryPoints: [fileURLToPath(new URL('./src/profile-metadata.ts', import.meta.url))], bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent' });
const { profileEnvironment } = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].contents).toString('base64'));

test('describes guest resources independently from Docker limits and preserves explicit environment metadata', () => {
  const environment = profileEnvironment({ id: 'test', name: 'Test', cpu: 8, memoryMb: 6144, guestCores: 2, guestMemoryMb: 2048, androidVersion: '11', apiLevel: 30, abi: 'x86_64, arm64-v8a', deviceModel: 'Pixel 5', resolution: '720x1280' });
  assert.equal(environment.memory, '2 ГБ');
  assert.equal(environment.cores, '2');
  assert.equal(environment.api, 'API 30');
  assert.equal(environment.abi, 'x86_64, arm64-v8a');
  assert.equal(environment.resolution, '720 × 1280');
});

test('never guesses guest resources or ABI from a custom image name or container resources', () => {
  const environment = profileEnvironment({ id: 'arm64-api-35', name: 'Pixel 9', cpu: 16, memoryMb: 32768, image: 'registry/android-x86_64-api-35:latest', androidVersion: '11' });
  assert.equal(environment.memory, 'Не задано в профиле');
  assert.equal(environment.cores, 'Не задано в профиле');
  assert.equal(environment.api, 'API не указан');
  assert.equal(environment.abi, 'Не указана');
  assert.equal(environment.model, 'Не указана в профиле');
  assert.equal(environment.resolution, 'Не задано в профиле');
});

test('recognizes explicitly written legacy API and marks launch parameter resources', () => {
  const environment = profileEnvironment({ androidVersion: '11 (API 30)', emulatorParams: '-memory 2048 -cores=2' });
  assert.equal(environment.android, 'Android 11');
  assert.equal(environment.api, 'API 30');
  assert.equal(environment.memory, '2 ГБ');
  assert.equal(environment.cores, '2');
  assert.equal(profileEnvironment({ androidVersion: '11 (API 30)', apiLevel: 31 }).api, 'API 31');
});


test('explicit resource fields take precedence and ambiguous launch values are not guessed', () => {
  const explicit = profileEnvironment({ guestCores: 4, guestMemoryMb: 3072, emulatorParams: '-memory 2048 -cores=2' });
  assert.equal(explicit.cores, '4');
  assert.equal(explicit.memory, '3 ГБ');
  for (const params of ['-cores 2 -cores 4', '-cores=2 -cores 4', '-cores', '-cores=auto', '-cores=2.5', '-cores 0', '-cores 9999999999999999999999']) {
    assert.equal(profileEnvironment({ emulatorParams: params }).cores, 'Задано параметрами запуска', params);
  }
  for (const params of ['-memory 1024 -memory 2048', '-memory=1024 -memory=2048', '-memory', '-memory=2G', '-memory -1']) {
    assert.equal(profileEnvironment({ emulatorParams: params }).memory, 'Задано параметрами запуска', params);
  }
});

test('only complete resource flags count and empty model or screen remain explicitly unknown', () => {
  assert.equal(profileEnvironment({ emulatorParams: '-cores-max 8 -memory-limit 2048' }).cores, 'Не задано в профиле');
  assert.equal(profileEnvironment({ emulatorParams: '-cores-max 8 -memory-limit 2048' }).memory, 'Не задано в профиле');
  const flags = profileEnvironment({ emulatorParams: '-no-snapshot -memory=1536 -cores 3' });
  assert.equal(flags.memory, '1,5 ГБ'); assert.equal(flags.cores, '3');
  const empty = profileEnvironment({ deviceModel: ' ', resolution: ' ' });
  assert.equal(empty.model, 'Не указана в профиле'); assert.equal(empty.resolution, 'Не задано в профиле');
});
