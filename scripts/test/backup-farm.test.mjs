import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
const script = fileURLToPath(new URL('../backup-farm.sh', import.meta.url)).replaceAll('\\', '/');
const bash = process.env.RDF_TEST_BASH || (process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash');
const path = Object.entries(process.env).find(([key]) => key.toLowerCase() === 'path')?.[1] || '';
const unix = value => value.replaceAll('\\', '/').replace(/^([A-Za-z]):/, (_, drive) => '/' + drive.toLowerCase());
const fakeDocker = String.raw`#!/usr/bin/env bash
set -euo pipefail
{ printf '%s|' "$@"; printf '\n'; } >> "$FAKE_LOG"
if [[ $1 == inspect ]]; then
 case $3 in '{{.Image}}') printf 'sha256:%s\n' "$4" ;;
 *) printf 'APP_STORE_DIR=/custom/apps\nSECRET_VALUE=not-for-archive\n' ;; esac
elif [[ $1 == compose ]]; then
 if [[ " $* " == *' ps -a -q registry '* ]]; then printf 'registry-id\n'
 elif [[ " $* " == *' ps -a -q server '* ]]; then printf 'server-id\n'
 elif [[ " $* " == *' ps --status running --services '* ]]; then printf 'server\nregistry\n'
 elif [[ " $* " == *' exec -T postgres sh '* ]]; then printf 'database-fixture'
 elif [[ " $* " == *' exec -T postgres pg_restore '* ]]; then cat >/dev/null
 fi
elif [[ $1 == run ]]; then
 if [[ $FAKE_FAIL == 1 && " $* " == *'registry-id:ro'* ]]; then exit 17; fi
 tar -C "$FAKE_CONTENT" -cf - .
else exit 23
fi
`;

function fixture(t, fail = false) {
  const dir = mkdtempSync(join(tmpdir(), 'rdf-backup-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, 'bin'), content = join(dir, 'content');
  const backup = join(dir, 'backups'), log = join(dir, 'docker.log');
  for (const path of [bin, content, backup]) mkdirSync(path);
  writeFileSync(join(bin, 'docker'), fakeDocker, { mode: 0o755 });
  writeFileSync(join(content, 'data.txt'), 'archive fixture');
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') delete env[key];
  Object.assign(env, {
    PATH: [bin, ...(process.platform === 'win32' ? ['C:/Program Files/Git/usr/bin'] : []), path].join(delimiter),
    FAKE_BIN: unix(bin), FAKE_CONTENT: unix(content), FAKE_LOG: unix(log), FAKE_FAIL: fail ? '1' : '0',
  });
  const result = spawnSync(bash, [
    '--noprofile', '--norc', '-c', 'export PATH="$FAKE_BIN:$PATH"; exec bash "$@"',
    'backup-test', script, unix(backup), '--project-name', 'test-project', '-f', 'compose.test.yaml',
  ], { env, encoding: 'utf8', timeout: 15000 });
  return { result, child: join(backup, readdirSync(backup)[0]), calls: readFileSync(log, 'utf8').trim().split('\n') };
}

test('archives bypass Docker logging and use bounded containers with existing volumes read-only', t => {
  const f = fixture(t);
  assert.equal(f.result.status, 0, f.result.stderr + f.result.stdout);
  const runs = f.calls.filter(line => line.startsWith('run|'));
  assert.equal(runs.length, 2);
  for (const run of runs) {
    assert.ok(run.includes('--log-driver|none|'));
    assert.ok(run.includes('--network|none|--read-only|'));
    assert.ok(run.includes('--cpus|1|--memory|256m|--pids-limit|64|'));
    assert.ok(run.includes('--cap-drop|ALL|--cap-add|DAC_READ_SEARCH|'));
    assert.ok(run.includes('--pull|never|'));
    assert.equal(run.includes('not-for-archive'), false);
    assert.equal(run.includes('--privileged'), false);
  }
  assert.ok(runs[0].includes('--volumes-from|registry-id:ro|--entrypoint|tar|sha256:registry-id|'));
  assert.ok(runs[1].includes('--volumes-from|server-id:ro|--entrypoint|tar|sha256:server-id|-C|/custom/apps|'));
  assert.equal(readFileSync(join(f.child, 'SHA256SUMS'), 'utf8').trim().split('\n').length, 3);
  assert.ok(f.calls.some(line => line.endsWith('|stop|server|registry|')));
  assert.ok(f.calls.some(line => line.endsWith('|start|server|registry|')));
  assert.equal(f.calls.some(line => line.includes('|start|') && line.includes('|web|')), false);
});

test('failed archive cannot be marked complete and resumes only previously running services', t => {
  const f = fixture(t, true);
  assert.notEqual(f.result.status, 0);
  assert.equal(existsSync(join(f.child, 'SHA256SUMS')), false);
  assert.ok(f.calls.some(line => line.endsWith('|start|server|registry|')));
  assert.equal(f.calls.filter(line => line.startsWith('run|')).length, 1);
});
