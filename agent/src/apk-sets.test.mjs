import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { inspectApkSet, installApkSet } from './apk-sets.mjs';
import { zip } from './test-support/zip.mjs';
test('APK archives reject traversal, duplicate files, corrupt CRC and lying expanded sizes', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'rdf-set-test-'));
  const file = path.join(directory, 'input.apks');
  try {
    const entries = [{ name: 'toc.pb', data: 'toc' }, { name: 'splits/base-master.apk', data: 'base', deflate: true }];
    await writeFile(file, zip(entries));
    assert.deepEqual(await inspectApkSet(file), ['splits/base-master.apk']);
    for (const bad of [
      [{ name: '../base.apk', data: 'x' }], [{ name: '/base.apk', data: 'x' }],
      [{ name: 'base.apk', data: 'x' }, { name: 'base.apk', data: 'y' }],
      [{ name: 'base.apk', data: 'x'.repeat(10000), size: 1, deflate: true }],
    ]) {
      await writeFile(file, zip([{ name: 'toc.pb', data: 'toc' }, ...bad]));
      await assert.rejects(inspectApkSet(file));
    }
    const corrupt = zip(entries); corrupt[14] ^= 1; corrupt[corrupt.indexOf(Buffer.from('toc'))] ^= 1;
    await writeFile(file, corrupt); await assert.rejects(inspectApkSet(file));
    await writeFile(file, zip([{ name: 'base.apk', data: 'base' }, { name: 'config.x86_64.apk', data: 'split' }]));
    assert.equal((await inspectApkSet(file, false)).length, 2);
    await assert.rejects(inspectApkSet(file, true));
  } finally { assert.equal(path.dirname(directory), os.tmpdir()); await rm(directory, { recursive: true, force: true }); }
});

test('bundletool receives actual SDK, ABI, density and locale; only selected APKs reach the owned serial', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'rdf-set-test-'));
  const file = path.join(directory, 'input.apks'), jar = path.join(directory, 'bundletool.jar');
  const calls = [];
  try {
    await writeFile(jar, 'fixture'); await writeFile(file, zip([{ name: 'toc.pb', data: 'toc' }, { name: 'base.apk', data: 'base' }]));
    const adb = { run: async (serial, args) => {
      calls.push({ serial, args });
      if (args.includes('getprop')) return { exitCode: 0, stdout: '[ro.build.version.sdk]: [36]\n[ro.product.cpu.abilist]: [x86_64,x86]\n' };
      if (args.includes('density')) return { exitCode: 0, stdout: 'Physical density: 420\nOverride density: 320\n' };
      if (args.includes('system_locales')) return { exitCode: 0, stdout: 'ru-RU,en-US\n' };
      return { exitCode: 0, stdout: 'Success' };
    } };
    const execute = async (command, args) => {
      assert.equal(command, 'java'); assert.equal(args[0], '-Xmx384m');
      const spec = JSON.parse(await readFile(path.join(directory, 'device.json'), 'utf8'));
      assert.deepEqual(spec, { sdkVersion: 36, supportedAbis: ['x86_64', 'x86'], screenDensity: 320, supportedLocales: ['ru-RU', 'en-US'] });
      await writeFile(path.join(directory, 'selected', 'base-master.apk'), 'base');
      await writeFile(path.join(directory, 'selected', 'base-x86_64.apk'), 'x86');
      return { exitCode: 0, stdout: '' };
    };
    const result = await installApkSet(adb, 'owned-serial', { name: 'input.apks', local: file, directory }, execute, { jar });
    assert.equal(result.selectedApks, 2); assert.ok(calls.every(call => call.serial === 'owned-serial'));
    assert.equal(calls.at(-1).args[0], 'install-multiple');
  } finally { assert.equal(path.dirname(directory), os.tmpdir()); await rm(directory, { recursive: true, force: true }); }
});
