import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
export const validDigest = value => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
const names = async path => readdir(path).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
const blob = (root, digest) => {
  if (!validDigest(digest)) throw new Error('Invalid digest');
  const hex = digest.slice(7);
  return join(root, 'docker/registry/v2/blobs/sha256', hex.slice(0, 2), hex, 'data');
};
async function jsonBlob(root, digest) {
  const path = blob(root, digest);
  if ((await stat(path)).size > 8 * 1024 * 1024) throw new Error('Metadata exceeds limit');
  const bytes = await readFile(path);
  if ('sha256:' + createHash('sha256').update(bytes).digest('hex') !== digest) throw new Error('Digest mismatch');
  return JSON.parse(bytes);
}
/** Every revision, including untagged ones; filesystem-backed Distribution only. */
export async function registryInventory(root) {
  const base = join(root, 'docker/registry/v2/repositories');
  const repositories = [];
  async function visit(path, prefix = '') {
    for (const name of await names(path)) {
      if (name === '_manifests') { repositories.push(prefix); continue; }
      if (name.startsWith('_')) continue;
      if (!/^[a-z0-9._-]+$/.test(name) || prefix.split('/').length > 10 || repositories.length > 1000) throw new Error('Invalid repository tree');
      await visit(join(path, name), prefix ? prefix + '/' + name : name);
    }
  }
  await visit(base);
  const repo = join(base, 'rdf-emulator/_manifests');
  const tags = new Map();
  for (const tag of await names(join(repo, 'tags'))) {
    if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(tag)) throw new Error('Invalid tag');
    const digest = (await readFile(join(repo, 'tags', tag, 'current/link'), 'utf8')).trim();
    if (!validDigest(digest)) throw new Error('Invalid tag digest');
    tags.set(tag, digest);
  }
  const revisions = await names(join(repo, 'revisions/sha256'));
  if (revisions.length > 10000) throw new Error('Inventory exceeds limit');
  const items = [];
  for (const hex of revisions) {
    const digest = 'sha256:' + hex;
    if (!validDigest(digest)) throw new Error('Invalid revision digest');
    // Distribution deletes the revision link but leaves its parent directories.
    const link = await readFile(join(repo, 'revisions/sha256', hex, 'link'), 'utf8').catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (link === null) continue;
    if (link.trim() !== digest) throw new Error('Invalid revision link');
    const manifest = await jsonBlob(root, digest);
    const children = (manifest.manifests ?? []).map(item => item.digest);
    if (children.some(value => !validDigest(value))) throw new Error('Invalid index');
    const config = manifest.config?.digest ? await jsonBlob(root, manifest.config.digest) : {};
    const sizeBytes = (manifest.layers ?? []).reduce((sum, layer) => sum + (Number.isSafeInteger(layer.size) && layer.size >= 0 ? layer.size : 0), 0);
    items.push({
      digest, tags: [...tags].filter(([, value]) => value === digest).map(([tag]) => tag),
      createdAt: Number.isFinite(Date.parse(config.created)) ? new Date(config.created).toISOString() : null,
      package: typeof config.config?.Labels?.['remote-device-farm.system-image'] === 'string' ? config.config.Labels['remote-device-farm.system-image'].slice(0, 512) : null, sizeBytes, children
    });
  }
  return { repositories, items };
}
export function validateRemoval(items, digests) {
  if (!Array.isArray(digests) || digests.length > 500 || digests.some(value => !validDigest(value)) || new Set(digests).size !== digests.length) throw new Error('Invalid deletion list');
  const known = new Set(items.map(item => item.digest));
  if (digests.some(digest => !known.has(digest))) throw new Error('Image is no longer present');
  const selected = new Set(digests);
  if (items.some(item => !selected.has(item.digest) && item.children.some(child => selected.has(child)))) throw new Error('Image belongs to a retained index');
}
