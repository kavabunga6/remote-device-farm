import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../../', import.meta.url));
const template = readFileSync(join(root, 'templates/device-farm.yml'), 'utf8');
const body = template.split('  script:\n    - |\n')[1]?.split('  artifacts:\n')[0];
assert.ok(body, 'component shell block exists');
const script = body.split('\n').map(line => line.startsWith('      ') ? line.slice(6) : line).join('\n');
const bash = process.env.RDF_TEST_BASH || (process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash');
const shellPath = value => process.platform === 'win32' ? value.replaceAll('\\', '/').replace(/^([A-Za-z]):/, (_, d) => '/' + d.toLowerCase()) : value;
function fixture(t, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'rdf-gitlab-component-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, 'bin'); mkdirSync(bin);
  for (const tool of ['curl', 'adb']) writeFileSync(join(bin, tool), `#!/usr/bin/env bash\nFAKE_TOOL=${tool} exec node "$RDF_SOURCE_ROOT/scripts/test/support/ci-backend.cjs" "$@"\n`, { mode: 0o755 });
  writeFileSync(join(dir, 'component.sh'), script);
  writeFileSync(join(dir, 'prepare.sh'), '#!/usr/bin/env bash\n[ -z "${RDF_TOKEN:-}" ] || exit 88\nprintf "prepared\\n" >> "$TRACE"\nexit "${BUILD_EXIT:-0}"\n');
  writeFileSync(join(dir, 'tests.sh'), '#!/usr/bin/env bash\n[ -z "${RDF_TOKEN:-}" ] || exit 89\n[ "$ANDROID_SERIAL" = fixture:15555 ]\necho tests-ran\nexit "${TEST_EXIT:-0}"\n');
  const env = { ...process.env };
  const originalPath = Object.entries(env).find(([k]) => k.toLowerCase() === 'path')?.[1] || '';
  for (const k of Object.keys(env)) if (k.toLowerCase() === 'path' || (k.startsWith('RDF_') && !k.startsWith('RDF_TEST_'))) delete env[k];
  Object.assign(env, {
    PATH: [process.env.RDF_TEST_JQ_DIR, process.platform === 'win32' ? 'C:/Program Files/Git/usr/bin' : '', originalPath].filter(Boolean).join(delimiter),
    FAKE_BIN: shellPath(bin), RDF_SOURCE_ROOT: root.replaceAll('\\', '/'), TRACE: join(dir, 'trace'), STOPPED_FILE: join(dir, 'stopped'),
    RDF_URL: 'https://farm.example.com', RDF_PROFILE: 'android-30', RDF_ADB_KEY_ID: '33333333-3333-4333-8333-333333333333',
    RDF_TOKEN: 'fixture-token', RDF_TOKEN_VARIABLE: 'RDF_TOKEN', RDF_PREPARE_SCRIPT: 'prepare.sh', RDF_TEST_SCRIPT: 'tests.sh',
    RDF_ARTIFACT_DIR: 'rdf-artifacts/123', RDF_STATE_FILE: 'rdf-artifacts/123/session.json',
    RDF_POLL_SECONDS: '1', RDF_HTTP_TIMEOUT_SECONDS: '2', RDF_RELEASE_TIMEOUT_SECONDS: '2', RDF_START_TIMEOUT_SECONDS: '10', ...extra,
  });
  return { dir, run: () => spawnSync(bash, ['--noprofile', '--norc', '-c', 'export PATH="$FAKE_BIN:$PATH"; exec bash component.sh'], { cwd: dir, env, encoding: 'utf8', timeout: 15000 }),
    trace: () => existsSync(join(dir, 'trace')) ? readFileSync(join(dir, 'trace'), 'utf8') : '' };
}
test('GitLab component downloads verified tools and runs the real queue/ADB/release lifecycle', t => {
  const f = fixture(t); const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(f.trace(), /^prepared\n/);
  assert.match(f.trace(), /"method":"POST","path":"\/api\/queue"/);
  assert.match(f.trace(), /"method":"DELETE","path":"\/api\/sessions/);
  assert.equal(existsSync(join(f.dir, 'rdf-artifacts/123/session.json')), false);
  assert.equal(readFileSync(join(f.dir, 'rdf-artifacts/123/logcat.txt'), 'utf8'), 'fixture-logcat\n');
  assert.doesNotMatch(result.stdout + result.stderr, /fixture-token/);
});
test('GitLab test failure keeps its exit code and releases the device', t => {
  const f = fixture(t, { TEST_EXIT: '7' }); assert.equal(f.run().status, 7);
  assert.match(f.trace(), /"method":"DELETE","path":"\/api\/sessions/);
});
test('GitLab preparation or integrity failure cannot allocate a device', t => {
  for (const extra of [{ BUILD_EXIT: '5' }, { CORRUPT_DOWNLOAD: '1' }]) {
    const f = fixture(t, extra); assert.notEqual(f.run().status, 0); assert.doesNotMatch(f.trace(), /"method":/);
  }
});
test('GitLab refuses saved requests and retains state when cleanup is unconfirmed', t => {
  const pending = fixture(t, { CLEANUP_PENDING: '1' }); const result = pending.run();
  assert.notEqual(result.status, 0); assert.ok(existsSync(join(pending.dir, 'rdf-artifacts/123/session.json')));
  const old = fixture(t); mkdirSync(join(old.dir, 'rdf-artifacts/123'), { recursive: true });
  writeFileSync(join(old.dir, 'rdf-artifacts/123/session.json'), 'keep');
  assert.notEqual(old.run().status, 0); assert.equal(old.trace(), '');
  assert.equal(readFileSync(join(old.dir, 'rdf-artifacts/123/session.json'), 'utf8'), 'keep');
});
