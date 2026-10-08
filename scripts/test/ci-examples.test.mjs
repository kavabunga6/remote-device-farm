import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../../', import.meta.url));
const bash = process.env.RDF_TEST_BASH || (process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash');
const envPath = Object.entries(process.env).find(([name]) => name.toLowerCase() === 'path')?.[1] || '';
const bashPath = value => process.platform === 'win32' ? value.replaceAll('\\', '/').replace(/^([A-Za-z]):/, (_, drive) => '/' + drive.toLowerCase()) : value;
function fixture(t, adapter, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'rdf-ci-example-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, 'bin'); mkdirSync(bin); mkdirSync(join(dir, 'ci'));
  const put = (name, content) => writeFileSync(join(dir, name), '#!/usr/bin/env bash\nset -eu\n' + content + '\n', { mode: 0o755 });
  for (const tool of ['adb', 'curl', 'jq', 'java']) put('bin/' + tool, 'exit 0');
  put('bin/timeout', 'shift 3\nexec "$@"');
  put('gradlew', `
[ -z "${'$'}{RDF_TOKEN:-}" ] || { echo 'farm token leaked to Gradle' >&2; exit 88; }
printf 'gradle:%s\\n' "$*" >> "$TRACE"
case "$1" in clean) exit "${'$'}{BUILD_EXIT:-0}" ;; *) exit "${'$'}{TEST_EXIT:-0}" ;; esac`);
  put('ci/rdf.sh', `
[ "$RDF_TOKEN" = 'fixture-token' ] || { echo 'farm credential missing' >&2; exit 89; }
printf 'rdf:%s\\n' "$*" >> "$TRACE"
case "$1" in
  logs) printf 'fixture logcat\\n'; echo 'fixture diagnostics' >&2; exit "${'$'}{LOG_EXIT:-0}" ;;
  run) shift; shift; ANDROID_SERIAL='fixture:15555' "$@" ;;
  *) exit 90 ;;
esac`);
  copyFileSync(join(root, 'examples', adapter, 'android-tests.sh'), join(dir, 'ci/android-tests.sh'));
  if (adapter === 'teamcity') copyFileSync(join(root, 'examples/teamcity/run-tests.sh'), join(dir, 'ci/teamcity-tests.sh'));
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') delete env[key];
  Object.assign(env, {
    PATH: [...(process.platform === 'win32' ? ['C:/Program Files/Git/usr/bin'] : []), envPath].join(delimiter),
    FAKE_BIN: bashPath(bin), TRACE: bashPath(join(dir, 'trace.txt')),
    ANDROID_SERIAL: 'fixture:15555', RDF_URL: 'https://farm.example.com', RDF_TOKEN: 'fixture-token',
    RDF_PROFILE: 'android-30', RDF_ADB_KEY_ID: '33333333-3333-4333-8333-333333333333', RDF_CI_BUILD_ID: '123',
    RDF_ARTIFACT_DIR: bashPath(join(dir, 'artifacts')), ...extra,
  });
  return {
    dir,
    run: (script = 'android-tests.sh') => spawnSync(bash, ['--noprofile', '--norc', '-c', 'export PATH="$FAKE_BIN:$PATH"; exec bash "$1"', 'ci-fixture', `ci/${script}`],
      { cwd: dir, env, encoding: 'utf8', timeout: 15000 }),
    trace: () => existsSync(join(dir, 'trace.txt')) ? readFileSync(join(dir, 'trace.txt'), 'utf8') : '',
  };
}

for (const adapter of ['jenkins', 'teamcity']) {
  test(`${adapter} Android script strips farm token from Gradle and collects logs after success`, t => {
    const f = fixture(t, adapter);
    const result = f.run();
    assert.equal(result.status, 0, result.stderr);
    assert.match(f.trace(), /gradle:connectedDebugAndroidTest --no-daemon\nrdf:logs 2000/);
    assert.equal(readFileSync(join(f.dir, 'artifacts/logcat.txt'), 'utf8'), 'fixture logcat\n');
  });
  test(`${adapter} Android script preserves test failure even if log collection also fails`, t => {
    const f = fixture(t, adapter, { TEST_EXIT: '7', LOG_EXIT: '9' });
    assert.equal(f.run().status, 7);
    assert.match(f.trace(), /rdf:logs 2000/);
    assert.match(readFileSync(join(f.dir, 'artifacts/logcat-errors.txt'), 'utf8'), /fixture diagnostics/);
  });
}

test('TeamCity builds before acquiring the device and preserves the managed test status', t => {
  const f = fixture(t, 'teamcity', { TEST_EXIT: '6' });
  const result = f.run('teamcity-tests.sh');
  assert.equal(result.status, 6, result.stderr);
  assert.match(f.trace(), /^gradle:clean assembleDebug assembleDebugAndroidTest --no-daemon\nrdf:run -- bash ci\/android-tests.sh\ngradle:connectedDebugAndroidTest/);
  assert.equal(readFileSync(join(f.dir, 'rdf-artifacts/123/logcat.txt'), 'utf8'), 'fixture logcat\n');
});

test('TeamCity never acquires a device when the APK build fails', t => {
  const f = fixture(t, 'teamcity', { BUILD_EXIT: '5' });
  const result = f.run('teamcity-tests.sh');
  assert.equal(result.status, 5, result.stderr);
  assert.doesNotMatch(f.trace(), /rdf:/);
});

test('TeamCity preserves recovery state and refuses to overwrite it before build', t => {
  const f = fixture(t, 'teamcity');
  mkdirSync(join(f.dir, 'rdf-artifacts/123'), { recursive: true });
  writeFileSync(join(f.dir, 'rdf-artifacts/123/session.json'), 'recover me');
  const result = f.run('teamcity-tests.sh');
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /Saved RDF state exists/);
  assert.equal(f.trace(), '');
  assert.equal(readFileSync(join(f.dir, 'rdf-artifacts/123/session.json'), 'utf8'), 'recover me');
});

test('TeamCity rejects unsafe build identifiers before creating files', t => {
  const f = fixture(t, 'teamcity', { RDF_CI_BUILD_ID: '../previous' });
  const result = f.run('teamcity-tests.sh');
  assert.equal(result.status, 2, result.stderr);
  assert.equal(f.trace(), '');
  assert.match(result.stderr, /must be numeric/);
});
