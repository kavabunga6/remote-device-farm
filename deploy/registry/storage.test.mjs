import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { registryInventory, validateRemoval } from './storage.mjs';
test('filesystem inventory includes untagged revisions, metadata and verified blob sizes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rdf-registry-test-'));
  try {
    const blob = async object => { const bytes = JSON.stringify(object), hex = createHash('sha256').update(bytes).digest('hex'); const dir = join(root, 'docker/registry/v2/blobs/sha256', hex.slice(0, 2), hex); await mkdir(dir, { recursive: true }); await writeFile(join(dir, 'data'), bytes); return 'sha256:' + hex; };
    const config = await blob({ created: '2026-01-01T00:00:00Z', config: { Labels: { 'remote-device-farm.system-image': 'sdk' } } });
    const digest = await blob({ schemaVersion: 2, config: { digest: config }, layers: [{ size: 200 }, { size: 300 }] });
    const repo = join(root, 'docker/registry/v2/repositories/rdf-emulator/_manifests'); await mkdir(join(repo, 'revisions/sha256', digest.slice(7)), { recursive: true });
    await writeFile(join(repo, 'revisions/sha256', digest.slice(7), 'link'), digest);
    let inventory = await registryInventory(root); assert.equal(inventory.items[0].sizeBytes, 500); assert.equal(inventory.items[0].package, 'sdk'); assert.deepEqual(inventory.items[0].tags, []);
    await mkdir(join(repo, 'tags/latest/current'), { recursive: true }); await writeFile(join(repo, 'tags/latest/current/link'), digest);
    inventory = await registryInventory(root); assert.deepEqual(inventory.items[0].tags, ['latest']);
    await writeFile(join(root, 'docker/registry/v2/blobs/sha256', digest.slice(7, 9), digest.slice(7), 'data'), '{}');
    await assert.rejects(registryInventory(root), /Digest mismatch/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('retained manifest indices, invalid digests and disappeared images cannot be deleted', () => {
  const a = 'sha256:' + 'a'.repeat(64), b = 'sha256:' + 'b'.repeat(64);
  assert.throws(() => validateRemoval([{ digest: a, children: [b] }, { digest: b, children: [] }], [b]), /retained index/);
  assert.throws(() => validateRemoval([], ['../../etc']), /Invalid/);
  assert.throws(() => validateRemoval([], [a]), /no longer/);
  validateRemoval([{ digest: a, children: [b] }, { digest: b, children: [] }], [a, b]);
});

test('deleted revision directories are ignored after physical GC', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rdf-registry-test-'));
  try {
    const hex = 'a'.repeat(64), repo = join(root, 'docker/registry/v2/repositories/rdf-emulator/_manifests/revisions/sha256', hex);
    await mkdir(repo, { recursive: true });
    assert.deepEqual((await registryInventory(root)).items, []);
    await writeFile(join(repo, 'link'), 'sha256:' + 'b'.repeat(64));
    await assert.rejects(registryInventory(root), /Invalid revision link/);
    await rm(join(repo, 'link'));
    assert.deepEqual((await registryInventory(root)).items, []);
  } finally { await rm(root, { recursive: true, force: true }); }
});
