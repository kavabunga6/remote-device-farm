import { readFile, writeFile } from 'node:fs/promises';
const source = await readFile(new URL('../shared/agent-identity.mjs', import.meta.url), 'utf8');
const target = new URL('../agent/src/generated/agent-identity.mjs', import.meta.url);
if (process.argv.includes('--check')) {
  if (await readFile(target, 'utf8') !== source) throw new Error('Agent identity helper is not synchronized');
} else await writeFile(target, source);
