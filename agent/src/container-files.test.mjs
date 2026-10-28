import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { writeContainerFiles } from './container-files.mjs';

const shell = process.platform === 'win32'
  ? ['C:/Program Files/Git/bin/bash.exe', 'C:/Program Files/Git/usr/bin/bash.exe'].find(existsSync)
  : '/bin/sh';
const exec = promisify(execFile);
function localExecDocker(directory, { ambiguousAppend = false } = {}) {
  const commands = [], sizes = []; let exitCode = 0, appends = 0;
  return {
    commands, sizes, get appends() { return appends; },
    async request(_method, url, body) {
      if (url.endsWith('/exec')) { commands.push(body); return { Id: 'a'.repeat(32) }; }
      if (url.endsWith('/json')) return { Running: false, ExitCode: exitCode };
      assert.fail('Archive and host filesystem APIs must not be used');
    },
    async requestRaw() {
      const command = commands.at(-1), env = { ...process.env };
      for (const item of command.Env) {
        sizes.push(Buffer.byteLength(item)); const index = item.indexOf('=');
        env[item.slice(0, index)] = item.slice(index + 1).replace(/^\/rdf-network\//, directory.replaceAll('\\', '/') + '/');
      }
      try { await exec(shell, command.Cmd.slice(1), { env, timeout: 5000 }); exitCode = 0; }
      catch (error) { exitCode = Number(error.code) || 1; }
      if (command.Env.some(e => e.startsWith('RDF_WRITE_DATA='))) {
        appends++;
        if (ambiguousAppend) throw new Error('connection lost after append');
      }
      return Buffer.alloc(0);
    },
  };
}

test('runtime file writer rejects traversal, unsupported roots, modes and oversized data before Docker', async () => {
  const docker = { request: () => assert.fail('Invalid input reached Docker') };
  const file = { name: 'proxy.py', mode: 0o600, data: Buffer.from('safe') };
  for (const directory of ['/tmp', '/rdf-network/../etc', '/android-home/']) {
    await assert.rejects(writeContainerFiles(docker, 'c', directory, [file]));
  }
  for (const change of [{ name: '../x' }, { name: 'a/b' }, { name: undefined }, { name: '$(touch x)' },
    { mode: 0o777 }, { data: 'text' }, { data: Buffer.alloc(256 * 1024 + 1) }]) {
    await assert.rejects(writeContainerFiles(docker, 'c', '/rdf-network', [{ ...file, ...change }]));
  }
  await assert.rejects(writeContainerFiles(docker, 'c', '/rdf-network', []));
  await assert.rejects(writeContainerFiles(docker, 'c', '/rdf-network', [file], { timeoutMs: 0 }));
});

test('runtime file writer executes the actual shell protocol with maximum binary data and bounded environment', { skip: !shell }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rdf-container-files-'));
  try {
    const data = randomBytes(256 * 1024), docker = localExecDocker(directory);
    await writeContainerFiles(docker, 'c', '/rdf-network', [{ name: 'capture.png', mode: 0o600, data }]);
    assert.deepEqual(await readFile(path.join(directory, 'capture.png')), data);
    assert.ok(docker.sizes.every(size => size < 40 * 1024));
    assert.deepEqual(await readdir(directory), ['capture.png']);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('ambiguous append is not replayed and cannot replace the previous published file', { skip: !shell }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rdf-container-files-'));
  try {
    await writeFile(path.join(directory, 'proxy.py'), 'previous');
    const docker = localExecDocker(directory, { ambiguousAppend: true });
    await assert.rejects(writeContainerFiles(docker, 'c', '/rdf-network',
      [{ name: 'proxy.py', mode: 0o600, data: randomBytes(60 * 1024) }]), /connection lost/);
    assert.equal(docker.appends, 1);
    assert.equal(await readFile(path.join(directory, 'proxy.py'), 'utf8'), 'previous');
    assert.deepEqual(await readdir(directory), ['proxy.py']);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
