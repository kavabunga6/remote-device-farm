#!/usr/bin/env node
// Local contract checks; live device and CI-controller checks are documented separately.
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const bash = process.env.RDF_TEST_BASH || (process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash');
function files(directory, suffix) {
  return readdirSync(join(root, directory), { withFileTypes: true }).flatMap(entry => {
    if (entry.name.startsWith('.') || ['node_modules', 'artifacts', 'dist', 'build'].includes(entry.name)) return [];
    const name = join(directory, entry.name);
    return entry.isDirectory() ? files(name, suffix) : name.endsWith(suffix) ? [name] : [];
  }).sort();
}
function run(label, command, args, options = {}) {
  console.log(`\n${label}`);
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', windowsHide: true, ...options });
  if (result.error) throw new Error(`${label}: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${label} failed (${result.signal || result.status})`);
}
function checkDocumentation() {
  const documents = ['README.md', 'docs/README.md', 'docs/api/README.md', ...files('docs/ci', '.md')];
  for (const document of documents) {
    const source = readFileSync(join(root, document), 'utf8').replaceAll('\r\n', '\n');
    const prose = source.replace(/^```[^\n]*\n[\s\S]*?^```[ \t]*$/gm, '');
    for (const match of prose.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)) {
      const link = match[1].trim().replace(/^<([^>]+)>$/, '$1');
      if (/^(?:[a-z][a-z\d+.-]*:|#)/i.test(link)) continue;
      const target = decodeURIComponent(link.split('#')[0]);
      if (target && !existsSync(resolve(root, dirname(document), target))) {
        throw new Error(`Broken documentation link: ${document} -> ${link}`);
      }
    }
    const blocks = [...source.matchAll(/^```(?:bash|sh)\s*\n([\s\S]*?)^```[ \t]*$/gm)];
    for (const [index, block] of blocks.entries()) {
      const result = spawnSync(bash, ['-n'], { cwd: root, input: block[1], encoding: 'utf8', windowsHide: true });
      if (result.error || result.status !== 0) throw new Error(`Invalid shell example: ${document}, block ${index + 1}: ${result.error?.message || result.stderr}`);
    }
  }
  console.log(`Documentation: ${documents.length} files, local links and shell examples checked.`);
}
try {
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Use Node.js 24 or newer for the integration checks.');
  for (const file of ['scripts/rdf.sh', ...files('examples', '.sh'), ...files('integrations', '.sh')]) run(`Shell syntax: ${file}`, bash, ['-n', file]);
  for (const file of files('examples', '.mjs')) run(`JavaScript syntax: ${file}`, process.execPath, ['--check', file]);
  for (const file of files('integrations', '.cjs')) run(`JavaScript syntax: ${file}`, process.execPath, ['--check', file]);
  run('CircleCI bundle', process.execPath, ['scripts/package-native-ci.mjs', 'circleci', '--check']);
  run('Bundled Jenkins resources', process.execPath, ['scripts/sync-ci-resources.mjs', '--check']);
  checkDocumentation();
  const tests = files('scripts/test', '.test.mjs');
  if (!tests.length) throw new Error('No integration contract tests found.');
  run('Integration contract tests', process.execPath, ['--test', ...tests]);
  console.log('\nLocal integration checks passed. Live acceptance status: docs/ci/README.md');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
