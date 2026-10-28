import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, relative } from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
const dictionary = JSON.parse(readFileSync(resolve(root, 'shared/diagnostics.json'), 'utf8'));
const keys = new Set();
for (const file of readdirSync(resolve(root, 'agent/src'), { recursive: true }).filter(file => file.endsWith('.mjs') && !file.includes('.test.') && !file.startsWith('generated'))) {
  for (const match of readFileSync(resolve(root, 'agent/src', file), 'utf8').matchAll(/diagnostic\('([^']+)'/g)) keys.add(match[1]);
}
const target = resolve(root, 'agent/src/generated/diagnostics.json');
const source = JSON.stringify(Object.fromEntries([...keys].sort().map(key => {
  if (!Object.hasOwn(dictionary, key)) throw new Error('Missing diagnostic: ' + key);
  return [key, dictionary[key]];
})), null, 2) + '\n';
if (process.argv.includes('--check')) {
  if (readFileSync(target, 'utf8').replaceAll('\r\n', '\n') !== source) throw new Error('Stale resource: ' + relative(root, target));
} else writeFileSync(target, source);
console.log(keys.size + ' packaged diagnostics verified');
