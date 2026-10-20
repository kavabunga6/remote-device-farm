import { readFileSync } from 'node:fs';
import { tarArchive } from './tar-archive.mjs';
import { runKeyed } from './keyed-queue.mjs';
import { CONSOLE_SCRIPT, execInContainer, runEmuConsole } from './emu-console.mjs';
import { agentMessage } from './messages.mjs';
const SCRIPT = readFileSync(new URL('./network-proxy.py', import.meta.url));
const fail = () => { throw new Error(agentMessage('networkInspector.failed')); };
const DIR = '/rdf-network';
export async function inspectNetwork(docker, containerId, sessionId, agentId, params) {
  if (!params || !['status', 'start', 'stop', 'clear', 'pcap'].includes(params.op) ||
      Object.keys(params).some(k => !['op', 'offset', 'pcap'].includes(k)) ||
      (params.op === 'start' && typeof params.pcap !== 'boolean') ||
      (params.op === 'pcap' && (!Number.isSafeInteger(params.offset) || params.offset < 0 || params.offset > 40 * 1024 * 1024))) fail();
  const deadline = Date.now() + 45000;
  const budget = max => { const left = deadline - Date.now(); if (left < 100) fail(); return Math.min(max, left); };
  const capture = args => { if (deadline - Date.now() < 3000) fail(); return runEmuConsole(docker, containerId, args, { timeoutMs: budget(20000) }); };
  const detail = await docker.inspect(containerId), labels = detail.Config?.Labels || {};
  if (labels['remote-device-farm.managed'] !== 'true' || labels['remote-device-farm.agent'] !== agentId ||
      labels['remote-device-farm.session'] !== sessionId || detail.State?.Running !== true) fail();
  const run = async (args, max = 1024 * 1024) => {
    const result = await execInContainer(docker, containerId, args, [], budget(10000), max);
    if (result.exitCode || result.truncated) fail();
    return result.stdout;
  };
  const checked = await execInContainer(docker, containerId, ['sh', '-c', 'test -w /rdf-network && test -x /rdf-network && command -v python3 >/dev/null'], [], budget(5000));
  if (checked.exitCode) {
    if (params.op === 'status') return { available: false, recording: false, entries: [] };
    throw new Error(agentMessage('networkInspector.unavailable'));
  }
  const call = op => run(['python3', DIR + '/proxy.py', op]);
  let state;
  try { state = JSON.parse(await call('status')); } catch { state = null; }
  if (params.op === 'status') return state ?? { available: true, recording: false, proxyActive: false, entries: [], pcapBytes: 0 };
  if (params.op === 'start') {
    if (state?.finalizing) throw new Error(agentMessage('debug.busy'));
    if (state?.recording) throw new Error(agentMessage('networkInspector.alreadyStarted'));
    await docker.request('PUT', '/containers/' + encodeURIComponent(containerId) + '/archive?path=%2Frdf-network&noOverwriteDirNonDir=true',
      undefined, { rawBody: tarArchive([{ name: 'proxy.py', mode: 0o600, data: SCRIPT }, { name: 'console.sh', mode: 0o600, data: Buffer.from(CONSOLE_SCRIPT) }]), contentType: 'application/x-tar', timeoutMs: budget(10000) });
    await run(['rm', '-f', '/rdf-network/capture.pcap']);
    if (state?.proxyActive) state = JSON.parse(await call('start'));
    else await run(['sh', '-c', 'umask 077; python3 /rdf-network/proxy.py serve </dev/null >/dev/null 2>&1 &']);
    for (let attempt = 0; attempt < 3; attempt++) {
      try { state = JSON.parse(await call('status')); break; } catch { await new Promise(resolve => setTimeout(resolve, 100)); }
    }
    if (!state?.proxyActive) fail();
    if (params.pcap) {
      const result = await capture(['network', 'capture', 'start', DIR + '/capture.pcap']);
      if (result.exitCode) fail();
    }
    return state;
  }
  if (params.op === 'stop') {
    if (state) state = JSON.parse(await call('stop'));
    if (state?.pcapBytes) { const stopped = await capture(['network', 'capture', 'stop']); if (stopped.exitCode) fail(); }
    return state ?? { available: true, recording: false, proxyActive: false, entries: [], pcapBytes: 0 };
  }
  if (params.op === 'clear') { if (state?.recording) fail(); return state ? JSON.parse(await call('clear')) : { available: true, recording: false, entries: [] }; }
  if (state?.recording) throw new Error(agentMessage('networkInspector.stopBeforeExport'));
  const stopped = await capture(['network', 'capture', 'stop']);
  if (stopped.exitCode) fail();
  return JSON.parse(await run(['python3', DIR + '/proxy.py', 'pcap', String(params.offset)]));
}

// Proxy traffic stays in the emulator's own network namespace and existing egress policy.
export class NetworkInspector {
  constructor(adb, control) { this.adb = adb; this.control = control; this.timers = new Map(); this.pcapTimers = new Map(); this.locks = new Map(); }
  async proxy(serial) {
    const result = await this.adb.run(serial, ['shell', 'settings', 'get', 'global', 'http_proxy'], { timeoutMs: 5000, maxOutputBytes: 4096 });
    if (result.exitCode) fail();
    return String(result.stdout).trim();
  }
  command(sessionId, serial, params) { return runKeyed(this.locks, sessionId, () => this.perform(sessionId, serial, params)); }
  async perform(sessionId, serial, params) {
    if (params?.op === 'start') {
      const current = await this.proxy(serial);
      if (!['', 'null', ':0', '10.0.2.2:18888'].includes(current)) throw new Error(agentMessage('networkInspector.proxyConflict'));
    }
    let result;
    try { result = await this.control.networkInspector(sessionId, params); }
    catch (error) {
      if (params.op === 'start') await this.control.networkInspector(sessionId, { op: 'stop' }).catch(() => {});
      throw error;
    }
    if (params.op === 'start') {
      const changed = await this.adb.run(serial, ['shell', 'settings', 'put', 'global', 'http_proxy', '10.0.2.2:18888'], { timeoutMs: 5000, maxOutputBytes: 4096 });
      if (changed.exitCode) { await this.control.networkInspector(sessionId, { op: 'stop' }); fail(); }
      clearTimeout(this.timers.get(sessionId));
      const timer = setTimeout(() => { void this.command(sessionId, serial, { op: 'stop' }).catch(() => {}); }, 10 * 60_000);
      timer.unref(); this.timers.set(sessionId, timer);
      if (params.pcap) {
        clearInterval(this.pcapTimers.get(sessionId));
        let pending = false;
        const watch = setInterval(() => {
          if (pending) return; pending = true;
          void this.control.networkInspector(sessionId, { op: 'status' }).then(state => {
            if (state.pcapBytes >= 30 * 1024 * 1024) return this.command(sessionId, serial, { op: 'stop' });
          }).catch(() => {}).finally(() => { pending = false; });
        }, 1000);
        watch.unref(); this.pcapTimers.set(sessionId, watch);
      }
    }
    if (params.op === 'stop') {
      clearTimeout(this.timers.get(sessionId)); this.timers.delete(sessionId);
      clearInterval(this.pcapTimers.get(sessionId)); this.pcapTimers.delete(sessionId);
      if (await this.proxy(serial) === '10.0.2.2:18888') {
        const changed = await this.adb.run(serial, ['shell', 'settings', 'put', 'global', 'http_proxy', ':0'], { timeoutMs: 5000, maxOutputBytes: 4096 });
        if (changed.exitCode) fail();
      }
    }
    if (['status', 'start', 'stop'].includes(params.op)) result.proxyActive = await this.proxy(serial) === '10.0.2.2:18888';
    return result;
  }
  dispose(sessionId) { clearTimeout(this.timers.get(sessionId)); this.timers.delete(sessionId); clearInterval(this.pcapTimers.get(sessionId)); this.pcapTimers.delete(sessionId); }
}
