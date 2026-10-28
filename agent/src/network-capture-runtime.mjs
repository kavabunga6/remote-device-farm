import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { writeContainerFiles } from './container-files.mjs';
import { CONSOLE_SCRIPT, execInContainer, runEmuConsole } from './emu-console.mjs';
import { agentMessage } from './messages.mjs';
const SCRIPT = readFileSync(new URL('./network-proxy.py', import.meta.url));
const CAPTURE = readFileSync(new URL('./network_capture.py', import.meta.url));
const RUNTIME_VERSION = createHash('sha256').update(Buffer.concat([SCRIPT, CAPTURE, Buffer.from(CONSOLE_SCRIPT)])).digest('hex');
const DIR = '/rdf-network';
const LEGACY_PCAP_PATH = '/android-home/avd/rdf.avd/console_out/rdf-capture.pcap';
const fail = () => { throw new Error(agentMessage('networkInspector.failed')); };

/** Owns the container capture runtime for a single bounded control request. */
export class NetworkCaptureRuntime {
  constructor(docker, containerId, sessionId, agentId, packets) {
    Object.assign(this, { docker, containerId, sessionId, agentId, packets });
    this.deadline = Date.now() + 45000;
    this.state = null;
  }
  budget(max) {
    const left = this.deadline - Date.now();
    if (left < 100) fail();
    return Math.min(max, left);
  }
  async run(args, max = 8 * 1024 * 1024, timeout = 10000) {
    const result = await execInContainer(this.docker, this.containerId, args, [], this.budget(timeout), max);
    if (result.exitCode || result.truncated) fail();
    return result.stdout;
  }
  call(op, ...args) {
    return this.run(['python3', DIR + '/proxy.py', op, ...args], 8 * 1024 * 1024, ['start', 'stop'].includes(op) ? 30000 : 10000);
  }
  async prepare() {
    this.detail = await this.docker.inspect(this.containerId);
    const labels = this.detail.Config?.Labels || {};
    if (labels['remote-device-farm.managed'] !== 'true' || labels['remote-device-farm.agent'] !== this.agentId ||
        labels['remote-device-farm.session'] !== this.sessionId || this.detail.State?.Running !== true) fail();
    const checked = await execInContainer(this.docker, this.containerId,
      ['sh', '-c', 'test -w /rdf-network && test -x /rdf-network && command -v python3 >/dev/null'], [], this.budget(5000));
    return !checked.exitCode;
  }
  empty() { return { available: true, protocolVersion: 3, runtimeCompatible: true, recording: false, proxyActive: false, entries: [], pcapBytes: 0, pcapState: 'none' }; }
  current() { return this.state ? { ...this.state, runtimeCompatible: this.state.protocolVersion === 3 && this.state.runtimeVersion === RUNTIME_VERSION } : this.empty(); }
  async execute(params) {
    if (!await this.prepare()) {
      if (params.op === 'status') return { available: false, recording: false, entries: [] };
      throw new Error(agentMessage('networkInspector.unavailable'));
    }
    try { this.state = JSON.parse(await this.call(params.summary ? 'summary' : 'status')); } catch { this.state = null; }
    switch (params.op) {
      case 'status': return this.status();
      case 'start': return this.start(params);
      case 'stop': return this.stop(params.reason);
      case 'clear': return this.clear();
      case 'pcap': return this.exportPcap(params);
    }
  }
  async syncPackets() {
    if (this.state?.protocolVersion !== 3 || !this.state.pcapRequested) return;
    const result = await this.packets.status(this.sessionId, this.state.captureId);
    if (this.state.recording && ['stopped', 'error'].includes(result.pcapState)) {
      const reason = ['size_limit', 'time_limit'].includes(result.stopReason) ? result.stopReason : 'recovery';
      this.state = JSON.parse(await this.call('stop', reason));
    }
    Object.assign(this.state, { pcapState: result.pcapState, pcapBytes: result.pcapBytes, packetCount: result.packetCount });
  }
  async status() {
    await this.syncPackets();
    return { ...this.current(), pcapAvailable: this.packets ? await this.packets.available() : false };
  }
  async stopPcap() {
    if (this.state?.protocolVersion !== 3) return this.stopLegacyPcap();
    if (!this.state.pcapRequested) return;
    const result = await this.packets.stop(this.sessionId, this.state.captureId);
    this.state = JSON.parse(await this.call(result.pcapState === 'stopped' ? 'pcap-stopped' : 'pcap-error'));
    Object.assign(this.state, { pcapBytes: result.pcapBytes, pcapState: result.pcapState, packetCount: result.packetCount });
  }
  async stopLegacyPcap() {
    if (!this.state?.pcapRequested && !this.state?.pcapBytes) return;
    if (this.deadline - Date.now() < 3000) fail();
    const stopped = await runEmuConsole(this.docker, this.containerId, ['network', 'capture', 'stop'], { timeoutMs: this.budget(20000) });
    if (this.state.protocolVersion === 2) this.state = JSON.parse(await this.call(stopped.exitCode ? 'pcap-error' : 'pcap-stopped'));
    else if (stopped.exitCode) fail();
  }
  async finishPreviousCapture() {
    if (this.state?.finalizing) throw new Error(agentMessage('debug.busy'));
    if (this.state?.recording) throw new Error(agentMessage('networkInspector.alreadyStarted'));
    if (this.state?.protocolVersion !== 3 || !this.state.pcapRequested) return;
    await this.stopPcap();
    if (this.state.pcapState !== 'stopped') throw new Error(agentMessage('debug.busy'));
  }
  async replaceRuntime() {
    if (!this.state || (this.state.protocolVersion === 3 && this.state.runtimeVersion === RUNTIME_VERSION)) return;
    if (this.state.protocolVersion !== 3) throw new Error(agentMessage('networkInspector.restartRequired'));
    if (this.state.activeConnections) throw new Error(agentMessage('networkInspector.connectionsOpen'));
    await this.call('shutdown');
    await this.waitForShutdown();
    this.state = null;
  }
  async waitForShutdown() {
    for (let attempt = 0; attempt < 10; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 100));
      try { await this.call('summary'); } catch { return; }
    }
    throw new Error(agentMessage('debug.busy'));
  }
  async installScripts() {
    await writeContainerFiles(this.docker, this.containerId, DIR, [
      { name: 'proxy.py', mode: 0o600, data: SCRIPT }, { name: 'network_capture.py', mode: 0o600, data: CAPTURE },
      { name: 'console.sh', mode: 0o600, data: Buffer.from(CONSOLE_SCRIPT) },
    ], { timeoutMs: this.budget(15000) });
    await this.run(['rm', '-f', LEGACY_PCAP_PATH]);
  }
  async ensureProxy() {
    if (!this.state?.proxyActive) {
      await this.run(['sh', '-c', 'umask 077; python3 /rdf-network/proxy.py serve </dev/null >/dev/null 2>&1 &']);
      for (let attempt = 0; attempt < 3; attempt++) {
        try { this.state = JSON.parse(await this.call('status')); break; } catch { await new Promise(resolve => setTimeout(resolve, 100)); }
      }
    }
    if (!this.state?.proxyActive) fail();
  }
  async start(params) {
    await this.finishPreviousCapture();
    await this.replaceRuntime();
    await this.installScripts();
    await this.ensureProxy();
    this.state = JSON.parse(await this.call('start', params.pcap ? '1' : '0', params.captureBodies ? '1' : '0'));
    if (params.pcap) {
      const result = await this.packets.start(this.detail.Id, this.sessionId, this.state.captureId);
      this.state = JSON.parse(await this.call('pcap-recording'));
      Object.assign(this.state, { pcapState: result.pcapState, pcapBytes: result.pcapBytes });
    }
    return this.current();
  }
  async stop(reason) {
    if (this.state) this.state = JSON.parse(await this.call('stop', ...([2, 3].includes(this.state.protocolVersion) ? [reason ?? 'manual'] : [])));
    await this.stopPcap();
    return this.current();
  }
  async clear() {
    if (this.state?.recording || this.state?.finalizing) fail();
    return this.state ? JSON.parse(await this.call('clear')) : this.empty();
  }
  async exportPcap(params) {
    if (this.state?.recording || this.state?.finalizing) throw new Error(agentMessage('networkInspector.stopBeforeExport'));
    if (params.captureId && params.captureId !== this.state?.captureId) throw new Error(agentMessage('networkInspector.captureChanged'));
    await this.stopPcap();
    if (this.state?.pcapState === 'error') fail();
    const result = this.state?.protocolVersion === 3 ? await this.packets.read(this.sessionId, this.state.captureId, params.offset)
      : JSON.parse(await this.run(['python3', DIR + '/proxy.py', 'pcap', String(params.offset)]));
    return { ...result, captureId: this.state?.captureId };
  }
}
