import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { writeContainerFiles } from './container-files.mjs';
import { runKeyed } from './keyed-queue.mjs';
import { CONSOLE_SCRIPT, execInContainer, runEmuConsole } from './emu-console.mjs';
import { agentMessage } from './messages.mjs';
const SCRIPT = readFileSync(new URL('./network-proxy.py', import.meta.url));
const CAPTURE = readFileSync(new URL('./network_capture.py', import.meta.url));
const RUNTIME_VERSION = createHash('sha256').update(Buffer.concat([SCRIPT, CAPTURE, Buffer.from(CONSOLE_SCRIPT)])).digest('hex');
const fail = () => { throw new Error(agentMessage('networkInspector.failed')); };
const DIR = '/rdf-network';
const LEGACY_PCAP_PATH = '/android-home/avd/rdf.avd/console_out/rdf-capture.pcap';
const STOP_REASONS = ['manual', 'time_limit', 'size_limit', 'recovery', 'start_failed'];

export function validateNetworkInspectorParams(params) {
  const fields = { status: ['op', 'summary'], start: ['op', 'pcap', 'captureBodies'], stop: ['op', 'reason'], clear: ['op'], pcap: ['op', 'offset', 'captureId'] };
  if (!params || typeof params !== 'object' || Array.isArray(params) || !Object.hasOwn(fields, params.op) ||
      Object.keys(params).some(key => !fields[params.op].includes(key)) ||
      (params.summary !== undefined && typeof params.summary !== 'boolean') ||
      (params.op === 'start' && (typeof params.pcap !== 'boolean' || (params.captureBodies !== undefined && typeof params.captureBodies !== 'boolean'))) ||
      (params.reason !== undefined && !STOP_REASONS.includes(params.reason)) ||
      (params.captureId !== undefined && (typeof params.captureId !== 'string' || !/^[a-f0-9]{32}$/.test(params.captureId))) ||
      (params.op === 'pcap' && (!Number.isSafeInteger(params.offset) || params.offset < 0 || params.offset > 40 * 1024 * 1024))) fail();
  return params;
}

export async function inspectNetwork(docker, containerId, sessionId, agentId, params, packets) {
  validateNetworkInspectorParams(params);
  const deadline = Date.now() + 45000;
  const budget = max => { const left = deadline - Date.now(); if (left < 100) fail(); return Math.min(max, left); };
  const capture = args => { if (deadline - Date.now() < 3000) fail(); return runEmuConsole(docker, containerId, args, { timeoutMs: budget(20000) }); };
  const detail = await docker.inspect(containerId), labels = detail.Config?.Labels || {};
  if (labels['remote-device-farm.managed'] !== 'true' || labels['remote-device-farm.agent'] !== agentId ||
      labels['remote-device-farm.session'] !== sessionId || detail.State?.Running !== true) fail();
  const run = async (args, max = 8 * 1024 * 1024, timeout = 10000) => {
    const result = await execInContainer(docker, containerId, args, [], budget(timeout), max);
    if (result.exitCode || result.truncated) fail();
    return result.stdout;
  };
  const checked = await execInContainer(docker, containerId, ['sh', '-c', 'test -w /rdf-network && test -x /rdf-network && command -v python3 >/dev/null'], [], budget(5000));
  if (checked.exitCode) {
    if (params.op === 'status') return { available: false, recording: false, entries: [] };
    throw new Error(agentMessage('networkInspector.unavailable'));
  }
  const call = (op, ...args) => run(['python3', DIR + '/proxy.py', op, ...args], 8 * 1024 * 1024, ['start', 'stop'].includes(op) ? 30000 : 10000);
  let state;
  try { state = JSON.parse(await call(params.summary ? 'summary' : 'status')); } catch { state = null; }
  const empty = () => ({ available: true, protocolVersion: 3, runtimeCompatible: true, recording: false, proxyActive: false, entries: [], pcapBytes: 0, pcapState: 'none' });
  const current = () => state ? { ...state, runtimeCompatible: state.protocolVersion === 3 && state.runtimeVersion === RUNTIME_VERSION } : empty();
  const packetStatus = async () => {
    if (state?.protocolVersion === 3 && state.pcapRequested) {
      const result = await packets.status(sessionId, state.captureId);
      if (state.recording && ['stopped', 'error'].includes(result.pcapState)) state = JSON.parse(await call('stop', result.stopReason === 'size_limit' ? 'size_limit' : result.stopReason === 'time_limit' ? 'time_limit' : 'recovery'));
      Object.assign(state, {pcapState:result.pcapState,pcapBytes:result.pcapBytes,packetCount:result.packetCount});
    }
  };
  if (params.op === 'status') { await packetStatus();return {...current(),pcapAvailable:packets ? await packets.available() : false}; }
  const stopPcap = async () => {
    if (state?.protocolVersion === 3) {
      if (state.pcapRequested) { const result = await packets.stop(sessionId,state.captureId);state=JSON.parse(await call(result.pcapState === 'stopped' ? 'pcap-stopped' : 'pcap-error'));Object.assign(state,{pcapBytes:result.pcapBytes,pcapState:result.pcapState,packetCount:result.packetCount}); }
      return;
    }
    if (!state?.pcapRequested && !state?.pcapBytes) return;
    const stopped = await capture(['network', 'capture', 'stop']);
    if (state.protocolVersion === 2) state = JSON.parse(await call(stopped.exitCode ? 'pcap-error' : 'pcap-stopped'));
    else if (stopped.exitCode) fail();
  };
  if (params.op === 'start') {
    if (state?.finalizing) throw new Error(agentMessage('debug.busy'));
    if (state?.recording) throw new Error(agentMessage('networkInspector.alreadyStarted'));
    if (state?.protocolVersion === 3 && state.pcapRequested) { await stopPcap();if (state.pcapState !== 'stopped') throw new Error(agentMessage('debug.busy')); }
    if (state && (state.protocolVersion !== 3 || state.runtimeVersion !== RUNTIME_VERSION)) {
      // Do not overwrite code used by a running daemon or discard its export.
      // A new start intentionally replaces the previous stopped capture.
      if (state.protocolVersion !== 3) throw new Error(agentMessage('networkInspector.restartRequired'));
      if (state.activeConnections) throw new Error(agentMessage('networkInspector.connectionsOpen'));
      await call('shutdown');
      let stopped = false;
      for (let attempt = 0; attempt < 10; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 100));
        try { await call('summary'); } catch { stopped = true; break; }
      }
      if (!stopped) throw new Error(agentMessage('debug.busy'));
      state = null;
    }
    await writeContainerFiles(docker, containerId, DIR, [
      { name: 'proxy.py', mode: 0o600, data: SCRIPT }, { name: 'network_capture.py', mode: 0o600, data: CAPTURE },
      { name: 'console.sh', mode: 0o600, data: Buffer.from(CONSOLE_SCRIPT) },
    ], { timeoutMs: budget(15000) });
    await run(['rm', '-f', LEGACY_PCAP_PATH]);
    if (!state?.proxyActive) {
      await run(['sh', '-c', 'umask 077; python3 /rdf-network/proxy.py serve </dev/null >/dev/null 2>&1 &']);
      for (let attempt = 0; attempt < 3; attempt++) {
        try { state = JSON.parse(await call('status')); break; } catch { await new Promise(resolve => setTimeout(resolve, 100)); }
      }
    }
    if (!state?.proxyActive) fail();
    state = JSON.parse(await call('start', params.pcap ? '1' : '0', params.captureBodies ? '1' : '0'));
    if (params.pcap) {
      const result = await packets.start(detail.Id,sessionId,state.captureId);
      state=JSON.parse(await call('pcap-recording'));Object.assign(state,{pcapState:result.pcapState,pcapBytes:result.pcapBytes});
    }
    return current();
  }
  if (params.op === 'stop') {
    if (state) state = JSON.parse(await call('stop', ...([2, 3].includes(state.protocolVersion) ? [params.reason ?? 'manual'] : [])));
    await stopPcap();
    return current();
  }
  if (params.op === 'clear') {
    if (state?.recording || state?.finalizing) fail();
    return state ? JSON.parse(await call('clear')) : empty();
  }
  if (state?.recording || state?.finalizing) throw new Error(agentMessage('networkInspector.stopBeforeExport'));
  if (params.captureId && params.captureId !== state?.captureId) throw new Error(agentMessage('networkInspector.captureChanged'));
  await stopPcap();
  if (state?.pcapState === 'error') fail();
  const result = state?.protocolVersion === 3 ? await packets.read(sessionId,state.captureId,params.offset) : JSON.parse(await run(['python3', DIR + '/proxy.py', 'pcap', String(params.offset)]));
  return { ...result, captureId: state?.captureId };
}

// Proxy traffic stays in the emulator's own network namespace and existing egress policy.
export class NetworkInspector {
  constructor(adb, control) { this.adb = adb; this.control = control; this.timers = new Map(); this.pcapTimers = new Map(); this.locks = new Map(); this.generations = new Map(); }
  async proxy(serial) {
    const result = await this.adb.run(serial, ['shell', 'settings', 'get', 'global', 'http_proxy'], { timeoutMs: 5000, maxOutputBytes: 4096 });
    if (result.exitCode) fail();
    return String(result.stdout).trim();
  }
  command(sessionId, serial, params) { return runKeyed(this.locks, sessionId, () => this.perform(sessionId, serial, params)); }
  clearTimers(sessionId) {
    this.generations.delete(sessionId);
    clearTimeout(this.timers.get(sessionId)); this.timers.delete(sessionId);
    clearInterval(this.pcapTimers.get(sessionId)); this.pcapTimers.delete(sessionId);
  }
  autoStop(sessionId, serial, reason, generation) {
    return runKeyed(this.locks, sessionId, () => {
      if (this.generations.get(sessionId) === generation) return this.perform(sessionId, serial, { op: 'stop', reason });
    });
  }
  async releaseProxy(serial) {
    if (await this.proxy(serial) === '10.0.2.2:18888') {
      const changed = await this.adb.run(serial, ['shell', 'settings', 'put', 'global', 'http_proxy', ':0'], { timeoutMs: 5000, maxOutputBytes: 4096 });
      if (changed.exitCode) fail();
    }
  }
  async perform(sessionId, serial, params) {
    if (params?.op === 'start') {
      const current = await this.proxy(serial);
      if (!['', 'null', ':0', '10.0.2.2:18888'].includes(current)) throw new Error(agentMessage('networkInspector.proxyConflict'));
      const previous = await this.control.networkInspector(sessionId, {op:'status',summary:true});
      if (previous.recording || previous.finalizing) throw new Error(agentMessage('networkInspector.alreadyStarted'));
      if (params.pcap && previous.pcapAvailable === false) throw new Error(agentMessage('networkInspector.unavailable'));
    }
    try {
      const result = await this.control.networkInspector(sessionId, params);
      if (params.op === 'start') {
        const changed = await this.adb.run(serial, ['shell', 'settings', 'put', 'global', 'http_proxy', '10.0.2.2:18888'], { timeoutMs: 5000, maxOutputBytes: 4096 });
        if (changed.exitCode) fail();
        this.clearTimers(sessionId);
        const generation = Symbol(); this.generations.set(sessionId, generation);
        const timer = setTimeout(() => { void this.autoStop(sessionId, serial, 'time_limit', generation).catch(() => {}); }, 10 * 60_000);
        timer.unref(); this.timers.set(sessionId, timer);
        let pending = false;
        const watch = setInterval(() => {
          if (pending) return; pending = true;
          void this.control.networkInspector(sessionId, { op: 'status', summary: true }).then(state => {
            if (!state.recording || state.pcapBytes >= 30 * 1024 * 1024)
              return this.autoStop(sessionId, serial, state.stopReason ?? 'size_limit', generation);
          }).catch(() => {}).finally(() => { pending = false; });
        }, 1500);
        watch.unref(); this.pcapTimers.set(sessionId, watch);
      }
      if (params.op === 'stop') { this.clearTimers(sessionId); await this.releaseProxy(serial); }
      if (['status', 'start', 'stop'].includes(params.op)) result.proxyActive = await this.proxy(serial) === '10.0.2.2:18888';
      return result;
    } catch (error) {
      if (params.op === 'start') await this.control.networkInspector(sessionId, { op: 'stop', reason: 'start_failed' }).catch(() => {});
      if (params.op === 'stop' || params.op === 'start') { this.clearTimers(sessionId); await this.releaseProxy(serial).catch(() => {}); }
      throw error;
    }
  }
  dispose(sessionId) { this.clearTimers(sessionId); }
}
