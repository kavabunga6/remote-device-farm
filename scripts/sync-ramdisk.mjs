import { readFile, writeFile } from 'node:fs/promises';
const source = await readFile(new URL('../shared/ramdisk.py', import.meta.url), 'utf8');
const content = '# Generated from shared/ramdisk.py; run node scripts/sync-ramdisk.mjs.\n' + source.replaceAll('\r\n', '\n');
for (const relative of ['../agent/emulator-image/ramdisk.py', '../deploy/hqarroum-emulator/ramdisk.py']) {
  const target = new URL(relative, import.meta.url);
  if (process.argv.includes('--check')) {
    if ((await readFile(target, 'utf8')).replaceAll('\r\n', '\n') !== content) throw new Error('Ramdisk parser is not synchronized: ' + relative);
  } else await writeFile(target, content);
}
