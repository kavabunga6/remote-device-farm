import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const bash = process.env.RDF_TEST_BASH || (process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash');
const session = '11111111-1111-4111-8111-111111111111';
const queue = '22222222-2222-4222-8222-222222222222';
const key = '33333333-3333-4333-8333-333333333333';
const windowsPath = value => value.replaceAll('\\', '/');
const envPath = Object.entries(process.env).find(([name]) => name.toLowerCase() === 'path')?.[1] || '';
const queueRow = (state = 'assigned') => ({ id: queue, state, sessionId: state === 'cancelled' ? null : session });
const response = (method, path, body, code = 200, extra = {}) => ({ method, path, body, code, ...extra });

const fake = String.raw`
const fs = require('node:fs');
const args = process.argv.slice(2);
const logFile = process.env.FAKE_LOG;
const plan = JSON.parse(fs.readFileSync(process.env.FAKE_PLAN));
function log(value) { fs.appendFileSync(logFile, JSON.stringify(value) + '\n'); }
if (process.env.FAKE_TOOL === 'adb') {
  log({ adb: args });
  if (args[0] === 'connect') { console.log('connected to ' + args[1]); process.exit(0); }
  if (args.includes('get-state')) { console.log(process.env.FAKE_ADB_STATE || 'device'); process.exit(0); }
  process.exit(1);
}
const value = flag => args[args.indexOf(flag) + 1];
const method = value('-X');
const url = new URL(args.at(-1));
const path = url.pathname + url.search;
const body = args.includes('--data') ? JSON.parse(value('--data')) : null;
const headers = args.flatMap((item,index) => item !== '-H' ? [] : args[index+1] === '@-' ? fs.readFileSync(0, 'utf8').trim().split(/\r?\n/) : [args[index+1]]);
let index = fs.existsSync(process.env.FAKE_INDEX) ? Number(fs.readFileSync(process.env.FAKE_INDEX)) : 0;
let entry = plan[index];
log({ method, path, body, headers, argv: args });
if (!entry || entry.method !== method || entry.path !== path) {
  console.error('unexpected request', method, path, 'expected', entry); process.exit(22);
}
if (!entry.repeat) fs.writeFileSync(process.env.FAKE_INDEX, String(index + 1));
if (entry.delayMs) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, entry.delayMs);
fs.writeFileSync(value('-o'), JSON.stringify(entry.body));
if (entry.fail) process.exit(7);
process.stdout.write(String(entry.code));
`;

function fixture(t, plan, state, extraEnv = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'rdf-cli-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, 'bin'); mkdirSync(bin);
  writeFileSync(join(bin, 'fake.cjs'), fake);
  for (const tool of ['curl', 'adb']) {
    writeFileSync(join(bin, tool), `#!/usr/bin/env bash\nFAKE_TOOL=${tool} exec node "$(dirname "$0")/fake.cjs" "$@"\n`, { mode: 0o755 });
  }
  const stateFile = join(dir, 'state.json');
  if (state) writeFileSync(stateFile, typeof state === 'string' ? state : JSON.stringify(state));
  const planFile = join(dir, 'plan.json'); writeFileSync(planFile, JSON.stringify(plan));
  const log = join(dir, 'requests.jsonl');
  const env = { ...process.env };
  for (const name of ['RDF_DISK_GB', 'RDF_SD_CARD_MB', 'RDF_EMULATOR_PARAMS', 'RDF_PRIVILEGED']) delete env[name];
  for (const name of Object.keys(env)) if (name.toLowerCase() === 'path') delete env[name];
  Object.assign(env, {
    PATH: [bin, process.env.RDF_TEST_JQ_DIR, ...(process.platform === 'win32' ? ['C:/Program Files/Git/usr/bin'] : []), envPath].filter(Boolean).join(delimiter),
    RDF_CLI_SCRIPT: windowsPath(join(root, 'scripts/rdf.sh')),
    RDF_URL: 'https://farm.example.com', RDF_TOKEN: 'fake-token', RDF_STATE_FILE: windowsPath(stateFile),
    RDF_POLL_SECONDS: '1', RDF_HTTP_TIMEOUT_SECONDS: '2', RDF_RELEASE_TIMEOUT_SECONDS: '2',
    RDF_FAKE_BIN: process.platform === 'win32' ? windowsPath(bin).replace(/^([A-Za-z]):/, (_, drive) => '/' + drive.toLowerCase()) : bin,
    FAKE_PLAN: windowsPath(planFile), FAKE_INDEX: windowsPath(join(dir, 'index')), FAKE_LOG: windowsPath(log), ...extraEnv,
  });
  const run = (...args) => spawnSync(bash, ['--noprofile', '--norc', '-c', 'export PATH="$RDF_FAKE_BIN:$PATH"; exec bash "$@"', 'rdf-test', windowsPath(join(root, 'scripts/rdf.sh')), ...args], { env, encoding: 'utf8', timeout: 15000 });
  return { run, stateFile, bin, requests: () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [] };
}
const saved = () => ({ version: 2, url: 'https://farm.example.com', queueId: queue, sessionId: session });
function succeeded(result) { assert.equal(result.status, 0, result.stderr + '\n' + result.stdout); }

test('create uses server queue with explicit key and saves request before a lost response', t => {
  const f = fixture(t, [response('POST', '/api/queue', {}, 201, { fail: true })], undefined, { RDF_ADB_KEY_ID: key, RDF_LABEL: 'quote " and \\ line' });
  const result = f.run('create');
  assert.notEqual(result.status, 0);
  const data = JSON.parse(readFileSync(f.stateFile));
  assert.equal(data.request.adbKeyId, key);
  assert.equal(data.request.hostId, undefined);
  assert.equal(data.request.label, 'quote " and \\ line');
  assert.ok(data.requestKey);
  assert.deepEqual(f.requests()[0].body, data.request);
  assert.ok(f.requests()[0].headers.includes('Idempotency-Key: ' + data.requestKey));
  assert.ok(f.requests()[0].headers.includes('Authorization: Bearer fake-token'));
  assert.equal(f.requests()[0].argv.some(arg => arg.includes('fake-token')), false);
});

test('wait recovers lost create using same key and tolerates assigning session 404', t => {
  const state = { version: 2, url: 'https://farm.example.com', requestKey: 'saved-key', request: { profileId: 'android-30', launchOptions: { diskGb: 12, sdCardMb: 0, emulatorParams: '' } } };
  const f = fixture(t, [
    response('POST', '/api/queue', queueRow('assigning')),
    response('GET', '/api/queue/' + queue, queueRow('assigning')),
    response('GET', '/api/sessions/' + session, {}, 404),
    response('GET', '/api/queue/' + queue, queueRow()),
    response('GET', '/api/sessions/' + session, { session: { id: session, state: 'running' } }),
  ], state, { RDF_DISK_GB: '32', RDF_SD_CARD_MB: '512', RDF_EMULATOR_PARAMS: '-no-boot-anim' });
  succeeded(f.run('wait', '8'));
  assert.deepEqual(f.requests()[0].body.launchOptions, state.request.launchOptions);
  assert.ok(f.requests()[0].headers.includes('Idempotency-Key: saved-key'));
  assert.equal(JSON.parse(readFileSync(f.stateFile)).sessionId, session);
});

test('release does not mistake 202 for completed cleanup', t => {
  const f = fixture(t, [
    response('DELETE', '/api/queue/' + queue, { entry: queueRow() }, 409),
    response('GET', '/api/queue/' + queue, queueRow()),
    response('DELETE', '/api/sessions/' + session, { session: { state: 'stopping' } }, 202),
    response('GET', '/api/sessions/' + session, { session: { state: 'stopping' } }),
    response('GET', '/api/sessions/' + session, {}, 404),
  ], saved());
  succeeded(f.run('release', '8'));
  assert.equal(existsSync(f.stateFile), false);
  assert.equal(f.requests().filter(r => r.method === 'GET' && r.path.includes('/sessions/')).length, 2);
});

test('release timeout preserves session and reports cleanup as unconfirmed', t => {
  const f = fixture(t, [
    response('DELETE', '/api/sessions/' + session, {}, 202),
    response('GET', '/api/sessions/' + session, { session: { state: 'stopping' } }, 200, { repeat: true }),
  ], session);
  const result = f.run('release', '2');
  assert.notEqual(result.status, 0);
  assert.ok(existsSync(f.stateFile));
  assert.match(result.stderr, /cleanup not confirmed/);
});

test('cancel pending queue retains no session and confirms terminal state', t => {
  const f = fixture(t, [
    response('DELETE', '/api/queue/' + queue, queueRow('cancelled')),
    response('GET', '/api/queue/' + queue, queueRow('cancelled')),
  ], { queueId: queue });
  succeeded(f.run('release'));
  assert.equal(existsSync(f.stateFile), false);
});

test('cancel racing allocation waits for assignment then releases actual session', t => {
  const f = fixture(t, [
    response('DELETE', '/api/queue/' + queue, { entry: queueRow('assigning') }, 409),
    response('GET', '/api/queue/' + queue, queueRow('assigning')),
    response('GET', '/api/queue/' + queue, queueRow()),
    response('DELETE', '/api/sessions/' + session, {}, 200),
    response('GET', '/api/sessions/' + session, {}, 404),
  ], { queueId: queue });
  succeeded(f.run('release', '8'));
  assert.equal(existsSync(f.stateFile), false);
});

test('connect bounds unauthorized ADB wait and never stops shared ADB server', t => {
  const f = fixture(t, [response('POST', '/api/sessions/' + session + '/adb-port-access', { host: '192.0.2.5', port: 15555 }, 201)], saved(), { FAKE_ADB_STATE: 'unauthorized' });
  const result = f.run('connect', '2');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /authorization timed out/);
  assert.ok(f.requests().some(r => r.adb?.includes('get-state')));
  assert.equal(f.requests().some(r => r.adb?.includes('kill-server')), false);
});

test('create and managed run refuse to overwrite or release another jobs saved request', t => {
  const f = fixture(t, [], saved());
  assert.notEqual(f.run('create').status, 0);
  assert.notEqual(f.run('run', '--', 'true').status, 0);
  assert.equal(f.requests().length, 0);
  assert.equal(JSON.parse(readFileSync(f.stateFile)).sessionId, session);
});

test('managed run passes device serial, requests a lease, and preserves child exit code after cleanup', t => {
  const f = fixture(t, [
    response('POST', '/api/queue', { id: queue, state: 'waiting' }, 201),
    response('GET', '/api/queue/' + queue, queueRow()),
    response('GET', '/api/sessions/' + session, { session: { id: session, state: 'running' } }),
    response('POST', '/api/sessions/' + session + '/adb-port-access', { host: '192.0.2.5', port: 15555 }, 201),
    response('DELETE', '/api/queue/' + queue, { entry: queueRow() }, 409),
    response('GET', '/api/queue/' + queue, queueRow()),
    response('DELETE', '/api/sessions/' + session, {}, 202),
    response('GET', '/api/sessions/' + session, {}, 404),
  ], undefined, { RDF_RELEASE_TIMEOUT_SECONDS: '8', RDF_DISK_GB: '16', RDF_SD_CARD_MB: '1024', RDF_EMULATOR_PARAMS: '-no-boot-anim', RDF_PRIVILEGED: '1' });
  const result = f.run('run', '--', 'bash', '-c', 'test "$ANDROID_SERIAL" = 192.0.2.5:15555 || exit 99; exit 7');
  assert.equal(result.status, 7, result.stderr);
  assert.equal(existsSync(f.stateFile), false, result.stderr + JSON.stringify(f.requests()));
  assert.equal(f.requests()[0].body.leaseTtlSeconds, 120);
  assert.deepEqual(f.requests()[0].body.launchOptions, { diskGb: 16, sdCardMb: 1024, emulatorParams: '-no-boot-anim', privileged: true });
});


test('managed lease renewal failure stops its command and still confirms release', t => {
  const f = fixture(t, [
    response('POST', '/api/queue', { id: queue, state: 'waiting' }, 201),
    response('GET', '/api/queue/' + queue, queueRow()),
    response('GET', '/api/sessions/' + session, { session: { id: session, state: 'running' } }),
    response('POST', '/api/sessions/' + session + '/adb-port-access', { host: '192.0.2.5', port: 15555 }, 201),
    response('POST', '/api/sessions/' + session + '/keepalive', { error: { message: 'unavailable' } }, 503),
    response('DELETE', '/api/queue/' + queue, { entry: queueRow() }, 409),
    response('GET', '/api/queue/' + queue, queueRow()),
    response('DELETE', '/api/sessions/' + session, {}, 202),
    response('GET', '/api/sessions/' + session, {}, 404),
  ], undefined, { RDF_KEEPALIVE_SECONDS: '2', RDF_RELEASE_TIMEOUT_SECONDS: '8' });
  const result = f.run('run', '--', 'bash', '-c', 'sleep 10; echo SHOULD_NOT_RUN');
  assert.equal(result.status, 143, result.stderr);
  assert.match(result.stderr, /lease renewal failed/);
  assert.doesNotMatch(result.stdout, /SHOULD_NOT_RUN/);
  assert.equal(existsSync(f.stateFile), false, result.stderr);
});


test('heartbeat exits without renewing when the managed parent is killed', t => {
  const f = fixture(t, [
    response('POST', '/api/queue', { id: queue, state: 'waiting' }, 201),
    response('GET', '/api/queue/' + queue, queueRow()),
    response('GET', '/api/sessions/' + session, { session: { id: session, state: 'running' } }),
    response('POST', '/api/sessions/' + session + '/adb-port-access', { host: '192.0.2.5', port: 15555 }, 201),
    response('POST', '/api/sessions/' + session + '/keepalive', {}, 200, { repeat: true }),
  ], undefined, { RDF_KEEPALIVE_SECONDS: '2' });
  const result = f.run('run', '--', 'bash', '-c', 'kill -KILL "$PPID"; sleep 3');
  assert.notEqual(result.status, 0);
  assert.equal(result.error, undefined, result.stderr);
  assert.equal(f.requests().filter(r => r.path?.endsWith('/keepalive')).length, 0);
  assert.equal(existsSync(f.stateFile), true);
});


test('managed command can collect read-only logs before releasing the locked state', t => {
  const f = fixture(t, [
    response('POST', '/api/queue', { id: queue, state: 'waiting' }, 201),
    response('GET', '/api/queue/' + queue, queueRow()),
    response('GET', '/api/sessions/' + session, { session: { id: session, state: 'running' } }),
    response('POST', '/api/sessions/' + session + '/adb-port-access', { host: '192.0.2.5', port: 15555 }, 201),
    response('GET', '/api/sessions/' + session + '/logcat?lines=200', { entries: [{ ts: '12:00', level: 'I', tag: 'app', message: 'captured-before-cleanup' }] }),
    response('DELETE', '/api/queue/' + queue, { entry: queueRow() }, 409),
    response('GET', '/api/queue/' + queue, queueRow()),
    response('DELETE', '/api/sessions/' + session, {}, 202),
    response('GET', '/api/sessions/' + session, {}, 404),
  ], undefined, { RDF_RELEASE_TIMEOUT_SECONDS: '8' });
  const result = f.run('run', '--', 'bash', '-c', 'bash "$RDF_CLI_SCRIPT" logs 200');
  succeeded(result);
  assert.match(result.stdout, /captured-before-cleanup/);
  assert.equal(existsSync(f.stateFile), false);
});


test('cancellation stops an in-flight heartbeat request before releasing the session', t => {
  const f = fixture(t, [
    response('POST', '/api/queue', { id: queue, state: 'waiting' }, 201),
    response('GET', '/api/queue/' + queue, queueRow()),
    response('GET', '/api/sessions/' + session, { session: { id: session, state: 'running' } }),
    response('POST', '/api/sessions/' + session + '/adb-port-access', { host: '192.0.2.5', port: 15555 }, 201),
    response('POST', '/api/sessions/' + session + '/keepalive', {}, 200, { delayMs: 20000 }),
    response('DELETE', '/api/queue/' + queue, { entry: queueRow() }, 409),
    response('GET', '/api/queue/' + queue, queueRow()),
    response('DELETE', '/api/sessions/' + session, {}, 202),
    response('GET', '/api/sessions/' + session, {}, 404),
  ], undefined, { RDF_KEEPALIVE_SECONDS: '1', RDF_RELEASE_TIMEOUT_SECONDS: '8' });
  const start = Date.now();
  const result = f.run('run', '--', 'bash', '-c', 'while ! grep -q /keepalive "$FAKE_LOG"; do sleep 0.1; done; sleep 0.1; kill -TERM "$PPID"; sleep 10; echo SHOULD_NOT_RUN');
  assert.equal(result.error, undefined, result.stderr);
  assert.equal(result.status, 143, result.stderr);
  assert.ok(Date.now() - start < 10000, 'shutdown waited for the blocked heartbeat');
  assert.doesNotMatch(result.stdout, /SHOULD_NOT_RUN/);
  assert.equal(existsSync(f.stateFile), false, result.stderr);
});

test('managed cleanup preserves a failing test exit when the release API fails', t => {
  const f = fixture(t, [
    response('POST', '/api/queue', { id: queue, state: 'waiting' }, 201),
    response('GET', '/api/queue/' + queue, queueRow()),
    response('GET', '/api/sessions/' + session, { session: { id: session, state: 'running' } }),
    response('POST', '/api/sessions/' + session + '/adb-port-access', { host: '192.0.2.5', port: 15555 }, 201),
    response('DELETE', '/api/queue/' + queue, { error: { message: 'unavailable' } }, 503),
  ]);
  const result = f.run('run', '--', 'bash', '-c', 'exit 7');
  assert.equal(result.status, 7, result.stderr);
  assert.match(result.stderr, /cleanup pending/);
  assert.equal(existsSync(f.stateFile), true);
});

test('managed cleanup kills surviving command descendants that ignore TERM', t => {
  const f = fixture(t, [
    response('POST', '/api/queue', { id: queue, state: 'waiting' }, 201),
    response('GET', '/api/queue/' + queue, queueRow()),
    response('GET', '/api/sessions/' + session, { session: { id: session, state: 'running' } }),
    response('POST', '/api/sessions/' + session + '/adb-port-access', { host: '192.0.2.5', port: 15555 }, 201),
    response('DELETE', '/api/queue/' + queue, { entry: queueRow() }, 409),
    response('GET', '/api/queue/' + queue, queueRow()),
    response('DELETE', '/api/sessions/' + session, {}, 202),
    response('GET', '/api/sessions/' + session, {}, 404),
  ], undefined, { RDF_RELEASE_TIMEOUT_SECONDS: '8' });
  const result = f.run('run', '--', 'bash', '-c', 'trap "" TERM; (sleep 3; echo SHOULD_NOT_RUN) & exit 7');
  assert.equal(result.status, 7, result.stderr);
  assert.doesNotMatch(result.stdout, /SHOULD_NOT_RUN/);
  assert.equal(existsSync(f.stateFile), false, result.stderr);
});


test('invalid managed run does not leak temporary response or empty recovery files', t => {
  const scratch = mkdtempSync(join(tmpdir(), 'rdf-cli-empty-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const common = { RDF_STATE_FILE: '', TMPDIR: windowsPath(scratch) };
  const early = fixture(t, [], undefined, { ...common, RDF_POLL_SECONDS: 'invalid' });
  assert.notEqual(early.run('run', '--', 'true').status, 0);
  assert.deepEqual(readdirSync(scratch), []);
  const late = fixture(t, [], undefined, common);
  assert.notEqual(late.run('run').status, 0);
  assert.deepEqual(readdirSync(scratch), []);
});


test('poll intervals cannot extend queue or ADB deadlines', t => {
  const queued = fixture(t, [response('GET', '/api/queue/' + queue, queueRow('waiting'), 200, { repeat: true })], { queueId: queue }, { RDF_POLL_SECONDS: '30' });
  let started = Date.now();
  const waiting = queued.run('wait', '2');
  assert.equal(waiting.error, undefined, waiting.stderr);
  assert.match(waiting.stderr, /startup timed out/);
  assert.ok(Date.now() - started < 7000, 'queue polling exceeded its deadline');
  assert.ok(existsSync(queued.stateFile));

  const adb = fixture(t, [response('POST', '/api/sessions/' + session + '/adb-port-access', { host: '192.0.2.5', port: 15555 }, 201)], saved(), { RDF_POLL_SECONDS: '30', FAKE_ADB_STATE: 'unauthorized' });
  started = Date.now();
  const connecting = adb.run('connect', '2');
  assert.equal(connecting.error, undefined, connecting.stderr);
  assert.match(connecting.stderr, /authorization timed out/);
  assert.ok(Date.now() - started < 7000, 'ADB polling exceeded its deadline');
});

test('release retains state when its deadline expires before queue cancellation can be confirmed', t => {
  const f = fixture(t, [response('DELETE', '/api/queue/' + queue, queueRow('cancelled'), 200, { delayMs: 2500 })], { queueId: queue });
  const result = f.run('release', '2');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /recovery state retained/);
  assert.doesNotMatch(result.stderr, /unbound variable/);
  assert.equal(existsSync(f.stateFile), true);
});

test('release requires confirmation even if DELETE returns 404 at the deadline', t => {
  const f = fixture(t, [response('DELETE', '/api/sessions/' + session, {}, 404, { delayMs: 1500 })], session);
  const result = f.run('release', '1');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /cleanup not confirmed/);
  assert.equal(existsSync(f.stateFile), true);
});

test('managed run validates cleanup and heartbeat configuration before renting a device', t => {
  for (const invalid of [
    { RDF_RELEASE_TIMEOUT_SECONDS: 'invalid' },
    { RDF_CONNECT_TIMEOUT_SECONDS: 'invalid' },
    { RDF_START_TIMEOUT_SECONDS: 'invalid' },
    { RDF_KEEPALIVE_SECONDS: 'invalid' },
    { RDF_KEEPALIVE_SECONDS: '120', RDF_LEASE_TTL_SECONDS: '120' },
    { RDF_LEASE_TTL_SECONDS: '08' },
  ]) {
    const f = fixture(t, [], undefined, invalid);
    const result = f.run('run', '--', 'true');
    assert.notEqual(result.status, 0, JSON.stringify(invalid));
    assert.equal(f.requests().length, 0, result.stderr);
    assert.equal(existsSync(f.stateFile), false, result.stderr);
  }
});

test('connect supports GNU gtimeout when timeout is absent or incompatible', t => {
  const f = fixture(t, [response('POST', '/api/sessions/' + session + '/adb-port-access', { host: '192.0.2.5', port: 15555 }, 201)], saved());
  writeFileSync(join(f.bin, 'timeout'), '#!/usr/bin/env bash\nexit 127\n', { mode: 0o755 });
  writeFileSync(join(f.bin, 'gtimeout'), `#!/usr/bin/env bash
if [ "$1" = --version ]; then printf '%s\\n' 'timeout (GNU coreutils) test'; exit 0; fi
printf '%s\\n' '{"timeout":"gtimeout"}' >> "$FAKE_LOG"
shift
exec "$@"
`, { mode: 0o755 });
  const result = f.run('connect', '3');
  succeeded(result);
  assert.equal(f.requests().filter(entry => entry.timeout === 'gtimeout').length, 2);
  assert.match(result.stdout, /192\.0\.2\.5:15555/);
});


test('create preserves explicit storage and empty launch-argument overrides in recovery state', t => {
  const f = fixture(t, [response('POST', '/api/queue', queueRow('waiting'), 201)], undefined,
    { RDF_DISK_GB: '128', RDF_SD_CARD_MB: '0', RDF_EMULATOR_PARAMS: '', RDF_PRIVILEGED: '0' });
  succeeded(f.run('create'));
  const options = { diskGb: 128, sdCardMb: 0, emulatorParams: '', privileged: false };
  assert.deepEqual(f.requests()[0].body.launchOptions, options);
  assert.deepEqual(JSON.parse(readFileSync(f.stateFile)).request.launchOptions, options);
});

test('create omits launch options when environment overrides are unset', t => {
  const f = fixture(t, [response('POST', '/api/queue', queueRow('waiting'), 201)]);
  succeeded(f.run('create'));
  assert.equal(Object.hasOwn(f.requests()[0].body, 'launchOptions'), false);
});

test('invalid launch overrides fail before allocation or recovery-state creation', t => {
  for (const invalid of [
    { RDF_DISK_GB: '' }, { RDF_DISK_GB: '1' }, { RDF_DISK_GB: '129' }, { RDF_DISK_GB: '08' }, { RDF_DISK_GB: '4.5' },
    { RDF_SD_CARD_MB: '' }, { RDF_SD_CARD_MB: '127' }, { RDF_SD_CARD_MB: '32769' }, { RDF_SD_CARD_MB: '-1' },
    { RDF_SD_CARD_MB: '00' }, { RDF_SD_CARD_MB: '512.5' }, { RDF_EMULATOR_PARAMS: 'x'.repeat(501) },
    { RDF_PRIVILEGED: '' }, { RDF_PRIVILEGED: '2' }, { RDF_PRIVILEGED: 'true' },
  ]) {
    const f = fixture(t, [], undefined, invalid);
    const result = f.run('run', '--', 'true');
    assert.notEqual(result.status, 0, JSON.stringify(invalid));
    assert.match(result.stderr, /RDF_(DISK_GB|SD_CARD_MB|EMULATOR_PARAMS|PRIVILEGED) must/);
    assert.equal(f.requests().length, 0);
    assert.equal(existsSync(f.stateFile), false);
  }
});

test('create asks for a kind of device when no profile id is set', t => {
  const f = fixture(t, [response('POST', '/api/queue', queueRow('waiting'), 201)], undefined,
    { RDF_PROFILE: '', RDF_ANDROID: '14', RDF_DEVICE_TYPE: 'tv', RDF_FLAVOR: 'google_play', RDF_API: '34' });
  succeeded(f.run('create'));
  const body = f.requests()[0].body;
  assert.deepEqual(body.profile, { android: '14', api: 34, deviceType: 'tv', flavor: 'google_play' });
  assert.equal(Object.hasOwn(body, 'profileId'), false);
});

test('create refuses a profile id together with a device selector', t => {
  const f = fixture(t, [], undefined, { RDF_PROFILE: 'android-30', RDF_FORM: 'tablet' });
  const result = f.run('create');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /not both/);
  assert.equal(f.requests().length, 0);
});
