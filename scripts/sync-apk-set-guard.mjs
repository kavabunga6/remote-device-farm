import { readFile, writeFile } from 'node:fs/promises';
const source = await readFile(new URL('../shared/apk-set-guard.mjs', import.meta.url), 'utf8');
const target = new URL('../agent/src/generated/apk-set-guard.mjs', import.meta.url);
if (process.argv.includes('--check')) {
  if (await readFile(target, 'utf8') !== source) throw new Error('APK set guard is not synchronized');
} else await writeFile(target, source);
