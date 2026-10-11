import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const copies = [['scripts/rdf.sh', 'resources/rdf/rdf.sh'], ['integrations/common/run-tests.sh', 'resources/rdf/run-tests.sh']];
for (const [source, destination] of copies) {
  const content = readFileSync(join(root, source), 'utf8').replaceAll('\r\n', '\n');
  if (process.argv.includes('--check')) {
    if (readFileSync(join(root, destination), 'utf8') !== content) throw new Error(destination + ': run node scripts/sync-ci-resources.mjs');
  } else {
    mkdirSync(dirname(join(root, destination)), { recursive: true });
    writeFileSync(join(root, destination), content);
  }
}
console.log('Jenkins resources match the shared CLI and runner.');
