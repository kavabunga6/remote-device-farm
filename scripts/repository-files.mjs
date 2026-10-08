import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));

export function readRepositoryFiles(staged = false) {
  const args = staged ? ['ls-files', '--cached', '-z'] : ['ls-files', '--cached', '--others', '--exclude-standard', '-z'];
  const files = [...new Set(execFileSync('git', args, { cwd: repositoryRoot }).toString().split('\0').filter(Boolean))];
  if (!staged) return new Map(files.filter(file => existsSync(resolve(repositoryRoot, file))).map(file => [file, readFileSync(resolve(repositoryRoot, file))]));
  if (!files.length) return new Map();
  // Read the index, including binary files, in one subprocess. Working-tree edits
  // made after staging must not change what the commit checks examine.
  const batch = execFileSync('git', ['cat-file', '--batch'], {
    cwd: repositoryRoot,
    input: files.map(file => ':' + file + '\n').join(''),
    maxBuffer: 128 * 1024 * 1024,
  });
  const data = new Map();
  let offset = 0;
  for (const file of files) {
    const end = batch.indexOf(10, offset);
    const header = batch.toString('utf8', offset, end);
    const match = /^[a-f\d]+ blob (\d+)$/.exec(header);
    if (!match) throw new Error(file + ': cannot read staged file');
    const size = Number(match[1]);
    offset = end + 1;
    if (offset + size >= batch.length || batch[offset + size] !== 10) throw new Error(file + ': invalid staged blob');
    data.set(file, batch.subarray(offset, offset + size));
    offset += size + 1;
  }
  return data;
}
