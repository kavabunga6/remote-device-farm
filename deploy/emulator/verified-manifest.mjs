import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { buildManifest, imageTag } from '../../agent/src/emulator-catalog.mjs';

/** Only successful builds appear in the output; pushed images additionally require a verified registry digest. */
export function verifiedManifest(catalog, results, { registry, abi, requireDigest = false } = {}) {
  const completed = new Map();
  for (const line of results.split(/\r?\n/).filter(Boolean)) {
    const [name, digest = ''] = line.split('\t');
    if (!catalog.some(entry => entry.package === name)) throw new Error('Build result is absent from the SDK catalog');
    if ((requireDigest || digest) && !/^sha256:[a-f0-9]{64}$/.test(digest)) throw new Error('Published image has no verified registry digest');
    if (completed.has(name)) throw new Error('Duplicate build result');
    completed.set(name, digest || null);
  }
  const entries = catalog.filter(entry => completed.has(entry.package));
  const manifest = buildManifest(entries, { registry, abi, extensions: true });
  const digests = new Map(entries.map(entry => [imageTag(entry), completed.get(entry.package)]));
  for (const profile of manifest.profiles) {
    const digest = digests.get(profile.image.tag);
    if (digest) profile.image.digest = digest;
  }
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [catalogPath, resultsPath, outputPath, registry, abi, mode] = process.argv.slice(2);
  if (!catalogPath || !resultsPath || !outputPath || !registry || !abi || !['local', 'pushed'].includes(mode)) throw new Error('Expected catalog results output registry abi local|pushed');
  const manifest = verifiedManifest(JSON.parse(await readFile(catalogPath, 'utf8')), await readFile(resultsPath, 'utf8'), { registry, abi, requireDigest: mode === 'pushed' });
  await writeFile(outputPath, JSON.stringify(manifest, null, 2) + '\n');
}
