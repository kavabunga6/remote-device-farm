import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import test from 'node:test';

const root = fileURLToPath(new URL('../../', import.meta.url));
const runtime = join(root, 'integrations/common/jenkins-runtime.sh');
const bash = process.env.RDF_TEST_BASH || (process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash');
const shellPath = value => process.platform === 'win32' ? value.replaceAll('\\', '/').replace(/^([A-Za-z]):/, (_, d) => '/' + d.toLowerCase()) : value;
function fixture(t, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'rdf-jenkins-runtime-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, 'bin'); mkdirSync(bin);
  const put = (name, code) => writeFileSync(join(dir, name), code, { mode: 0o755 });
  put('bin/curl', '#!/usr/bin/env bash\nFAKE_TOOL=curl exec node "$RDF_SOURCE_ROOT/scripts/test/support/ci-backend.cjs" "$@"\n');
  put('bin/adb', '#!/usr/bin/env bash\nexec node "$RDF_SOURCE_ROOT/scripts/test/support/adb-runtime-backend.cjs" "$@"\n');
  if (process.platform === 'win32') {
    const python = spawnSync('py', ['-3', '-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' });
    assert.equal(python.status, 0);
    put('bin/python3', '#!/usr/bin/env bash\nexec "' + shellPath(python.stdout.trim()) + '" "$@"\n');
  }
  mkdirSync(join(dir, 'home/.android'), { recursive: true });
  put('home/.android/adbkey', 'existing-fixture-baseline');
  put('key', 'fixture-private-key');
  put('trust.pem', 'fixture-trust');
  put('env.sh', 'export TEST_ENVIRONMENT_LOADED=yes\n');
  put('test.sh', '#!/usr/bin/env bash\nset -eu\n[ -z "$(printenv RDF_TOKEN)" ]\n[ "$TEST_ENVIRONMENT_LOADED" = yes ]\n[ "$ANDROID_SERIAL" = fixture:15555 ]\n[ -n "$ADB_SERVER_SOCKET" ]\n[ "$CURL_CA_BUNDLE" = "$RDF_CA_FILE" ]\nprintf ready > "$TEST_READY"\nif [ "$TEST_BLOCK" = 1 ]; then while true; do sleep 0.1; done; fi\nexit "$TEST_EXIT"\n');
  const env = { ...process.env };
  const previousPath = Object.entries(env).find(([key]) => key.toLowerCase() === 'path')?.[1] || '';
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'path' || (key.startsWith('RDF_') && !key.startsWith('RDF_TEST_'))) delete env[key];
  Object.assign(env, {
    PATH: [process.env.RDF_TEST_JQ_DIR, process.platform === 'win32' ? 'C:/Program Files/Git/usr/bin' : '', previousPath].filter(Boolean).join(delimiter),
    FAKE_BIN: shellPath(bin), RDF_SOURCE_ROOT: shellPath(root), TRACE: shellPath(join(dir, 'trace')),
    TMPDIR: shellPath(dir), HOME: shellPath(join(dir, 'home')), STOPPED_FILE: shellPath(join(dir, 'stopped')),
    RDF_CLI_SCRIPT: shellPath(join(root, 'scripts/rdf.sh')), RDF_RUNNER_SCRIPT: shellPath(join(root, 'integrations/common/run-tests.sh')),
    RDF_TEST_SCRIPT: 'test.sh', RDF_ARTIFACT_DIR: shellPath(join(dir, 'artifacts')),
    RDF_URL: 'https://farm.example.com', RDF_PROFILE: 'android-30', RDF_ADB_KEY_ID: '33333333-3333-4333-8333-333333333333',
    RDF_ADB_KEY_FILE: shellPath(join(dir, 'key')), RDF_CA_FILE: shellPath(join(dir, 'trust.pem')), RDF_ENV_SCRIPT: 'env.sh',
    RDF_TOKEN: 'fixture-token', RDF_POLL_SECONDS: '1', RDF_HTTP_TIMEOUT_SECONDS: '2', RDF_RELEASE_TIMEOUT_SECONDS: '2',
    RDF_START_TIMEOUT_SECONDS: '10', TEST_BLOCK: '0', TEST_EXIT: '0', TEST_READY: shellPath(join(dir, 'ready')), RUNTIME_PID_FILE: shellPath(join(dir, 'runtime.pid')), ...extra,
  });
  const arguments_ = ['--noprofile', '--norc', '-c', 'export PATH="$FAKE_BIN:$PATH"; printf "%s" "$BASHPID" > "$RUNTIME_PID_FILE"; exec bash "$1"', 'fixture', shellPath(runtime)];
  return {
    dir, env, arguments_,
    run: () => spawnSync(bash, arguments_, { cwd: dir, env, encoding: 'utf8', timeout: 20000 }),
    json: name => JSON.parse(readFileSync(join(dir, 'artifacts', name), 'utf8')),
    trace: () => existsSync(join(dir, 'trace')) ? readFileSync(join(dir, 'trace'), 'utf8') : '',
  };
}
function assertPrivateCleanup(f) {
  const state = f.json('adb-runtime.json');
  assert.equal(state.serverExited, true);
  assert.equal(state.privateKeyRemoved, true);
  assert.notEqual(state.port, 5037);
  assert.equal(readdirSync(f.dir).some(name => name.startsWith('rdf-adb.')), false);
  assert.equal(readFileSync(join(f.dir, 'home/.android/adbkey'), 'utf8'), 'existing-fixture-baseline');
  assert.equal(readFileSync(join(f.dir, 'key'), 'utf8'), 'fixture-private-key');
}
test('Jenkins runtime uses private ADB and trust, releases the device and records confirmed cleanup', t => {
  const f = fixture(t), result = f.run();
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.deepEqual(f.json('farm-result.json'), { cliExitCode: 0, releaseConfirmed: true });
  assertPrivateCleanup(f);
  assert.match(f.trace(), /"privateAdb":true/);
  assert.match(f.trace(), /"method":"DELETE","path":"\/api\/sessions/);
  assert.doesNotMatch(result.stdout + result.stderr, /fixture-token|fixture-private-key/);
});
test('Jenkins runtime preserves test errors and unconfirmed recovery state', t => {
  for (const extra of [{ TEST_EXIT: '7' }, { CLEANUP_PENDING: '1' }]) {
    const f = fixture(t, extra), result = f.run();
    assert.notEqual(result.status, 0);
    if (extra.TEST_EXIT) assert.equal(result.status, 7);
    assert.equal(f.json('farm-result.json').releaseConfirmed, !extra.CLEANUP_PENDING);
    assert.equal(existsSync(join(f.dir, 'artifacts/session.json')), Boolean(extra.CLEANUP_PENDING));
    assertPrivateCleanup(f);
  }
});
test('Jenkins runtime refuses invalid GPU modes, invalid timeouts, unsafe private-key storage, missing baseline keys and saved sessions before allocation', t => {
  for (const mode of ['gpu', 'key', 'saved', 'timeout', 'privateArtifacts']) {
    const f = fixture(t, mode === 'gpu' ? { RDF_GPU_MODE: 'invalid' } : {});
    if (mode === 'timeout') f.env.RDF_RELEASE_TIMEOUT_SECONDS = 'invalid';
    if (mode === 'privateArtifacts') { mkdirSync(join(f.dir, 'artifacts')); f.env.TMPDIR = shellPath(join(f.dir, 'artifacts')); }
    if (mode === 'key') rmSync(join(f.dir, 'home/.android/adbkey'));
    if (mode === 'saved') { mkdirSync(join(f.dir, 'artifacts')); writeFileSync(join(f.dir, 'artifacts/session.json'), 'keep'); }
    assert.notEqual(f.run().status, 0);
    assert.doesNotMatch(f.trace(), /"method":|"privateAdb"/);
    if (mode === 'saved') assert.equal(readFileSync(join(f.dir, 'artifacts/session.json'), 'utf8'), 'keep');
  }
});
test('Jenkins runtime cancellation waits for CLI release and removes only its own ADB resources', async t => {
  const f = fixture(t, { TEST_BLOCK: '1' });
  const child = spawn(bash, f.arguments_, { cwd: f.dir, env: f.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', data => output += data); child.stderr.on('data', data => output += data);
  const closed = once(child, 'close');
  const limit = Date.now() + 15000;
  while (!existsSync(join(f.dir, 'ready')) && Date.now() < limit && child.exitCode === null) await new Promise(resolve => setTimeout(resolve, 50));
  assert.ok(existsSync(join(f.dir, 'ready')), output);
  const pid = readFileSync(join(f.dir, 'runtime.pid'), 'utf8');
  const signal = spawnSync(bash, ['-c', 'kill -TERM "$1"', 'fixture', pid], { encoding: 'utf8' });
  assert.equal(signal.status, 0, signal.stderr);
  const [status] = await closed;
  assert.equal(status, 143, output);
  assert.equal(f.json('farm-result.json').releaseConfirmed, true);
  assertPrivateCleanup(f);
  assert.match(f.trace(), /"method":"DELETE","path":"\/api\/sessions/);
});
