import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { AdbClient, runProcess } from './adb.mjs';
import { CommandAndroidWipe, sanitize } from './providers/wipe.mjs';

const run = promisify(execFile);
const SCRIPT = fileURLToPath(new URL('../scripts/reset-android.sh', import.meta.url));
const FAKE = fileURLToPath(new URL('./fixtures/fake-adb.mjs', import.meta.url));
const SERIAL = 'R58M123ABC';
const SHELL = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/sh';
const shellPath = filename => process.platform === 'win32'
  ? filename.replaceAll('\\', '/').replace(/^([A-Za-z]):/, (_, drive) => '/' + drive.toLowerCase()) : filename;
const shellQuote = value => "'" + value.replaceAll("'", "'\\''") + "'";

const cleanPhone = () => ({
  boot: 1, fingerprint: 'google/pixel/android-14', simState: 'ABSENT', lockDisabled: true, accounts: 0, users: [0],
  settings: { global: { boot_count: '7', airplane_mode_on: '0', http_proxy: ':0' }, secure: { android_id: 'abc123', enabled_accessibility_services: '', user_setup_complete: '1' }, system: { screen_brightness: '120' } },
  packages: { 'com.android.chrome': { dirtyData: false }, 'com.android.settings': {}, 'com.android.providers.telephony': {}, 'com.google.android.gms': {} },
  wifi: [{ id: 0, ssid: 'FarmWifi' }], sdcard: ['Android'], tmp: [],
});

async function lab(phone = cleanPhone()) {
  const dir = await mkdtemp(path.join(tmpdir(), 'rdf-reset-'));
  const adb = path.join(dir, 'adb');
  await writeFile(adb, `#!/bin/sh\nexec ${shellQuote(shellPath(process.execPath))} ${shellQuote(shellPath(FAKE))} "$@"\n`);
  await chmod(adb, 0o755);
  const state = path.join(dir, 'phone.json');
  await writeFile(state, JSON.stringify(phone));
  const env = { ...process.env, RDF_ADB: shellPath(adb), FAKE_ADB_STATE: state, AGENT_STATE_DIR: path.join(dir, 'state').replaceAll('\\', '/'),
    RDF_REBOOT_PAUSE: '0', RDF_BOOT_TIMEOUT: '4', PATH: `${dir}${path.delimiter}${process.env.PATH}` };
  const script = async (...args) => run(SHELL, [shellPath(SCRIPT), ...args], { env, windowsHide: true }).then((r) => ({ code: 0, ...r }), (e) => ({ code: e.code, stdout: e.stdout, stderr: e.stderr }));
  const load = async () => JSON.parse(await readFile(state, 'utf8'));
  const edit = async (fn) => { const p = await load(); fn(p); await writeFile(state, JSON.stringify(p)); };
  return { dir, env, script, load, edit };
}

// What a hostile or careless renter can do through the tunnel and the UI.
const makeMess = (p) => {
  p.settings.global.http_proxy = 'evil.example:8080';
  p.settings.global.evil_added = 'x';
  p.settings.secure.enabled_accessibility_services = 'com.evil/.Svc';
  p.settings.system.screen_brightness = '255';
  p.packages['com.evil.app'] = { user: true, dirtyData: true };
  p.packages['com.android.chrome'].dirtyData = true;
  p.packages['com.android.chrome'].disabled = true;
  p.tmp = ['payload.sh', '.hidden'];
  p.sdcard = ['Android', 'DCIM', '.secret'];
  p.wifi.push({ id: 5, ssid: 'EvilAP' });
  p.users = [0, 10];
};

test('capture then reset: a used phone is restored to its baseline and the phone rebooted', async () => {
  const l = await lab();
  assert.equal((await l.script('capture', SERIAL)).code, 0);
  // boot_count changes on its own at every boot: it must be learned as volatile, not treated as tampering
  assert.match(await readFile(path.join(l.env.AGENT_STATE_DIR, 'baselines', SERIAL, 'ignore'), 'utf8'), /global boot_count/);
  await l.edit(makeMess);
  const bootBefore = (await l.load()).boot;
  const result = await l.script(SERIAL);
  assert.equal(result.code, 0, result.stderr);
  const p = await l.load();
  assert.ok(p.boot > bootBefore, 'the phone must have rebooted');
  assert.equal(p.settings.global.http_proxy, ':0');
  assert.equal(p.settings.global.evil_added, undefined);
  assert.equal(p.settings.secure.enabled_accessibility_services, '');
  assert.equal(p.settings.system.screen_brightness, '120');
  assert.equal(p.packages['com.evil.app'], undefined);
  assert.equal(p.packages['com.android.chrome'].disabled, false);
  assert.ok(p.cleared.includes('com.android.chrome'), 'system app data is cleared too');
  assert.ok(!p.cleared.includes('com.android.providers.telephony'), 'protected packages are skipped');
  assert.deepEqual(p.tmp, []);
  assert.deepEqual(p.sdcard, ['Android']);
  assert.deepEqual(p.wifi, [{ id: 0, ssid: 'FarmWifi' }]);
  assert.deepEqual(p.users, [0]);
});

test('refuses (so the agent quarantines) what adb cannot undo: account, screen lock, SIM, adb over TCP', async () => {
  for (const [name, mutate, message] of [
    ['account', (p) => { p.accounts = 1; }, /account\(s\) on the device/],
    ['screen lock', (p) => { p.lockDisabled = false; }, /screen lock/],
    ['SIM', (p) => { p.simState = 'READY'; }, /SIM card is present/],
    ['adb tcp', (p) => { p.props = { 'persist.adb.tcp.port': '5555' }; }, /adb over TCP/],
  ]) {
    const l = await lab();
    assert.equal((await l.script('capture', SERIAL)).code, 0, name);
    await l.edit(mutate);
    const result = await l.script(SERIAL);
    assert.equal(result.code, 1, name);
    assert.match(result.stderr, message, name);
  }
});

test('refuses without a baseline or after an Android update, and refuses a hostile serial', async () => {
  const l = await lab();
  const none = await l.script(SERIAL);
  assert.equal(none.code, 2);
  assert.match(none.stderr, /capture/);
  assert.equal((await l.script('capture', SERIAL)).code, 0);
  await l.edit((p) => { p.fingerprint = 'google/pixel/android-15'; });
  const updated = await l.script(SERIAL);
  assert.equal(updated.code, 2);
  assert.match(updated.stderr, /build changed/);
  for (const bad of ['--help', '-x', 'a;rm -rf /', 'a b', '$(id)', '']) assert.equal((await l.script(bad)).code, 1, bad);
});

test('capture refuses a phone that is not clean to begin with', async () => {
  const dirty = cleanPhone(); dirty.tmp = ['leftover'];
  assert.equal((await (await lab(dirty)).script('capture', SERIAL)).code, 1);
  const lock = cleanPhone(); lock.lockDisabled = false;
  assert.equal((await (await lab(lock)).script('capture', SERIAL)).code, 1);
});

test('a setting name chosen by the renter cannot inject shell commands', async () => {
  const l = await lab();
  assert.equal((await l.script('capture', SERIAL)).code, 0);
  await l.edit((p) => { p.settings.global['x;touch_/sdcard/pwned'] = '1'; });
  const result = await l.script(SERIAL);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /unexpected global setting name/);
  assert.equal((await l.load()).log.some((c) => c.includes('touch_')), false);
});

test('legacy baseline reset removes canaries; this does not prove a full rental wipe', async () => {
  const l = await lab();
  assert.equal((await l.script('capture', SERIAL)).code, 0);
  // The agent spawns `adb` from PATH, so point this process at the fake phone for the duration of the test.
  const saved = { ...process.env };
  Object.assign(process.env, { FAKE_ADB_STATE: l.env.FAKE_ADB_STATE, RDF_ADB: l.env.RDF_ADB, AGENT_STATE_DIR: l.env.AGENT_STATE_DIR, RDF_REBOOT_PAUSE: '0', RDF_BOOT_TIMEOUT: '4', PATH: l.env.PATH });
  try {
    // Windows cannot execute POSIX scripts by their shebang; keep the real
    // process runner and route only this test fixture through its shell.
    const execute = process.platform === 'win32'
      ? (command, args, options) => command === 'adb'
        ? runProcess(process.execPath, [FAKE, ...args], options)
        : runProcess(SHELL, [command, ...args], options)
      : runProcess;
    const wipe = new CommandAndroidWipe(new AdbClient(execute), execute, { command: shellPath(SCRIPT), readyMs: 2000, pollMs: 20 });
    const ctx = { canary: await wipe.arm(SERIAL) };
    assert.ok(ctx.canary);
    await l.edit(makeMess);
    const result = await sanitize(wipe, SERIAL, ctx);
    assert.equal(result.ok, true, result.reason);
  } finally { for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]; Object.assign(process.env, saved); }
});
