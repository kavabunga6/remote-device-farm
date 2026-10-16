import { androidOps } from './android-ops.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseUsbDevices, UsbAndroidProvider } from './usb-android.mjs';
import { ProviderRegistry } from './registry.mjs';
import { DeviceProvider } from './base.mjs';
import { QuarantineStore } from './quarantine-store.mjs';
import { assertEmptyUserArea, CommandAndroidWipe, sanitize } from './wipe.mjs';
import { EmulatorProvider } from './emulator.mjs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const okWiper = { wipe: async () => {}, verify: async () => {} };
const makeStore = async () => { const s = new QuarantineStore(await mkdtemp(path.join(tmpdir(), 'rdf-q-'))); await s.load(); return s; };
// Devices must have a verified-clean record to be leasable; tests enroll the phone unless they say otherwise.
const usbWith = async ({ enrolled = true, ...extra } = {}) => {
  const store = extra.store ?? await makeStore();
  if (enrolled && store.ready && !store.isClean('usb-android:R58M123ABC') && !store.isDirty('usb-android:R58M123ABC')) await store.markClean('usb-android:R58M123ABC');
  return new UsbAndroidProvider({ adb: { run: async () => ({}) }, streams: noop, appTransfers: noop,
    execute: execute({ 'adb devices -l': { stdout: ADB_LIST, exitCode: 0 } }), store, wiper: okWiper, ...extra });
};

const ADB_LIST = `List of devices attached
R58M123ABC             device usb:1-2 product:a52q model:SM_A525F device:a52q transport_id:3
emulator-5554          device product:sdk model:sdk transport_id:1
192.168.1.5:5555       device product:x model:y transport_id:2
ZX1G22               unauthorized usb:1-3 transport_id:4
`;
const noop = {};
const execute = (table) => async (cmd, args) => table[`${cmd} ${args.join(' ')}`] ?? { stdout: '', stderr: '', exitCode: 1 };

test('parseUsbDevices keeps only physical USB devices', () => {
  const devices = parseUsbDevices(ADB_LIST);
  assert.deepEqual(devices.map((d) => [d.serial, d.state]), [['R58M123ABC', 'device'], ['ZX1G22', 'unauthorized']]);
  assert.equal(devices[0].model, 'SM_A525F');
});

test('USB provider leases a free device and refuses double lease / unauthorized phones', async () => {
  const usb = await usbWith();
  assert.equal((await usb.start('s-00000001', {})).deviceSerial, 'R58M123ABC');
  await assert.rejects(usb.start('s-00000002', { deviceSerial: 'R58M123ABC' }), /already in use/);
  await assert.rejects(usb.start('s-00000003', { deviceSerial: 'ZX1G22' }), /authorize/);
  await assert.rejects(usb.start('s-00000004', { deviceSerial: 'bad serial' }), /Invalid/);
  assert.deepEqual(usb.tunnelTarget(usb.sessions.get('s-00000001')), { deviceTcp: null, adbServer: 'shared', serial: 'R58M123ABC' });
  await usb.stop('s-00000001'); await usb.settled();
  assert.equal(usb.sessions.size, 0);
});

test('USB provider reports sessions whose phone was unplugged; allowlist hides other phones', async () => {
  const table = { 'adb devices -l': { stdout: ADB_LIST, exitCode: 0 } };
  const usb = new UsbAndroidProvider({ adb: noop, streams: noop, appTransfers: noop, execute: execute(table), allowlist: new Set(['R58M123ABC']), store: await (async () => { const st = await makeStore(); await st.markClean('usb-android:R58M123ABC'); return st; })(), wiper: okWiper });
  await usb.start('s-00000001', {});
  assert.deepEqual(await usb.reconcile(), []);
  table['adb devices -l'] = { stdout: 'List of devices attached\n', exitCode: 0 };
  assert.deepEqual(await usb.reconcile(), ['s-00000001']);
});

test('registry routes by kind and rejects unsupported actions without any per-kind branching', async () => {
  class Fake extends DeviceProvider {
    constructor(kind) { super({ kind, platform: 'android' }); }
    get ops() { return this.kind === 'a' ? { ping: async (s, p, c) => `${this.kind}:${c.sessionId}` } : {}; }
    async start(id) { this.sessions.set(id, {}); return { ok: this.kind }; }
    async stop(id) { this.sessions.delete(id); }
  }
  const registry = new ProviderRegistry([new Fake('a'), new Fake('b')]);
  registry.defaultKind = 'a';
  assert.deepEqual(await registry.start('s1', {}), { ok: 'a' });
  assert.deepEqual(await registry.start('s2', { kind: 'b' }), { ok: 'b' });
  assert.equal(await registry.execute('ping', 's1', {}), 'a:s1');
  assert.throws(() => registry.execute('ping', 's2', {}), /not supported for b devices/);
  assert.throws(() => registry.execute('ping', 'nope', {}), /not running/);
  assert.throws(() => registry.get('zzz'), /Unsupported/);
  await registry.stop('s1');
  assert.equal(registry.owner('s1'), null);
});

test('failed wipe: session ends, device is quarantined, admins are alerted, device is never leased again', async () => {
  const alerts = [];
  const wiper = { wipe: async () => { throw new Error('boom'); }, verify: async () => {} };
  const usb = await usbWith({ wiper, alert: (a) => alerts.push(a) });
  await usb.start('s-00000001', {});
  await usb.stop('s-00000001'); await usb.settled(); // must not throw: the session is over either way
  assert.equal(usb.sessions.size, 0);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].event, 'device.quarantined');
  assert.match(alerts[0].reason, /boom/);
  await assert.rejects(usb.start('s-00000002', { deviceSerial: 'R58M123ABC' }), /quarantined/);
  await assert.rejects(usb.start('s-00000003', {}), /No free USB devices/);
  const item = (await usb.inventory()).find((d) => d.id === 'R58M123ABC');
  assert.equal(item.state, 'quarantined');
});

test('verification failure counts as failed wipe; admin sanitize releases only after success', async () => {
  let healthy = false;
  const wiper = { wipe: async () => {}, verify: async () => { if (!healthy) throw new Error('data remains'); } };
  const usb = await usbWith({ wiper });
  await usb.start('s-00000001', {});
  await usb.stop('s-00000001'); await usb.settled();
  assert.equal(usb.deviceState('R58M123ABC'), 'quarantined');
  const op = usb.nodeOps['device-sanitize'];
  assert.deepEqual(await op({ kind: 'usb-android', deviceId: 'R58M123ABC' }), { deviceId: 'R58M123ABC', clean: false });
  assert.equal(usb.deviceState('R58M123ABC'), 'quarantined');
  healthy = true;
  assert.equal((await op({ kind: 'usb-android', deviceId: 'R58M123ABC' })).clean, true);
  assert.equal((await usb.start('s-00000002', {})).deviceSerial, 'R58M123ABC');
  assert.equal(await op({ kind: 'other', deviceId: 'x' }), undefined);
});

test('lease is persisted as dirty: after an agent crash the device is wiped (or quarantined) before reuse', async () => {
  const store = await makeStore();
  const usb = await usbWith({ store });
  await usb.start('s-00000001', {});
  // "restart" while the phone was unplugged: cannot be restored, must be wiped, which fails -> quarantine
  const alerts = [];
  const after = await usbWith({ store, execute: execute({ 'adb devices -l': { stdout: 'List of devices attached\n', exitCode: 0 } }), alert: (a) => alerts.push(a), wiper: { wipe: async () => { throw new Error('offline'); }, verify: async () => {} } });
  await after.recover();
  await after.settled();
  assert.equal(after.deviceState('R58M123ABC'), 'quarantined');
  assert.equal(alerts.length, 1);
  const clean = await usbWith({ store: await (async () => { const s = new QuarantineStore(store.dir); await s.load(); return s; })() });
  assert.equal(clean.store.isQuarantined('usb-android:R58M123ABC'), true); // survived on disk
});

test('after an agent restart a still-attached leased phone gets its session back instead of being wiped under the user', async () => {
  const store = await makeStore();
  const usb = await usbWith({ store });
  await usb.start('s-00000001', {});
  let wiped = 0;
  const after = await usbWith({ store, wiper: { wipe: async () => { wiped++; }, verify: async () => {} } });
  await after.recover();
  assert.equal(wiped, 0);
  assert.equal(after.sessions.get('s-00000001').serial, 'R58M123ABC');
  await after.stop('s-00000001'); await after.settled(); // the broker no longer knows the session -> kill -> wipe
  assert.equal(wiped, 1);
  assert.equal(after.deviceState('R58M123ABC'), 'free');
});

test('no wipe strategy or unusable state store => fail closed', async () => {
  await assert.rejects((await usbWith({ wiper: null })).start('s-00000001', {}), /No wipe strategy/);
  const broken = new QuarantineStore('/nonexistent-dir');
  await assert.rejects((await usbWith({ store: broken })).start('s-00000001', { deviceSerial: 'R58M123ABC' }), /state store is unavailable/);
});

test('independent user area verification rejects residual apps and shared files', async () => {
 let apps='package:com.private.app\n';
 const adb={run:async (_serial,argv)=>({exitCode:0,stderr:'',stdout:argv.includes('pm')?apps:'Android\nDCIM\n'})};
 await assert.rejects(assertEmptyUserArea(adb,'S1'),/user app/);
 apps='';
 await assert.rejects(assertEmptyUserArea(adb,'S1'),/shared storage/);
});

// A phone that behaves like a real one: settings and files live on the "data partition", a reset script may or may
// not really erase it, boot_id changes on reboot.
function fakePhone() {
  const phone = { boot: 'boot-1', settings: {}, files: new Set(), setup: '1', ready: true, apps: [], sdcard: [], calls: [] };
  phone.adb = { run: async (serial, argv) => {
    const cmd = argv.join(' ');
    phone.calls.push(cmd);
    if (!phone.ready) return { stdout: '', stderr: 'device unauthorized', exitCode: 1 };
    if (cmd.includes('boot_id')) return { stdout: phone.boot + '\n', stderr: '', exitCode: 0 };
    let m = /^shell settings put global (\S+) (\S+)$/.exec(cmd);
    if (m) { phone.settings[m[1]] = m[2]; return { stdout: '', stderr: '', exitCode: 0 }; }
    m = /^shell settings get global (\S+)$/.exec(cmd);
    if (m) return { stdout: (phone.settings[m[1]] ?? 'null') + '\n', stderr: '', exitCode: 0 };
    m = /^shell echo (\S+) > (\S+) && echo \S+ > (\S+)$/.exec(cmd);
    if (m) { phone.files.add(m[2]); phone.files.add(m[3]); return { stdout: '', stderr: '', exitCode: 0 }; }
    m = /^shell \[ -e (\S+) \]/.exec(cmd);
    if (m) return { stdout: phone.files.has(m[1]) ? 'present\n' : 'absent\n', stderr: '', exitCode: 0 };
    if (cmd.includes('user_setup_complete')) return { stdout: phone.setup + '\n', stderr: '', exitCode: 0 };
    if (cmd === 'shell ls -A /sdcard') return { stdout: ['Android', ...phone.sdcard].join('\n') + '\n', stderr: '', exitCode: 0 };
    if (cmd === 'shell pm list packages -3') return { stdout: phone.apps.map((a) => 'package:' + a).join('\n'), stderr: '', exitCode: 0 };
    return { stdout: '', stderr: '', exitCode: 0 };
  } };
  // `erase`: what the reset script really does to the data partition
  phone.script = (erase) => async () => { if (erase) { phone.settings = {}; phone.files = new Set(); phone.sdcard = []; } phone.boot = 'boot-' + Math.random(); return { exitCode: 0, stdout: '', stderr: '' }; };
  return phone;
}

test('command wipe: canaries prove the data partition was erased; exit code and reboot alone are not enough', async () => {
  const phone = fakePhone();
  const wipe = new CommandAndroidWipe(phone.adb, phone.script(true), { command: '/opt/rdf/reset.sh', readyMs: 30, pollMs: 5 });
  const ctx = { canary: await wipe.arm('S1') };
  assert.equal(phone.settings.rdf_wipe_canary, ctx.canary);
  assert.equal((await sanitize(wipe, 'S1', ctx)).ok, true);

  // a "reset" script that reboots the phone but leaves /data untouched must NOT pass
  const lazy = fakePhone();
  const lazyWipe = new CommandAndroidWipe(lazy.adb, lazy.script(false), { command: '/opt/rdf/reset.sh', readyMs: 30, pollMs: 5 });
  const lazyCtx = { canary: await lazyWipe.arm('S1') };
  assert.match((await sanitize(lazyWipe, 'S1', lazyCtx)).reason, /canary setting survived/);

  // settings erased but a file survived (partial erase)
  const partial = fakePhone();
  const partialWipe = new CommandAndroidWipe(partial.adb, async () => { partial.settings = {}; partial.boot = 'x'; return { exitCode: 0, stdout: '', stderr: '' }; }, { command: '/opt/rdf/reset.sh', readyMs: 30, pollMs: 5 });
  assert.match((await sanitize(partialWipe, 'S1', { canary: await partialWipe.arm('S1') })).reason, /canary file survived/);

  // no reboot / still in setup wizard / phone not ready / script failure
  const same = fakePhone();
  const noReboot = new CommandAndroidWipe(same.adb, async () => { same.settings = {}; same.files = new Set(); return { exitCode: 0, stdout: '', stderr: '' }; }, { command: '/opt/rdf/reset.sh', readyMs: 30, pollMs: 5 });
  assert.match((await sanitize(noReboot, 'S1', { canary: await noReboot.arm('S1') })).reason, /did not reboot/);
  const wizard = fakePhone(); wizard.setup = '0';
  const wizardWipe = new CommandAndroidWipe(wizard.adb, wizard.script(true), { command: '/opt/rdf/reset.sh', readyMs: 30, pollMs: 5 });
  assert.match((await sanitize(wizardWipe, 'S1', { canary: await wizardWipe.arm('S1') })).reason, /setup wizard/);
  const dead = fakePhone();
  const deadWipe = new CommandAndroidWipe(dead.adb, async () => { dead.ready = false; return { exitCode: 0, stdout: '', stderr: '' }; }, { command: '/opt/rdf/reset.sh', readyMs: 30, pollMs: 5 });
  assert.match((await sanitize(deadWipe, 'S1', { canary: await deadWipe.arm('S1') })).reason, /not ready/);
  const failing = fakePhone();
  const failWipe = new CommandAndroidWipe(failing.adb, async () => ({ exitCode: 3, stdout: '', stderr: 'bad' }), { command: '/opt/rdf/reset.sh', readyMs: 30, pollMs: 5 });
  assert.match((await sanitize(failWipe, 'S1', { canary: await failWipe.arm('S1') })).reason, /script failed \(exit 3\)/);
  for (const strategy of [wipe, lazyWipe, partialWipe, noReboot, wizardWipe, deadWipe, failWipe]) assert.equal(strategy.boot.size, 0, 'wipe state is released on success or failure');
  assert.throws(() => new CommandAndroidWipe(phone.adb, async () => ({}), { command: 'relative.sh' }), /absolute path/);
});

test('without a recorded canary the wipe plants one itself and verification can never be skipped', async () => {
  const phone = fakePhone();
  const wipe = new CommandAndroidWipe(phone.adb, phone.script(true), { command: '/opt/rdf/reset.sh', readyMs: 30, pollMs: 5 });
  assert.equal((await sanitize(wipe, 'S1', {})).ok, true); // enrollment / manual sanitize
  assert.ok(phone.calls.some((c) => c.includes('settings put global rdf_wipe_canary')));
  await assert.rejects(wipe.verify('S1', {}), /No wipe canary/);
});

test('emulator: stop is verified; failed cleanup blocks the slot and alerts admins after repeated failures', async () => {
  const alerts = [];
  let containers = [{ containerId: 'c1', running: true }];
  const control = { stop: async () => {}, inventory: async () => containers };
  const emu = new EmulatorProvider({ control, adb: noop, streams: noop, appTransfers: noop, envTools: noop,
    slotReservations: noop, metrics: async () => ({}), config: { slots: 2 }, alert: (a) => alerts.push(a) });
  emu.sessions.set('s-00000001', { containerId: 'c1' });
  await assert.rejects(emu.stop('s-00000001'), /still exists/);
  assert.equal(emu.sessions.size, 1); // slot stays occupied
  const registry = new ProviderRegistry([emu]);
  for (let i = 0; i < 3; i++) registry.cleanupFailed('s-00000001', new Error('x'));
  assert.equal(alerts.length, 1);
  assert.throws(() => registry.require('s-00000001'), /not running/); // cleanupPending sessions take no commands
  containers = [];
  await emu.stop('s-00000001');
  assert.equal(emu.sessions.size, 0);
});

test('stop returns immediately while the wipe runs in the background; device is "cleaning" until verified', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const usb = await usbWith({ wiper: { wipe: () => gate, verify: async () => {} } });
  await usb.start('s-00000001', {});
  await usb.stop('s-00000001'); // does not wait for the wipe
  assert.equal(usb.deviceState('R58M123ABC'), 'cleaning');
  await assert.rejects(usb.start('s-00000002', { deviceSerial: 'R58M123ABC' }), /being cleaned/);
  release();
  await usb.settled();
  assert.equal(usb.deviceState('R58M123ABC'), 'free');
});

test('a device the store has never verified is NOT leasable (lost state file, new phone); enrollment wipes it first', async () => {
  const usb = await usbWith({ enrolled: false });
  assert.equal(usb.deviceState('R58M123ABC'), 'unverified');
  await assert.rejects(usb.start('s-00000001', { deviceSerial: 'R58M123ABC' }), /not been verified clean/);
  await assert.rejects(usb.start('s-00000002', {}), /No free USB devices/);
  await usb.maintain(); // heartbeat: wipe + verify in the background
  assert.equal(usb.deviceState('R58M123ABC'), 'cleaning');
  await usb.settled();
  assert.equal(usb.deviceState('R58M123ABC'), 'free');
  assert.equal((await usb.start('s-00000003', {})).deviceSerial, 'R58M123ABC');
});

test('a failed enrollment wipe quarantines the phone instead of offering it', async () => {
  const alerts = [];
  const usb = await usbWith({ enrolled: false, alert: (a) => alerts.push(a), wiper: { wipe: async () => { throw new Error('no adb'); }, verify: async () => {} } });
  await usb.maintain(); await usb.settled();
  assert.equal(usb.deviceState('R58M123ABC'), 'quarantined');
  assert.equal(alerts.length, 1);
  await usb.maintain(); // quarantined devices are left alone until an admin acts
  assert.equal(alerts.length, 1);
});

test('only one wipe per device at a time; a manual sanitize cannot race a running wipe', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const usb = await usbWith({ wiper: { wipe: () => gate, verify: async () => {} } });
  await usb.start('s-00000001', {});
  await usb.stop('s-00000001');
  await assert.rejects(usb.cleanDevice('R58M123ABC', 'manual'), /already in progress/);
  await assert.rejects(usb.nodeOps['device-sanitize']({ kind: 'usb-android', deviceId: 'R58M123ABC' }), /already in progress|already verified/);
  release();
  await usb.settled();
  assert.equal(usb.deviceState('R58M123ABC'), 'free');
});

test('after stop a restart must wipe the device, never resurrect the finished session', async () => {
  const store = await makeStore();
  const usb = await usbWith({ store, wiper: { wipe: () => new Promise(() => {}), verify: async () => {} } }); // wipe "hangs": agent crashes mid-wipe
  await usb.start('s-00000001', {});
  await usb.stop('s-00000001');
  assert.equal(store.sessionOf('usb-android:R58M123ABC'), null);
  let wiped = 0;
  const after = await usbWith({ store, wiper: { wipe: async () => { wiped++; }, verify: async () => {} } });
  await after.recover(); await after.settled();
  assert.equal(after.sessions.size, 0);
  assert.equal(wiped, 1);
  assert.equal(after.deviceState('R58M123ABC'), 'free');
});

test('the lease arms the wipe canary before the device is handed out; failing to arm refuses the lease', async () => {
  const armed = [];
  const usb = await usbWith({ wiper: { arm: async (id) => { armed.push(id); return 'nonce-1'; }, wipe: async () => {}, verify: async () => {} } });
  await usb.start('s-00000001', {});
  assert.deepEqual(armed, ['R58M123ABC']);
  assert.equal(usb.store.canaryOf('usb-android:R58M123ABC'), 'nonce-1');
  const failing = await usbWith({ wiper: { arm: async () => { throw new Error('settings put denied'); }, wipe: async () => {}, verify: async () => {} } });
  await assert.rejects(failing.start('s-00000001', {}), /settings put denied/);
  assert.equal(failing.sessions.size, 0);
  assert.equal(failing.deviceState('R58M123ABC'), 'free'); // nothing was leased, still clean
});

test('serials cannot start with a dash (option injection through a USB device chosen serial)', async () => {
  assert.deepEqual(parseUsbDevices('List of devices attached\n-rf   device usb:1-2 model:x\nOK1    device usb:1-3 model:y\n').map((d) => d.serial), ['OK1']);
  await assert.rejects((await usbWith()).start('s-00000001', { deviceSerial: '--help' }), /Invalid device serial/);
});

test('device-controlled text in a failure reason is flattened and bounded before it reaches admins', async () => {
  const wiper = { wipe: async () => { throw new Error('bad\nINJECT\u0007 ' + 'x'.repeat(1000)); }, verify: async () => {} };
  const result = await sanitize(wiper, 'S1');
  assert.equal(result.ok, false);
  assert.equal(/[\x00-\x1f\x7f]/.test(result.reason), false);
  assert.ok(result.reason.length <= 300);
});


test('provider announcement separates emulator slot capacity from physical USB inventory', async () => {
  const emu = new EmulatorProvider({ control: noop, adb: noop, streams: noop, appTransfers: noop, envTools: noop,
    slotReservations: noop, metrics: async () => ({}), config: { slots: 4 } });
  emu.sessions.set('s-00000001', { containerId: 'c1' });
  const usb = await usbWith();
  const registry = new ProviderRegistry([emu, usb]);
  const inventory = await registry.describeProviders();
  assert.deepEqual(inventory.find(provider => provider.kind === 'emulator').devices, []);
  assert.equal(emu.policy.slots, 4);
  assert.equal(emu.sessions.size, 1);
  const phones = inventory.find(provider => provider.kind === 'usb-android').devices;
  assert.deepEqual(phones.map(device => device.id), ['R58M123ABC', 'ZX1G22']);
  assert.equal(phones[0].state, 'free');
  assert.equal(phones[0].model, 'SM_A525F');
  assert.ok(inventory.find(provider => provider.kind === 'emulator').capabilities.includes('env'));
});


test('emulator provider routes build cancellation by job ID without touching sessions', async () => {
  const calls = [];
  const emu = new EmulatorProvider({ control: { emulatorCancel: async id => { calls.push(id); return { jobs: [{ id, state: 'cancelling' }] }; } },
    adb: noop, streams: noop, appTransfers: noop, envTools: noop, slotReservations: noop, metrics: async () => ({}), config: { slots: 2 } });
  const registry = new ProviderRegistry([emu]);
  assert.equal(registry.isNodeAction('emulator-cancel'), true);
  assert.equal((await registry.nodeAction('emulator-cancel', { jobId: 'build-1' })).jobs[0].state, 'cancelling');
  assert.deepEqual(calls, ['build-1']);
});


test('a recovered Android reaches ready and emits diagnostics when its boot probe completes', async () => {
  const emu = new EmulatorProvider({
    control: { recover: async () => [{ sessionId: 'recovered-session', containerId: 'container', name: 'rdf-recovered-session' }] },
    adb: { connect: async () => {}, run: async () => ({ exitCode: 0, stdout: '1\n' }) },
    streams: noop, appTransfers: noop, envTools: noop, slotReservations: noop,
    metrics: async () => ({}), config: { slots: 1 },
  });
  await emu.recover();
  const entry = emu.sessions.get('recovered-session');
  assert.equal(entry.bootReady, true);
  assert.equal(entry.startupPending, false);
  assert.equal(entry.recoveryPending, false);
  assert.ok(emu.recoveryDiagnostics.some(event => event.sessionId === 'recovered-session' && event.code === 'session.android_ready'));
});


test('state persistence failure blocks subsequent device leases', async () => {
 const store=await makeStore();
 await store.markClean('usb-android:S1');
 store.file=store.dir+'/missing/device-state.json';
 await assert.rejects(store.markClean('usb-android:S1'));
 assert.equal(store.ready,false);
 const provider=new UsbAndroidProvider({adb:noop,streams:noop,appTransfers:noop,execute:execute({}),store,wiper:okWiper});
 assert.throws(()=>provider.assertCanLease('S1'),/store is unavailable/);
});

test('Android providers capture the selected serial without starting an unrelated stream', async () => {
  const calls = [];
  const frame = { mime: 'image/png', data: 'synthetic-png-data' };
  const ops = androidOps({ adb: { screenshot: async serial => { calls.push(serial); return frame; } }, streams: {}, appTransfers: {} });
  assert.equal(await ops.screenshot({ serial: 'owned-device' }), frame);
  assert.deepEqual(calls, ['owned-device']);
});
