import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const runner = fileURLToPath(new URL('../../integrations/common/run-tests.sh', import.meta.url));
const bash = process.env.RDF_TEST_BASH || (process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash');
const shellPath = value => process.platform === 'win32' ? value.replaceAll('\\', '/').replace(/^([A-Za-z]):/, (_, d) => '/' + d.toLowerCase()) : value;
function fixture(t, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'rdf-ci-runner-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, 'bin'); mkdirSync(bin);
  const put = (name, body) => writeFileSync(join(dir, name), '#!/usr/bin/env bash\nset -eu\n' + body, { mode: 0o755 });
  for (const tool of ['curl', 'jq']) put('bin/' + tool, 'exit 0\n');
  put('bin/adb', `[ -z "${'$'}{RDF_TOKEN:-}" ] && [ -z "${'$'}{CUSTOM_TOKEN:-}" ] || exit 88
printf 'adb:%s\\n' "$*" >> "$TRACE"
case "$*" in *logcat*) echo fixture-logcat ;; *screencap*) printf fixture-png ;; esac
exit "${'$'}{ADB_EXIT:-0}"\n`);
  put('rdf.sh', `printf 'acquire\\n' >> "$TRACE"
trap 'printf "release\\n" >> "$TRACE"' EXIT
shift 2
ANDROID_SERIAL=fixture:15555 RDF_SESSION=11111111-1111-4111-8111-111111111111 "$@"\n`);
  put('test.sh', `[ -z "${'$'}{RDF_TOKEN:-}" ] && [ -z "${'$'}{CUSTOM_TOKEN:-}" ] || exit 89
[ "$ANDROID_SERIAL" = fixture:15555 ]
printf 'test:%s\\n' "$*" >> "$TRACE"
echo fixture-test-output
exit "${'$'}{TEST_EXIT:-0}"\n`);
  const env = { ...process.env };
  const previousPath = Object.entries(env).find(([k]) => k.toLowerCase() === 'path')?.[1] || '';
  for (const k of Object.keys(env)) if (k.toLowerCase() === 'path') delete env[k];
  Object.assign(env, {
    PATH: [process.platform === 'win32' ? 'C:/Program Files/Git/usr/bin' : '', previousPath].filter(Boolean).join(delimiter),
    FAKE_BIN: shellPath(bin), TRACE: shellPath(join(dir, 'trace')),
    RDF_CLI_SCRIPT: shellPath(join(dir, 'rdf.sh')), RDF_ARTIFACT_DIR: shellPath(join(dir, 'artifacts')),
    RDF_TOKEN: 'fixture-secret', CUSTOM_TOKEN: 'fixture-secret', RDF_TOKEN_VARIABLE: 'CUSTOM_TOKEN',
    ...extra,
  });
  return { dir, run: () => spawnSync(bash, ['--noprofile', '--norc', '-c', 'export PATH="$FAKE_BIN:$PATH"; exec bash "$@"', 'fixture', shellPath(runner), '--', 'bash', shellPath(join(dir, 'test.sh')), 'argument with spaces'], { cwd: dir, env, encoding: 'utf8', timeout: 15000 }),
    trace: () => existsSync(join(dir, 'trace')) ? readFileSync(join(dir, 'trace'), 'utf8') : '' };
}
test('CI runner passes the device and exact arguments, strips credentials, collects artifacts before release', t => {
  const f = fixture(t); const r = f.run();
  assert.equal(r.status, 0, r.stderr);
  assert.match(f.trace(), /^acquire\ntest:argument with spaces\nadb:.*logcat.*\nadb:.*screencap.*\nrelease\n$/);
  assert.equal(readFileSync(join(f.dir, 'artifacts/test.log'), 'utf8'), 'fixture-test-output\n');
  assert.equal(readFileSync(join(f.dir, 'artifacts/logcat.txt'), 'utf8'), 'fixture-logcat\n');
  assert.equal(readFileSync(join(f.dir, 'artifacts/screenshot.png'), 'utf8'), 'fixture-png');
  assert.doesNotMatch(r.stdout + r.stderr, /fixture-secret/);
});
test('test failure survives artifact failure and still releases the session', t => {
  const f = fixture(t, { TEST_EXIT: '7', ADB_EXIT: '9' });
  assert.equal(f.run().status, 7);
  assert.match(f.trace(), /release\n$/);
  assert.equal(existsSync(join(f.dir, 'artifacts/screenshot.png')), false);
});
test('recovery state is never overwritten or reallocated', t => {
  const f = fixture(t); mkdirSync(join(f.dir, 'artifacts'));
  writeFileSync(join(f.dir, 'artifacts/session.json'), 'saved-state');
  assert.equal(f.run().status, 2);
  assert.equal(f.trace(), '');
  assert.equal(readFileSync(join(f.dir, 'artifacts/session.json'), 'utf8'), 'saved-state');
});
test('invalid deadlines and token variable names fail before allocation', t => {
  for (const extra of [{ RDF_TEST_TIMEOUT_SECONDS: '0' }, { RDF_TEST_TIMEOUT_SECONDS: '001' }, { RDF_TOKEN_VARIABLE: 'X;echo secret' }]) {
    const f = fixture(t, extra); assert.equal(f.run().status, 2); assert.equal(f.trace(), '');
  }
});
