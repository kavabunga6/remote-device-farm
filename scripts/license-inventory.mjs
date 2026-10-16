#!/usr/bin/env node
// Reproducible inventory of shipped npm packages; package-provided LICENSE/NOTICE files remain authoritative.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const components = ['server', 'agent', 'frontend', 'examples/appium', 'integrations/mcp'];
const legacyLicense = { 'busboy@1.6.0': 'MIT', 'streamsearch@1.1.0': 'MIT', 'ftp-response-parser@1.0.1': 'MIT', 'parse-listing@1.1.3': 'MIT' }; // Upstream package `licenses` metadata, not lockfile `license`.
const records = components.map(component => {
  const contents = readFileSync(resolve(root, component, 'package-lock.json'), 'utf8').replace(/\r\n/g, '\n');
  const lock = JSON.parse(contents);
  const packages = Object.entries(lock.packages).filter(([path, value]) => path && (component === 'examples/appium' || !value.dev)).map(([path, value]) => {
    const name = path.split('node_modules/').at(-1);
    const license = value.license || legacyLicense[`${name}@${value.version}`];
    if (!license) throw new Error(`Review license for ${component}: ${name}@${value.version}`);
    return { name, version: value.version, license };
  }).sort((a, b) => a.name.localeCompare(b.name, 'en') || a.version.localeCompare(b.version, 'en'));
  return { component, lockSha256: createHash('sha256').update(contents).digest('hex'), packages };
});
const target = resolve(root, 'docs/security/dependency-licenses.json');
const contents = JSON.stringify({ format: 1, scope: 'Production npm dependencies; Appium example includes its development tools', components: records }, null, 2) + '\n';
if (process.argv.includes('--check')) {
  if (readFileSync(target, 'utf8') !== contents) throw new Error('Dependency license inventory is stale; run node scripts/license-inventory.mjs and review changes');
} else writeFileSync(target, contents);
// Preserve the source license/notice in every build context.
for (const component of ['agent/licenses', 'server/licenses', 'frontend/public/licenses', 'deploy/registry/licenses']) {
  for (const [source, destination] of [['LICENSE', 'Apache-2.0.txt'], ['NOTICE', 'NOTICE.txt'], ['THIRD_PARTY.md', 'THIRD_PARTY.txt']]) {
    if (!readFileSync(resolve(root, source)).equals(readFileSync(resolve(root, component, destination)))) throw new Error(`Stale ${component}/${destination}`);
  }
}
console.log(`License inventory verified: ${records.reduce((n, item) => n + item.packages.length, 0)} package entries`);
