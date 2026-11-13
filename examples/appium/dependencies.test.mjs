import assert from 'node:assert/strict';
import { readdir as readDirectory } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { fs as appiumFs, zip } from '@appium/support';
import { startProcess } from './process.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'rdf-appium-dependencies-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'input');
  for (const name of ['phone.apk', 'nested/tablet.apks', 'folder with spaces/тест.apk', 'ignored/old.apk', 'notes.txt']) {
    const target = path.join(source, name);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, name);
  }
  return { root, source };
}

const expected = ['folder with spaces/тест.apk', 'nested/tablet.apks', 'phone.apk'];
const normalized = files => files.map(file => file.replaceAll('\\', '/')).sort();

test('Appium discovers nested application files with braces, spaces and exclusions', { timeout: 10000 }, async t => {
  const { source } = await fixture(t);
  const files = await appiumFs.glob('**/*.{apk,apks}', { cwd: source, nodir: true, ignore: ['ignored/**'] });
  assert.deepEqual(normalized(files), expected);
  assert.deepEqual(await appiumFs.glob('**/*.missing', { cwd: source }), []);
});

test('Appium archives matching files and restores their names and contents', { timeout: 10000 }, async t => {
  const { root, source } = await fixture(t);
  const archive = path.join(root, 'applications.zip'), destination = path.join(root, 'extracted');
  await zip.toArchive(archive, { cwd: source, pattern: '**/*.{apk,apks}', ignore: ['ignored/**'] });
  await zip.extractAllTo(archive, destination, { useSystemUnzip: false });
  assert.deepEqual(normalized(await appiumFs.glob('**/*', { cwd: destination, nodir: true })), expected);
  for (const name of expected) assert.equal(await readFile(path.join(destination, name), 'utf8'), name);
});

test('a canceled Appium file search stops reading directories', { timeout: 10000 }, async t => {
  const { source } = await fixture(t);
  await mkdir(path.join(source, 'one/two/three'), { recursive: true });
  const controller = new AbortController(), reason = new Error('Search canceled');
  let reads = 0;
  await assert.rejects(appiumFs.glob('**/*', { cwd: source, signal: controller.signal, fs: {
    readdir(directory, options, callback) {
      reads++;
      readDirectory(directory, options, (error, entries) => {
        if (reads === 1) controller.abort(reason);
        callback(error, entries);
      });
    },
  } }), error => error === reason);
  await delay(50);
  assert.equal(reads, 1, 'The canceled search must not descend into child directories');
});

test('the installed Appium driver starts, serves status and shuts down', { timeout: 45000 }, async t => {
  const socket = net.createServer();
  await new Promise((resolve, reject) => { socket.once('error', reject); socket.listen(0, '127.0.0.1', resolve); });
  const { port } = socket.address();
  await new Promise(resolve => socket.close(resolve));
  const env = { ...process.env }; delete env.APPIUM_HOME; delete env.RDF_TOKEN;
  const directory = fileURLToPath(new URL('.', import.meta.url));
  const appium = startProcess(process.execPath, [path.join(directory, 'node_modules/appium/index.js'),
    '--address', '127.0.0.1', '--port', String(port), '--use-drivers', 'uiautomator2', '--log-no-colors'],
  { cwd: directory, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  t.after(() => appium.stop());
  let output = '';
  const collect = chunk => { output = (output + chunk.toString()).slice(-4096); };
  appium.child.stdout.on('data', collect); appium.child.stderr.on('data', collect);
  const url = `http://127.0.0.1:${port}/status`, deadline = Date.now() + 35000;
  let ready = false;
  while (Date.now() < deadline && !appium.result) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
      const status = await response.json();
      if (response.ok && status.value?.ready === true) { ready = true; break; }
    } catch { /* A refused connection is expected until Appium opens its listener. */ }
    await delay(100);
  }
  assert.ok(ready, `Appium did not become ready: ${output}`);
  await appium.stop();
  assert.ok(appium.result);
  await assert.rejects(fetch(url, { signal: AbortSignal.timeout(1000) }));
});
