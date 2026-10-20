import { NetworkInspector } from '../network-inspector.mjs';
import { agentMessage } from '../messages.mjs';
import { probeAndroid, androidCapabilities } from './android-capabilities.mjs';
import { diagnosticReporter } from '../session-diagnostics.mjs';
import { DeviceProvider } from './base.mjs';
import { resolveGpuBackend } from '../docker-options.mjs';
import { androidOps } from './android-ops.mjs';
import { validateProfile } from '../config.mjs';
import { waitForAndroidBoot } from '../android-boot.mjs';
import { progressReporter } from '../startup-progress.mjs';
import { MAX_NODE_SLOTS, assertProfileWithinPolicy, validateNodePolicy } from '../node-policy.mjs';

const CLEANUP_ALERT_AFTER = 3;

// Android Emulator in a Docker container, managed through the privileged agent-control process.
// Everything Docker-specific (containers, per-session networks, KVM, slot capacity, egress) lives here.
export class EmulatorProvider extends DeviceProvider {
  constructor({ control, adb, streams, appTransfers, envTools, slotReservations, metrics, config, alert = () => {} }) {
    super({ kind: 'emulator', platform: 'android' });
    Object.assign(this, { control, adb, slotReservations, metrics, config, alert });
    this.policy = { revision: 0, slots: Math.min(config.slots, MAX_NODE_SLOTS), slotCpu: 16, slotMemoryMb: 65536 };
    this.recoveryDiagnostics = [];
    this.shared = androidOps({ adb, streams, appTransfers });
    this.envTools = envTools;
    this.inspector = new NetworkInspector(adb, control);
  }

  get ops() {
    return {
      ...this.shared,
      network: async (s, p, { sessionId }) => {
        if (typeof p.enabled !== 'boolean') throw new Error(agentMessage('agent.1fa0375b158e'));
        const result = await this.control.setEgress(sessionId, p.enabled);
        s.networkEnabled = result.enabled;
        return result;
      },
      'network-inspector': (s, p, { sessionId }) => this.inspector.command(sessionId, s.serial, p),
      camera: (s, p, { sessionId }) => this.control.cameraImage(sessionId, p),
      env: (s, p, ctx) => p.op === 'read' ? this.envTools.read(s.serial, ctx) : this.envTools.apply(s.serial, p.op, p.params, ctx),
    };
  }

  get nodeOps() {
    return {
      'set-policy': (params) => this.applyPolicy(params?.policy),
      // Image catalog of the image builder node: Google system images, builds and pushes to the registry.
      'emulator-catalog': (params) => this.control.emulatorCatalog(params?.refresh === true),
      'emulator-build': (params) => this.control.emulatorBuild(params?.packages, params?.target),
      'emulator-cancel': (params) => this.control.emulatorCancel(params?.jobId),
      'image-cache': params=>this.control.imageCache(params?.protectedRefs ?? []),
      'image-cache-remove': params=>this.control.imageCacheRemove(params?.ids,params?.protectedRefs ?? []),
      'image-prewarm': (params) => this.control.prewarmImage(params?.image, params?.auth ?? null),
      'emulator-jobs': (params) => this.control.emulatorJobs(params?.acknowledged ?? []),
    };
  }

  sessionCapabilities(entry) { return entry.details?.capabilities ?? androidCapabilities(this.capabilities, null).capabilities; }

  describe(entry) { return { ...(entry.details ?? androidCapabilities(this.capabilities, null)), containerId: entry.containerId, networkEnabled: entry.networkEnabled, preparing: entry.startupPending === true, bootReady: entry.bootReady === true }; }

  async recover() {
    for (const entry of await this.control.recover({ onLog: event => {
      if (this.recoveryDiagnostics.length < 4000) this.recoveryDiagnostics.push(event);
    } })) this.sessions.set(entry.sessionId, {
      ...entry, serial: `${entry.name}:5555`, inspectorRecovery: true, startupPending: true, recoveryPending: true, bootReady: false,
    });
    await this.maintain({ onLog: event => { if (this.recoveryDiagnostics.length < 4000) this.recoveryDiagnostics.push(event); } });
  }

  async maintain({ onLog } = {}) {
    await Promise.all([...this.sessions].filter(([, entry]) => entry.recoveryPending && !entry.cleanupPending).map(([sessionId, entry]) => {
      if (entry.recoveryProbe) return entry.recoveryProbe;
      const abort = new AbortController();
      entry.recoveryAbort = abort;
      const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(3000)]);
      entry.recoveryProbe = (async () => {
        try {
          await this.adb.connect(entry.serial, { signal });
          const result = await this.adb.run(entry.serial, ['shell', 'getprop', 'sys.boot_completed'],
            { timeoutMs: 3000, maxOutputBytes: 4096, signal });
          signal.throwIfAborted();
          if (this.sessions.get(sessionId) === entry && result.exitCode === 0 && String(result.stdout).trim() === '1') {
            onLog?.({ sessionId, code: 'session.android_ready', message: agentMessage('agent.androidReady'), severity: 'info', service: 'agent' });
            entry.details = await probeAndroid(this.adb, entry.serial, this.capabilities, { signal });
            signal.throwIfAborted();
            if (entry.inspectorRecovery) { await this.inspector.command(sessionId, entry.serial, { op: 'stop' }).catch(() => {}); entry.inspectorRecovery = false; }
            entry.bootReady = true;
            entry.startupPending = false;
            entry.recoveryPending = false;
          }
        } catch { /* Keep preparing; the next heartbeat retries within the broker's startup deadline. */ }
      })().finally(() => { entry.recoveryProbe = null; entry.recoveryAbort = null; });
      return entry.recoveryProbe;
    }));
  }

  async reconcile() {
    const running = new Set((await this.control.inventory()).filter((c) => c.running).map((c) => c.containerId));
    return [...this.sessions].filter(([, e]) => ((!e.startupPending || e.recoveryPending) && !running.has(e.containerId)) || e.cleanupPending).map(([id]) => id);
  }

  // Emulator capacity is reported by the heartbeat's slots field, not as a physical device.
  async inventory() { return []; }

  tunnelTarget(s) { return { deviceTcp: { host: s.name, port: 5555 }, adbServer: 'isolated', serial: s.serial }; }

  async start(sessionId, params, { onProgress, onLog, signal } = {}) {
    signal?.throwIfAborted();
    const report = progressReporter(onProgress);
    const seenOutput = new Set();
    const emit = event => {
      if (/^container\.(stdout|stderr)$/.test(event.code)) {
        const key = event.code + ':' + event.message;
        if (seenOutput.has(key)) return;
        if (seenOutput.size >= 4000) seenOutput.delete(seenOutput.values().next().value);
        seenOutput.add(key);
      }
      onLog?.(event);
    };
    const log = diagnosticReporter(emit, Object.values(params?.profile?.containerEnv || {}));
    log('session.agent_start', agentMessage('agent.startCheck'));
    const host = await this.metrics();
    signal?.throwIfAborted();
    if (!host.kvm) throw new Error(agentMessage('agent.79aacfc01a6b'));
    const profile = validateProfile(params?.profile, this.config.allowedPrefixes, this.config.trustedPrefixes ?? []);
    assertProfileWithinPolicy(profile, this.policy);
    profile.gpuBackend = resolveGpuBackend(profile, host);
    return this.slotReservations.run(sessionId, () => [...this.sessions.values()].filter(entry => !entry.startupPending || entry.recoveryPending),
      { ...host, slots: this.policy.slots }, profile, async () => {
        const entry = { name: 'rdf-' + sessionId, serial: `rdf-${sessionId}:5555`,
          cpu: profile.cpu, memoryMb: profile.memoryMb, startupPending: true };
        this.sessions.set(sessionId, entry);
        try {
          const key = await this.adb.publicKey(); signal?.throwIfAborted();
          const created = await this.control.start(sessionId, profile, key, report, { signal, onLog: emit });
          Object.assign(entry, created, { serial: `${created.name}:5555` });
          signal?.throwIfAborted();
          log('session.container_started', agentMessage('agent.containerStarted', { p0: created.containerId }));
          report({ stage: 'booting' });
          let lastProbeAt = 0, lastProbe = '', lastSnapshotAt = 0;
          await waitForAndroidBoot(this.adb, entry.serial, {
            onProbe: async message => {
              if (this.control.diagnostics && Date.now() - lastSnapshotAt > 30_000) {
                lastSnapshotAt = Date.now();
                await this.control.diagnostics(sessionId, emit).catch(error => log('container.diagnostics_failed', error.message, 'warning'));
              }
              if (message !== lastProbe || Date.now() - lastProbeAt > 15_000) {
                log('session.boot_probe', message); lastProbe = message; lastProbeAt = Date.now();
              }
            },
            signal,
            isRunning: async (options) => (await this.control.inventory(options))
              .some(container => container.containerId === entry.containerId && container.running === true),
          });
          // The farm owns Android initialization. The SDK's separate host adb is
          // disabled, so keep the screen awake through our authorized connection.
          // Recovery preserves the user's settings; these defaults apply only once.
          for (const [setting, value] of [['screen_off_timeout', '2147483647'], ['show_touches', '1']]) {
            try {
              const result = await this.adb.run(entry.serial,
                ['shell', 'settings', '--user', 'current', 'put', 'system', setting, value],
                { timeoutMs: 5000, signal });
              if (result.exitCode !== 0) throw new Error(agentMessage('agent.androidRejected', { p0: setting }));
            } catch (error) {
              signal?.throwIfAborted();
              console.warn('Could not initialize ' + setting + ' for ' + sessionId + ': ' + error.message);
            }
          }
          log('session.android_ready', agentMessage('agent.androidReady'));
          entry.details = await probeAndroid(this.adb, entry.serial, this.capabilities, { signal });
          signal?.throwIfAborted();
          entry.bootReady = true;
          entry.startupPending = false;
          report({ stage: 'ready' });
          return this.describe(entry);
        } catch (error) {
          log('session.agent_start_failed', error.message, 'error');
          // Teardown finishes before releasing the reservation. A failed teardown keeps the session occupied.
          try { await this.control.stop(sessionId, { onLog: emit }); this.sessions.delete(sessionId); }
          catch (cleanupError) { entry.startupPending = false; entry.cleanupPending = true; entry.cleanupFailures = 1;
            log('session.cleanup_failed', cleanupError.message, 'error');
            this.onCleanupFailure(sessionId, entry, cleanupError); }
          throw error;
        }
      });
  }

  // Reset of an emulator = destroy it. Session state (container, data volume, networks) is deleted by
  // agent-control; we then verify the container is really gone. Any doubt keeps the slot occupied.
  async stop(sessionId, { onLog } = {}) {
    const entry = this.sessions.get(sessionId);
    this.inspector.dispose(sessionId);
    entry?.recoveryAbort?.abort(new Error(agentMessage('agent.edb6e60881d1')));
    await this.control.stop(sessionId, { onLog });
    if (entry && (await this.control.inventory()).some((c) => c.containerId === entry.containerId)) {
      throw new Error(agentMessage('agent.e7e47949c94a'));
    }
    this.sessions.delete(sessionId);
  }

  // The slot stays blocked (the entry remains) and is retried every heartbeat; tell admins once it persists.
  onCleanupFailure(sessionId, entry, error) {
    if (entry.cleanupFailures !== CLEANUP_ALERT_AFTER) return;
    this.alert({ id: `cleanup:${sessionId}`, event: 'device.quarantined', kind: this.kind, deviceId: entry.containerId || sessionId,
      reason: `emulator cleanup failed ${entry.cleanupFailures} times: ${error.message}` });
  }

  async applyPolicy(input) {
    const requested = validateNodePolicy(input);
    this.policy = validateNodePolicy(await this.control.setPolicy(requested));
    return this.policy;
  }
}
