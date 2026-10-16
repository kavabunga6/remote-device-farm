#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dictionary = JSON.parse(readFileSync(path.join(root, 'shared/messages.json'), 'utf8'));
const files = {
  'src/messages.json': JSON.stringify(Object.fromEntries(Object.entries(dictionary).filter(([key]) => key.startsWith('mcp.'))), null, 2) + '\n',
  LICENSE: readFileSync(path.join(root, 'LICENSE'), 'utf8').replaceAll('\r\n', '\n'),
  NOTICE: readFileSync(path.join(root, 'NOTICE'), 'utf8').replaceAll('\r\n', '\n'),
};
for (const [name, source] of Object.entries(files)) {
  const target = path.join(root, 'integrations/mcp', name);
  if (process.argv.includes('--check')) {
    if (readFileSync(target, 'utf8') !== source) throw new Error('Stale MCP resource: ' + name);
  } else writeFileSync(target, source);
}
console.log('MCP dictionary and license resources verified.');
