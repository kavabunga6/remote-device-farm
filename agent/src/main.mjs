import { diagnostic } from './diagnostics.mjs';
import { agentMessage } from './messages.mjs';
import { runKeyed } from './keyed-queue.mjs';
import { redactDiagnostic } from './session-diagnostics.mjs';
import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';
import { InputGate, INPUT_MAX_AGE_MS } from './input-gate.mjs';
import { watchBrokerSocket } from './transport-liveness.mjs';
import { WebRtcManager } from './webrtc.mjs';
import { loadRtcConfig } from './rtc-config.mjs';
import net from 'node:net';
import { loadConfig, validateProfile } from './config.mjs';
import { ControlClient } from './control-ipc.mjs';
import { AdbClient, runProcess } from './adb.mjs';
import { EnvTools } from './env-tools.mjs';
import { AppTransfers } from './app-transfer.mjs';
import { ManagedAppium, assertAppiumAndroid } from './managed-appium.mjs';
import { AdbServerFilter, adbFailure } from './adb-proxy.mjs';
import { AdbDeviceAuth } from './adb-device-auth.mjs';
import { StreamManager } from './scrcpy.mjs';
import { dispatchCommand, dispatchNodeAction } from './command-dispatch.mjs';
import { SlotReservations } from './capacity.mjs';
import { progressReporter } from './startup-progress.mjs';
import { HostMetricsCollector } from './host-metrics.mjs';
import { ProviderRegistry } from './providers/registry.mjs';
import { EmulatorProvider } from './providers/emulator.mjs';
import { UsbAndroidProvider } from './providers/usb-android.mjs';
import { QuarantineStore } from './providers/quarantine-store.mjs';
import { CommandAndroidWipe } from './providers/wipe.mjs';

const config = loadConfig();
const control = new ControlClient();
const hostMetrics = new HostMetricsCollector(control);
const adb = new AdbClient();
const envTools = new EnvTools(adb, { control, emuMode: config.emuConsole });
const appTransfers = new AppTransfers(adb);
const managedAppium = new ManagedAppium();
const tunnels = new Map();
const locks = new Map();
const startups = new Map();
const slotReservations = new SlotReservations();
const MAX_TUNNELS = 32;
const MAX_TUNNELS_PER_SESSION = 8;
let socket;
let reconnectDelayMs = 1000;
let heartbeatTimer;
let streamDisconnectTimer;
let maintenanceTask;
const heartbeatTasks = new WeakMap();
let rtc;
const relayMedia = new Map();
const relayNeedsKeyframe = new Set();
let closing = false;

const streams = new StreamManager({
  adb,
  serverPath: config.scrcpyServerPath,
  screenshotIntervalMs: config.streamIntervalMs,
  canEmitVideo: sessionId => rtc?.hasPeers(sessionId) || (relayMedia.get(sessionId) !== false && socket?.readyState === WebSocket.OPEN && socket.bufferedAmount < 256 * 1024),
  emit: (event) => { rtc?.publish(event); send(event); },
});
const inputGate = new InputGate({ releaseInput: sessionId => streams.releaseInput(sessionId) });
rtc = new WebRtcManager({ streams, config: loadRtcConfig(),
  input: (sessionId, peerId, meta, params) => dispatchInput({ sessionId, action: 'input', params, input: { ...meta, epoch: peerId } }),
  openInput: (sessionId, epoch) => inputGate.open(sessionId, epoch),
  releaseInput: (sessionId, epoch) => inputGate.release(sessionId, epoch),
});

// Alerts for admins (device quarantined, cleanup stuck). Kept until the broker acknowledges them, and re-sent
// after every reconnect, so an outage cannot swallow one.
const alerts = new Map();
function raiseAlert(alert) {
  alerts.set(alert.id, alert);
  console.error(diagnostic('main.32f13d1a2f', { p0: alert.event, p1: alert.kind, p2: alert.deviceId, p3: alert.reason }));
  send({ type: 'device-alert', ...alert });
}
const resendAlerts = () => { for (const alert of alerts.values()) send({ type: 'device-alert', ...alert }); };

const execute = runProcess;
const deviceStore = new QuarantineStore(config.stateDir);
const providers = [new EmulatorProvider({ control, adb, streams, appTransfers, envTools, slotReservations, metrics: () => hostMetrics.collect(), config, alert: raiseAlert })];
if (config.usb.enabled) {
  const wiper = new CommandAndroidWipe(adb, execute, { command: config.usb.wipeCmd });
  providers.push(new UsbAndroidProvider({ adb, streams, appTransfers, execute, allowlist: config.usb.allowlist, store: deviceStore, wiper, alert: raiseAlert }));
}
const registry = new ProviderRegistry(providers);
const emulator = providers[0];

function send(message) {
  if (socket?.readyState === WebSocket.OPEN) {
    const routedMedia = message.type === 'frame' || message.type === 'video-frame' ||
      (message.type === 'audio-frame' && message.codec === 'opus');
    if (routedMedia && relayMedia.get(message.sessionId) === false) {
      if (message.type === 'video-frame') relayNeedsKeyframe.add(message.sessionId);
      return;
    }
    if (socket.bufferedAmount > 256 * 1024 && ['frame', 'video-frame', 'audio-frame'].includes(message.type)) {
      if (message.type === 'video-frame') relayNeedsKeyframe.add(message.sessionId);
      return;
    }
    if (message.type === 'video-frame' && relayNeedsKeyframe.has(message.sessionId)) {
      if (!message.keyframe) { streams.streams.get(message.sessionId)?.requestKeyframe?.(); return; }
      relayNeedsKeyframe.delete(message.sessionId);
    }
    socket.send(JSON.stringify(message));
    return true;
  }
  return false;
}

const metrics = () => hostMetrics.collect();


async function announce(type, connection = socket) {
  // Slow probes must not queue heartbeats, nor publish a stale hello on a new socket.
  if (type === 'heartbeat') {
    void runMaintenance();
    const previous = heartbeatTasks.get(connection);
    if (previous) return previous;
  }
  const task = (async () => {
    const host = await metrics();
    const capabilities = await registry.describeProviders();
    if (closing || socket !== connection || connection?.readyState !== WebSocket.OPEN) return;
    const sent = send({ type, hostId: config.agentId, name: config.name, slots: emulator.policy.slots,
      policyVersion: 1, policyRevision: emulator.policy.revision,
      metrics: host, activeSessions: registry.activeSessions(),
      ...(type === 'hello' ? { sessionDiagnostics: emulator.recoveryDiagnostics } : {}),
      providers: capabilities });
    if (sent && type === 'hello') emulator.recoveryDiagnostics = [];
  })();
  if (type === 'heartbeat' && connection) heartbeatTasks.set(connection, task);
  try { await task; }
  finally { if (connection && heartbeatTasks.get(connection) === task) heartbeatTasks.delete(connection); }
}

function runMaintenance() {
  if (maintenanceTask) return maintenanceTask;
  maintenanceTask = (async () => {
    await reconcileStoppedSessions();
    await registry.maintainAll({
      onLog: event => send({ type: 'session-log', sessionId: event.sessionId, event }),
    });
  })().catch(error => console.warn(diagnostic('main.8a5781451e', { p0: error.message })))
    .finally(() => { maintenanceTask = undefined; });
  return maintenanceTask;
}

async function reconcileStoppedSessions() {
  for (const provider of providers) {
    for (const sessionId of await registry.reconcile(provider.kind)) {
      await withSessionLock(sessionId, async () => {
        const current = provider.sessions.get(sessionId);
        if (!current) return;
        console.warn(diagnostic('main.f56dfc76bb', { p0: provider.kind, p1: sessionId }));
        const onLog = event => send({ type: 'session-log', sessionId, event });
        onLog({ code: 'session.unexpected_stop', message: agentMessage('agent.unexpectedStop'), severity: 'error', service: 'agent' });
        try { await stop(sessionId, { onLog }); }
        catch (error) { onLog({ code: 'session.cleanup_deferred', message: error.message, severity: 'error', service: 'agent' }); console.warn(diagnostic('main.de47bde201', { p0: sessionId, p1: error.message })); }
      });
    }
  }
}

async function recoverContainers() {
  if (config.usb.enabled) await deviceStore.load();
  await registry.recoverAll();
}

function validSessionId(sessionId) {
  if (typeof sessionId !== 'string' || !/^[a-zA-Z0-9-]{8,64}$/.test(sessionId)) throw new Error(diagnostic('main.2aa56153a9'));
  return sessionId;
}

function withSessionLock(sessionId, fn) {
  return runKeyed(locks, sessionId, fn);
}

async function start(sessionId, params, options) {
  validSessionId(sessionId);
  return registry.start(sessionId, params, options);
}

async function stop(sessionId, options) {
  validSessionId(sessionId);
  const entry = registry.owner(sessionId)?.sessions.get(sessionId);
  entry?.uiAbort?.abort();
  entry?.automationAbort?.abort();
  await managedAppium.stop(sessionId);
  relayMedia.delete(sessionId);
  relayNeedsKeyframe.delete(sessionId);
  await rtc.closeSession(sessionId);
  await inputGate.disposeSession(sessionId);
  await streams.dispose(sessionId);
  for (const [id, tunnel] of tunnels) {
    if (tunnel.sessionId === sessionId) closeTunnel(id, true);
  }
  try { await registry.stop(sessionId, options); }
  catch (error) { registry.cleanupFailed(sessionId, error); throw error; }
  return { stopped: true };
}

async function command(message, options) {
  if (registry.isNodeAction(message.action)) {
    return dispatchNodeAction(message.action, message.params, { registry, announce });
  }
  const sessionId = validSessionId(message.sessionId);
  const params = message.params || {};
  switch (message.action) {
    case 'appium': {
      const { provider, session } = registry.require(sessionId);
      assertAppiumAndroid(provider.describe(session).sdkLevel);
      session.automationAbort ??= new AbortController();
      return managedAppium.request(sessionId, session.serial, params, { signal: session.automationAbort.signal });
    }
    case 'input-open': registry.require(sessionId); return inputGate.open(sessionId, params.epoch);
    case 'input-release': return inputGate.release(sessionId, params.epoch);
    case 'rtc-capabilities': return rtc.capabilities();
    case 'rtc-offer': { const { session } = registry.require(sessionId); return rtc.offer(sessionId, session.serial, params); }
    case 'rtc-close': return rtc.close(sessionId, params.peerId);
    case 'rtc-renew': return rtc.renew(sessionId, params.peerId);
    case 'stream-start': relayMedia.set(sessionId, params.relayMedia !== false); return registry.execute(message.action, sessionId, params);
    case 'start': return start(sessionId, params, options);
    case 'stop':
    case 'kill': await appTransfers.discardSession(sessionId); return stop(sessionId, options);
    default: return registry.execute(message.action, sessionId, params);
  }
}

async function dispatchInput(message) {
  validSessionId(message.sessionId);
  const ephemeral = !message.input;
  if (ephemeral && message.params?.kind === 'touch') throw new Error(diagnostic('main.467e4fc3ec'));
  const meta = message.input || { epoch: randomUUID(), seq: 1, deadline: Date.now() + INPUT_MAX_AGE_MS };
  if (ephemeral) inputGate.open(message.sessionId, meta.epoch);
  try {
    return await inputGate.dispatch(message.sessionId, meta, message.params, assertInputFresh => {
      const guarded = { ...message, params: { ...message.params, inputDeadline: meta.deadline } };
      return dispatchCommand(guarded, {
        command: () => command(guarded), withSessionLock, registry, streams, validateSessionId: validSessionId, assertInputFresh,
      });
    });
  } finally { if (ephemeral) await inputGate.release(message.sessionId, meta.epoch); }
}

async function handleCommand(message) {
  const id = message.id;
  if (typeof id !== 'string' || id.length > 128) return;
  const startup = message.action === 'start' ? new AbortController() : null;
  if (startup) {
    if (startups.has(message.sessionId)) { send({ type: 'result', id, ok: false, error: 'Session startup is already pending' }); return; }
    startups.set(message.sessionId, startup);
  }
  if (['stop', 'kill'].includes(message.action)) startups.get(message.sessionId)?.abort(new Error(agentMessage('agent.1af461dcc07c')));
  const options = startup ? { signal: AbortSignal.any([startup.signal, AbortSignal.timeout(60 * 60_000)]), onProgress: progressReporter(progress =>
    send({ type: 'startup-progress', requestId: id, sessionId: message.sessionId, progress })) } : {};
  if (['start', 'stop', 'kill'].includes(message.action)) options.onLog = event => send({ type: 'session-log', requestId: id, sessionId: message.sessionId, event });
  try {
    const data = message.action === 'input' ? await dispatchInput(message) : await dispatchCommand(message, {
      command: () => command(message, options), withSessionLock, registry, streams, validateSessionId: validSessionId,
    });
    send({ type: 'result', id, ok: true, data });
  } catch (error) {
    send({ type: 'result', id, ok: false, error: ['start', 'stop', 'kill'].includes(message.action) ? redactDiagnostic(error.message || 'Agent command failed', [...Object.values(message.params?.profile?.containerEnv || {}), message.params?.profile?.registryAuth?.password]) : error.message || 'Agent command failed', ...(typeof error.code === 'string' && (error.code.startsWith('input_') || error.code === 'device_capability_unavailable') ? { code: error.code } : {}) });
  } finally { if (startup && startups.get(message.sessionId) === startup) startups.delete(message.sessionId); }
}

function closeTunnel(tunnelId, notify = false) {
  const tunnel = tunnels.get(tunnelId);
  if (!tunnel) return;
  tunnels.delete(tunnelId);
  clearTimeout(tunnel.authTimer);
  tunnel.socket?.destroy();
  if (tunnel.adbPort) runProcess('adb', ['-P', String(tunnel.adbPort), 'kill-server'], { timeoutMs: 5000 }).catch(() => {});
  if (notify) send({ type: 'tunnel-close', tunnelId });
}

async function freeLoopbackPort() {
  return new Promise((resolve, reject) => {
    const listener = net.createServer();
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', () => {
      const port = listener.address().port;
      listener.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function processTunnelData(tunnelId, tunnel, bytes) {
  try {
    if (tunnel.mode === 'device') {
      for (const chunk of tunnel.auth.fromClient(bytes)) {
        if (!tunnel.socket || tunnel.socket.destroyed ||
            tunnel.socket.writableLength + chunk.length > 4 * 1024 * 1024) {
          throw new Error(diagnostic('main.dc635f2bd1'));
        }
        tunnel.socket.write(chunk);
      }
      return;
    }
    for (const chunk of tunnel.filter.transform(bytes)) {
      if (!tunnel.socket || tunnel.socket.destroyed ||
          tunnel.socket.writableLength + chunk.length > 4 * 1024 * 1024) {
        throw new Error(diagnostic('main.bc283d8723'));
      }
      tunnel.socket.write(chunk);
    }
    if (tunnel.filter.syntheticResponse) {
      send({ type: 'tunnel-data', tunnelId, data: tunnel.filter.syntheticResponse.toString('base64') });
      closeTunnel(tunnelId, true);
    }
  } catch (error) {
    if (tunnel.mode !== 'device') send({ type: 'tunnel-data', tunnelId, data: adbFailure(error.message).toString('base64') });
    closeTunnel(tunnelId, true);
  }
}

async function connectIsolatedAdb(tunnelId, tunnel, port, serial) {
  tunnel.adbPort = port;
  const started = await runProcess('adb', ['-P', String(port), 'start-server'], { timeoutMs: 10000 });
  if (started.exitCode !== 0) throw new Error(started.stderr || diagnostic('main.a9fdf936fa'));
  let connected = false;
  for (let attempt = 0; attempt < 15 && tunnels.get(tunnelId) === tunnel; attempt++) {
    const result = await runProcess('adb', ['-P', String(port), 'connect', serial], { timeoutMs: 5000 }).catch(() => null);
    if (result?.exitCode === 0 && !/failed|unable|cannot/i.test(result.stdout)) { connected = true; break; }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  if (tunnels.get(tunnelId) !== tunnel) {
    await runProcess('adb', ['-P', String(port), 'kill-server'], { timeoutMs: 5000 }).catch(() => {});
    return;
  }
  if (!connected) throw new Error(diagnostic('main.3b2aa8195d'));
}

async function handleTunnelOpen(message) {
  const { tunnelId, sessionId } = message;
  if (typeof tunnelId !== 'string' || tunnelId.length > 128 || tunnels.has(tunnelId)) return;
  const mode = message.mode === 'device' ? 'device' : message.mode === undefined ? 'server' : null;
  if (!mode) { send({ type: 'tunnel-close', tunnelId }); return; }
  let session;
  let target;
  try {
    const found = registry.require(sessionId);
    session = found.session;
    target = found.provider.tunnelTarget(session);
    if (!target || (mode === 'device' && !target.deviceTcp)) throw new Error(diagnostic('main.d09ed996af'));
  } catch { send({ type: 'tunnel-close', tunnelId }); return; }
  if (tunnels.size >= MAX_TUNNELS ||
      [...tunnels.values()].filter((entry) => entry.sessionId === sessionId).length >= MAX_TUNNELS_PER_SESSION) {
    send({ type: 'tunnel-data', tunnelId, data: adbFailure('Too many active ADB tunnels').toString('base64') });
    send({ type: 'tunnel-close', tunnelId });
    return;
  }
  const tunnel = { sessionId, mode, filter: mode === 'server' ? new AdbServerFilter(target.serial) : null,
    socket: null, adbPort: null, queue: [], queueSize: 0 };
  tunnels.set(tunnelId, tunnel);
  try {
    if (mode === 'device') {
      tunnel.auth = new AdbDeviceAuth(await adb.authSigner());
      if (tunnels.get(tunnelId) !== tunnel) return;
      tunnel.authTimer = setTimeout(() => {
        send({ type: 'session-log', sessionId, event: { service: 'agent', severity: 'error',
          code: 'session.adb_device_auth_failed', message: diagnostic('main.ff44989e5d') } });
        closeTunnel(tunnelId, true);
      }, 12_000);
      tunnel.authTimer.unref();
      const tcp = net.connect(target.deviceTcp);
      tcp.setNoDelay(true);
      tunnel.socket = tcp;
      tcp.on('connect', () => {
        for (const bytes of tunnel.queue) {
          if (tunnels.get(tunnelId) !== tunnel) break;
          processTunnelData(tunnelId, tunnel, bytes);
        }
        tunnel.queue = [];
        tunnel.queueSize = 0;
      });
      tcp.on('data', buffer => {
        if (socket?.bufferedAmount > 8 * 1024 * 1024) return closeTunnel(tunnelId, true);
        try {
          const { toClient, toDevice } = tunnel.auth.fromDevice(buffer);
          for (const chunk of toDevice) tcp.write(chunk);
          for (const chunk of toClient) send({ type: 'tunnel-data', tunnelId, data: chunk.toString('base64') });
          if (tunnel.auth.ready) clearTimeout(tunnel.authTimer);
        } catch (error) {
          send({ type: 'session-log', sessionId, event: { service: 'agent', severity: 'error',
            code: 'session.adb_device_auth_failed', message: redactDiagnostic(error.message) } });
          closeTunnel(tunnelId, true);
        }
      });
      tcp.on('error', () => closeTunnel(tunnelId, true));
      tcp.on('close', () => closeTunnel(tunnelId, true));
      return;
    }
    // Emulators get a private adb server per tunnel. USB phones live behind the agent's shared adb server
    // (it owns the USB interface); AdbServerFilter pins the tunnel to the leased serial.
    const shared = target.adbServer === 'shared';
    const port = shared ? 5037 : await freeLoopbackPort();
    if (!shared) await connectIsolatedAdb(tunnelId, tunnel, port, target.serial);
    if (tunnels.get(tunnelId) !== tunnel) return;
    const tcp = net.connect({ host: '127.0.0.1', port });
    tunnel.socket = tcp;
    tcp.on('connect', () => {
      for (const bytes of tunnel.queue) {
        if (tunnels.get(tunnelId) !== tunnel) break;
        processTunnelData(tunnelId, tunnel, bytes);
      }
      tunnel.queue = [];
      tunnel.queueSize = 0;
    });
    tcp.on('data', (buffer) => {
      if (socket?.bufferedAmount > 8 * 1024 * 1024) return closeTunnel(tunnelId, true);
      try {
        const { toClient, toServer } = tunnel.filter.fromServer(buffer);
        for (const chunk of toClient) send({ type: 'tunnel-data', tunnelId, data: chunk.toString('base64') });
        for (const chunk of toServer) tcp.write(chunk);
      } catch (error) {
        send({ type: 'tunnel-data', tunnelId, data: adbFailure(error.message).toString('base64') });
        closeTunnel(tunnelId, true);
      }
    });
    tcp.on('error', () => closeTunnel(tunnelId, true));
    tcp.on('close', () => closeTunnel(tunnelId, true));
  } catch (error) {
    if (mode === 'device') send({ type: 'session-log', sessionId, event: { service: 'agent', severity: 'error',
      code: 'session.adb_device_auth_failed', message: redactDiagnostic(error.message) } });
    if (mode !== 'device') send({ type: 'tunnel-data', tunnelId, data: adbFailure(error.message).toString('base64') });
    closeTunnel(tunnelId, true);
  }
}

function handleTunnelData(message) {
  const tunnel = tunnels.get(message.tunnelId);
  if (!tunnel || typeof message.data !== 'string' || message.data.length > 180000 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(message.data)) return closeTunnel(message.tunnelId, true);
  const bytes = Buffer.from(message.data, 'base64');
  if (!tunnel.socket?.readyState || tunnel.socket.connecting) {
    tunnel.queueSize += bytes.length;
    if (tunnel.queueSize > 1024 * 1024) return closeTunnel(message.tunnelId, true);
    tunnel.queue.push(bytes);
  } else processTunnelData(message.tunnelId, tunnel, bytes);
}

function connect() {
  if (closing) return;
  const connection = new WebSocket(config.brokerUrl, { headers: { Authorization: `Bearer ${config.token}` }, maxPayload: 80 * 1024 * 1024 });
  socket = connection;
  watchBrokerSocket(connection);
  socket.on('open', async () => {
    reconnectDelayMs = 1000;
    clearTimeout(streamDisconnectTimer);
    streamDisconnectTimer = undefined;
    resendAlerts();
    try { await announce('hello', connection); } catch (error) { console.warn(diagnostic('main.478a7b14c6', { p0: error.message })); }
    // Host probes may outlive this connection; only the current socket owns a heartbeat.
    if (closing || socket !== connection || connection.readyState !== WebSocket.OPEN) return;
    clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(() => announce('heartbeat', connection).catch((error) => console.warn(error.message)), 10000);
    console.log(diagnostic('main.416be1e93a', { p0: config.agentId }));
  });
  socket.on('message', (raw) => {
    let message;
    try { message = JSON.parse(raw.toString('utf8')); } catch { return; }
    if (message.type === 'command') handleCommand(message);
    else if (message.type === 'alert-ack') alerts.delete(String(message.id));
    else if (message.type === 'tunnel-open') void handleTunnelOpen(message);
    else if (message.type === 'tunnel-data') handleTunnelData(message);
    else if (message.type === 'tunnel-close') closeTunnel(message.tunnelId);
  });
  socket.on('close', () => {
    if (socket !== connection) return;
    clearInterval(heartbeatTimer);
    for (const id of [...tunnels.keys()]) closeTunnel(id);
    void inputGate.disconnect();
    void rtc.closeAll();
    clearTimeout(streamDisconnectTimer);
    if (!closing) streamDisconnectTimer = setTimeout(() => {
      for (const id of streams.streams.keys()) streams.stop(id).catch(() => {});
    }, 20_000);
    streamDisconnectTimer?.unref?.();
    if (!closing) {
      setTimeout(connect, reconnectDelayMs);
      reconnectDelayMs = Math.min(reconnectDelayMs * 2, 30000);
    }
  });
  socket.on('error', (error) => console.warn(diagnostic('main.4db48f5b05', { p0: error.message })));
}

async function shutdown() {
  if (closing) return;
  closing = true;
  clearInterval(heartbeatTimer);
  clearTimeout(streamDisconnectTimer);
  await inputGate.disconnect();
  await rtc.closeAll();
  socket?.close();
  for (const id of [...tunnels.keys()]) closeTunnel(id);
  await managedAppium.close();
  await Promise.allSettled([...streams.streams.keys()].map((id) => streams.stop(id)));
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

for (let attempt = 0; ; attempt++) {
  try { await recoverContainers(); break; }
  catch (error) {
    if (attempt >= 29) throw error;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}
connect();
