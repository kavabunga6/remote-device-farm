import { NetworkCaptureRuntime } from './network-capture-runtime.mjs';
import { runKeyed } from './keyed-queue.mjs';
import { agentMessage } from './messages.mjs';
const fail = () => { throw new Error(agentMessage('networkInspector.failed')); };
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
  return new NetworkCaptureRuntime(docker, containerId, sessionId, agentId, packets).execute(params);
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
