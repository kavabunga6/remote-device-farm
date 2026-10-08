import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentControl } from './agent-control.mjs';
import { EmulatorProvider } from './providers/emulator.mjs';
import { SlotReservations } from './capacity.mjs';
import { waitForAndroidBoot } from './android-boot.mjs';

const profile = { image: 'us-docker.pkg.dev/android-emulator-268719/images/30-google-x64-no-metrics:30.1.2', cpu: 2, memoryMb: 4096, diskGb: 8, emulatorParams: '' };
const config = { agentId: 'agent-1', slots: 2, ioContainerOverride: 'io-container', allowedPrefixes: [], nvidiaXorgModuleDir: null };
const host = { kvm: true, slots: 2, cpuCores: 16, memoryTotalMb: 65536, memoryAvailableMb: 65536 };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function controlFixture(docker) {
  const control = new AgentControl(config, { listManaged: async () => [], removeSessionNetworks: async () => {}, ...docker });
  control.hostInfo = async () => ({ kvm: true, nvidiaRuntime: false });
  control.capacity = async () => ({ occupied: [], host });
  return control;
}

test('stop during Docker pull cancels work before create and keeps reservation until settlement', async () => {
  const entered = deferred(), aborted = deferred(), release = deferred(); let creates = 0;
  const control = controlFixture({
    ensureImage: async (image, progress, { signal }) => {
      progress({ stage: 'downloading', currentBytes: 2, totalBytes: 5 }); entered.resolve();
      signal.addEventListener('abort', () => aborted.resolve(), { once: true });
      await release.promise; signal.throwIfAborted();
    }, createEmulator: async () => { creates++; },
  });
  const start = control.handle({ op: 'start', sessionId: 'session-prepare', profile, adbPublicKey: 'QUJDRA==' });
  const rejected = assert.rejects(start, /cancelled/);
  await entered.promise; assert.equal(control.reservations.pending.size, 1);
  const stop = control.handle({ op: 'stop', sessionId: 'session-prepare' });
  await aborted.promise; assert.equal(control.reservations.pending.size, 1);
  release.resolve(); await rejected; await stop;
  assert.equal(creates, 0); assert.equal(control.reservations.pending.size, 0);
});

test('stop racing Docker create removes the new container before releasing its slot', async () => {
  const entered = deferred(), release = deferred(); let managed = [], removed = 0;
  const control = controlFixture({
    ensureImage: async () => {}, listManaged: async () => managed,
    createEmulator: async ({ sessionId }) => { entered.resolve(); await release.promise; managed = [{ Id: 'new-id', State: 'running', Labels: { 'remote-device-farm.session': sessionId } }]; return { containerId: 'new-id', name: 'rdf-' + sessionId }; },
    removeManaged: async () => { removed++; managed = []; },
  });
  const start = control.handle({ op: 'start', sessionId: 'session-create', profile, adbPublicKey: 'QUJDRA==' });
  const rejected = assert.rejects(start, /cancelled/);
  await entered.promise; const stop = control.handle({ op: 'stop', sessionId: 'session-create' });
  release.resolve(); await rejected; await stop;
  assert.equal(removed, 1); assert.deepEqual(managed, []); assert.equal(control.reservations.pending.size, 0);
});

test('provider reports ready only after sys.boot_completed and holds the slot during boot', async () => {
  const entered = deferred(), boot = deferred(), events = [], settings = []; const slots = new SlotReservations();
  const provider = new EmulatorProvider({ config, slotReservations: slots, metrics: async () => host,
    streams: {}, appTransfers: {}, envTools: {},
    control: { start: async (id, p, key, report) => { report({ stage: 'creating' }); return { containerId: 'created', name: 'rdf-' + id, networkEnabled: true }; }, inventory: async () => [{ containerId: 'created', running: true }], stop: async () => {} },
    adb: { publicKey: async () => 'QUJDRA==', connect: async () => {}, run: async (serial, argv) => { if (argv[1] === 'settings') { settings.push(argv); return {exitCode: 0}; } assert.deepEqual(argv, ['shell', 'getprop', 'sys.boot_completed']); entered.resolve(); return boot.promise; } },
  });
  const start = provider.start('session-booting', { profile }, { onProgress: event => events.push(event.stage) });
  await entered.promise; assert.equal(slots.pending.size, 1); assert.equal(provider.sessions.get('session-booting').startupPending, true);
  assert.deepEqual(events, ['creating', 'booting']); assert.deepEqual(await provider.reconcile(), []);
  assert.equal(provider.activeSessions()[0].preparing, true);
  boot.resolve({ exitCode: 0, stdout: '1\n' }); await start;
  assert.equal(events.at(-1), 'ready'); assert.equal(slots.pending.size, 0); assert.equal(provider.sessions.get('session-booting').startupPending, false);
  assert.equal(provider.activeSessions()[0].preparing, false);
  assert.deepEqual(settings, [
    ['shell', 'settings', '--user', 'current', 'put', 'system', 'screen_off_timeout', '2147483647'],
    ['shell', 'settings', '--user', 'current', 'put', 'system', 'show_touches', '1'],
  ]);
});

test('boot timeout is a failure and cancellation cleans up rather than emitting ready', async () => {
  await assert.rejects(waitForAndroidBoot({ connect: async () => {}, run: async () => ({ exitCode: 0, stdout: '0' }) }, 'device:5555', { timeoutMs: 25, pollMs: 2 }), /did not finish booting/);
  const entered = deferred(), controller = new AbortController(), events = []; let stops = 0;
  const slots = new SlotReservations();
  const provider = new EmulatorProvider({ config, slotReservations: slots, metrics: async () => host,
    streams: {}, appTransfers: {}, envTools: {},
    control: { start: async () => ({ containerId: 'created', name: 'device' }), stop: async () => { stops++; } },
    adb: { publicKey: async () => 'QUJDRA==', connect: async () => {}, run: async (serial, argv, { signal }) => { entered.resolve(); return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })); } },
  });
  const start = provider.start('session-cancelboot', { profile }, { signal: controller.signal, onProgress: event => events.push(event.stage) });
  const rejected = assert.rejects(start, /cancel test/); await entered.promise; controller.abort(new Error('cancel test')); await rejected;
  assert.equal(stops, 1); assert.equal(events.includes('ready'), false); assert.equal(provider.sessions.size, 0); assert.equal(slots.pending.size, 0);
});



test('restart recovery waits for verified Android boot while holding existing slot capacity', async () => {
  let booted = false, probes = 0, started = 0;
  const slots = new SlotReservations();
  const entry = { sessionId: 'recovered-session', containerId: 'existing', name: 'rdf-recovered', cpu: 2, memoryMb: 4096, networkEnabled: true };
  const provider = new EmulatorProvider({ config: { ...config, slots: 1 }, slotReservations: slots, metrics: async () => host,
    streams: {}, appTransfers: {}, envTools: {},
    control: { recover: async () => [entry], inventory: async () => [{ containerId: 'existing', running: true }], start: async () => { started++; } },
    adb: { connect: async () => {}, run: async (serial, argv, options) => {
      probes++; assert.equal(serial, 'rdf-recovered:5555'); assert.deepEqual(argv, ['shell', 'getprop', 'sys.boot_completed']);
      assert.equal(options.timeoutMs, 3000); assert.ok(options.signal);
      return { exitCode: 0, stdout: booted ? '1\n' : '0\n' };
    } },
  });
  await provider.recover();
  assert.equal(provider.activeSessions()[0].preparing, true);
  assert.equal(provider.activeSessions()[0].bootReady, false);
  assert.deepEqual(await provider.reconcile(), []);
  assert.equal(slots.pending.size, 0);
  await assert.rejects(provider.start('new-session', { profile }), /No free emulator slots/);
  assert.equal(started, 0);
  booted = true; await provider.maintain();
  assert.equal(provider.activeSessions()[0].preparing, false);
  assert.equal(provider.activeSessions()[0].bootReady, true);
  await provider.maintain(); assert.equal(probes, 2);
});

test('recovery never publishes ready after a stop races its boot probe', async () => {
  const entered = deferred(), boot = deferred(); let exists = true;
  const provider = new EmulatorProvider({ config, slotReservations: new SlotReservations(), metrics: async () => host,
    streams: {}, appTransfers: {}, envTools: {},
    control: { recover: async () => [{ sessionId: 'recover-stop', name: 'rdf-recover-stop', containerId: 'existing', cpu: 2, memoryMb: 4096 }],
      stop: async () => { exists = false; }, inventory: async () => exists ? [{ containerId: 'existing', running: true }] : [] },
    adb: { connect: async () => {}, run: async () => { entered.resolve(); return boot.promise; } },
  });
  const recovery = provider.recover(); await entered.promise;
  const entry = provider.sessions.get('recover-stop');
  await provider.stop('recover-stop');
  boot.resolve({ exitCode: 0, stdout: '1' }); await recovery;
  assert.equal(entry.bootReady, false); assert.deepEqual(provider.activeSessions(), []);
});

test('failed recovery probes remain preparing and vanished or quarantined containers are cleaned up', async () => {
  let attempts = 0;
  const provider = new EmulatorProvider({ config, slotReservations: new SlotReservations(), metrics: async () => host,
    streams: {}, appTransfers: {}, envTools: {},
    control: { recover: async () => [
      { sessionId: 'not-booted', name: 'not-booted', containerId: 'gone' },
      { sessionId: 'unsafe', name: 'unsafe', containerId: 'unsafe', cleanupPending: true },
    ], inventory: async () => [] },
    adb: { connect: async () => { attempts++; throw new Error('device unavailable'); } },
  });
  await provider.recover(); await provider.maintain();
  assert.equal(attempts, 2);
  assert.ok(provider.activeSessions().every(entry => entry.preparing && !entry.bootReady));
  assert.deepEqual(await provider.reconcile(), ['not-booted', 'unsafe']);
});


test('boot probes detect a stopped container even while ADB connect keeps retrying', { timeout: 2000 }, async () => {
  let inventoryCalls = 0, connects = 0, adbCancelled = false;
  await assert.rejects(waitForAndroidBoot({
    connect: async (_serial, { signal }) => {
      connects++;
      await new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => { adbCancelled = true; reject(signal.reason); }, { once: true });
      });
    },
    run: async () => { throw new Error('ADB should never become ready'); },
  }, 'device:5555', {
    timeoutMs: 1000, pollMs: 2, probeTimeoutMs: 10,
    isRunning: async ({ signal }) => { assert.ok(signal); inventoryCalls++; return inventoryCalls === 1; },
  }), { message: 'Emulator container stopped before Android finished booting' });
  assert.equal(inventoryCalls, 2);
  assert.equal(connects, 1);
  assert.equal(adbCancelled, true);
});

test('an unavailable control API is not treated as an exited emulator', async () => {
  let checks = 0;
  await waitForAndroidBoot({ connect: async () => {}, run: async () => ({ exitCode: 0, stdout: '1' }) }, 'device:5555', {
    timeoutMs: 1000,
    isRunning: async () => { checks++; throw new Error('internal control failure with private details'); },
  });
  assert.equal(checks, 2);
});

test('container exit racing the ready probe never reports Android ready', async () => {
  let checks = 0;
  await assert.rejects(waitForAndroidBoot({ connect: async () => {}, run: async () => ({ exitCode: 0, stdout: '1' }) }, 'device:5555', {
    timeoutMs: 1000,
    isRunning: async () => ++checks === 1,
  }), { message: 'Emulator container stopped before Android finished booting' });
  assert.equal(checks, 2);
});

for (const cleanupFails of [false, true]) {
  test(`exited boot container triggers teardown and ${cleanupFails ? 'keeps a failed cleanup slot blocked' : 'releases the slot only after cleanup'}`, async () => {
    const cleanupEntered = deferred(), cleanupRelease = deferred(), events = [];
    const slots = new SlotReservations(); let connects = 0;
    const provider = new EmulatorProvider({ config: { ...config, slots: 1 }, slotReservations: slots, metrics: async () => host,
      streams: {}, appTransfers: {}, envTools: {},
      control: {
        start: async () => ({ containerId: 'exited', name: 'device' }),
        inventory: async () => [{ containerId: 'unrelated', running: true }, { containerId: 'exited', running: false }],
        stop: async () => { cleanupEntered.resolve(); await cleanupRelease.promise; if (cleanupFails) throw new Error('cleanup failed'); },
      },
      adb: { publicKey: async () => 'QUJDRA==', connect: async () => { connects++; } },
    });
    const start = provider.start('session-exited', { profile }, { onProgress: event => events.push(event.stage) });
    const rejected = assert.rejects(start, { message: 'Emulator container stopped before Android finished booting' });
    await cleanupEntered.promise;
    assert.equal(slots.pending.size, 1);
    assert.equal(provider.sessions.has('session-exited'), true);
    assert.equal(events.includes('ready'), false);
    assert.equal(connects, 0);
    cleanupRelease.resolve(); await rejected;
    assert.equal(slots.pending.size, 0);
    if (cleanupFails) {
      assert.equal(provider.sessions.get('session-exited').cleanupPending, true);
      await assert.rejects(provider.start('another-session', { profile }), /No free emulator slots/);
    } else assert.equal(provider.sessions.size, 0);
  });
}


test('a timed-out container status probe does not consume the following ADB readiness budget', { timeout: 2000 }, async () => {
  let statusTimeouts = 0, connects = 0, reads = 0;
  await waitForAndroidBoot({
    connect: async (_serial, { signal }) => { signal.throwIfAborted(); connects++; },
    run: async (_serial, _argv, { signal }) => { signal.throwIfAborted(); reads++; return { exitCode: 0, stdout: '1' }; },
  }, 'device:5555', {
    timeoutMs: 1000, probeTimeoutMs: 10, pollMs: 2,
    isRunning: async ({ signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => { statusTimeouts++; reject(signal.reason); }, { once: true });
    }),
  });
  assert.equal(statusTimeouts, 2);
  assert.equal(connects, 1);
  assert.equal(reads, 1);
});
