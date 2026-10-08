import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { importLegacyKeys } from './import-legacy-key.mjs';

test('legacy ADB identity import preserves bytes, survives repeat, and rejects mismatch or partial copy', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rdf-key-import-'));
  assert.ok(root.startsWith(os.tmpdir() + path.sep));
  const destinationDir = path.join(root, 'dest');
  const privateSource = path.join(root, 'source-adbkey');
  const publicSource = path.join(root, 'source-adbkey.pub');
  const privateBytes = Buffer.from('test-private-key-bytes\n');
  const publicBytes = Buffer.from('test-public-key-bytes\n');
  try {
    await mkdir(destinationDir);
    await writeFile(privateSource, privateBytes);
    await writeFile(publicSource, publicBytes);
    const options = { privateSource, publicSource, destinationDir, owner: null };
    assert.deepEqual(await importLegacyKeys(options), { imported: true });
    assert.deepEqual(await readFile(path.join(destinationDir, 'adbkey')), privateBytes);
    assert.deepEqual(await readFile(path.join(destinationDir, 'adbkey.pub')), publicBytes);
    assert.deepEqual(await importLegacyKeys(options), { imported: false });
    await writeFile(path.join(destinationDir, 'adbkey'), 'different');
    await assert.rejects(importLegacyKeys(options), /differs from legacy source/);
    assert.deepEqual(await readFile(privateSource), privateBytes);
    await rm(path.join(destinationDir, 'adbkey.pub'));
    await assert.rejects(importLegacyKeys(options), /Partial ADB key import/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
