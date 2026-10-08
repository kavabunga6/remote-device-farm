import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const SAMPLE_TTL_MS = 5000;
const version = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version;

export function parseCpuTimes(text) {
  const line = String(text || '').match(/^cpu\s+(.+)$/m)?.[1];
  if (!line) return null;
  const fields = line.trim().split(/\s+/).slice(0, 8).map(Number);
  if (fields.length < 4 || fields.some(value => !Number.isSafeInteger(value) || value < 0)) return null;
  // guest/guest_nice are already included in user/nice and must not count twice.
  const total = fields.reduce((sum, value) => sum + value, 0);
  return Number.isSafeInteger(total) ? { total, idle: fields[3] + (fields[4] ?? 0) } : null;
}

export function cpuUtilization(previous, current) {
  if (!previous || !current) return undefined;
  const total = current.total - previous.total;
  const idle = current.idle - previous.idle;
  if (total <= 0 || idle < 0 || idle > total) return undefined;
  return Math.round((1 - idle / total) * 1000) / 10;
}

function numeric(value, max) {
  const text = String(value).trim();
  if (!/^\d+(?:\.\d+)?$/.test(text)) return undefined;
  const number = Number(text);
  return Number.isFinite(number) && number >= 0 && number <= max ? number : undefined;
}

export function parseNvidiaTelemetry(stdout) {
  const lines = String(stdout || '').trim().split(/\r?\n/).filter(Boolean);
  if (!lines.length || lines.length > 16) return undefined;
  const seen = new Set();
  const devices = [];
  for (const line of lines) {
    const fields = line.split(',').map(value => value.trim());
    if (fields.length !== 4) return undefined;
    const index = numeric(fields[0], 255);
    if (!Number.isInteger(index) || seen.has(index)) return undefined;
    seen.add(index);
    const utilizationPercent = numeric(fields[1], 100);
    let memoryUsedMb = numeric(fields[2], 1_000_000_000);
    let memoryTotalMb = numeric(fields[3], 1_000_000_000);
    if (memoryUsedMb != null && memoryTotalMb != null && memoryUsedMb > memoryTotalMb) {
      memoryUsedMb = undefined; memoryTotalMb = undefined;
    }
    if (utilizationPercent == null && memoryUsedMb == null && memoryTotalMb == null) continue;
    devices.push({ index, ...(utilizationPercent == null ? {} : { utilizationPercent }),
      ...(memoryUsedMb == null ? {} : { memoryUsedMb }), ...(memoryTotalMb == null ? {} : { memoryTotalMb }) });
  }
  return devices.length ? devices : undefined;
}

export async function queryNvidiaTelemetry(run = execute) {
  try {
    const result = await run('nvidia-smi', [
      '--query-gpu=index,utilization.gpu,memory.used,memory.total', '--format=csv,noheader,nounits',
    ], { timeout: 1500, killSignal: 'SIGKILL', maxBuffer: 16 * 1024, encoding: 'utf8', shell: false, windowsHide: true });
    return parseNvidiaTelemetry(result.stdout);
  } catch { return undefined; }
}

export class LiveTelemetryCollector {
  constructor({ fs = { readFile }, env = process.env, clock = Date.now, runGpu = execute } = {}) {
    this.fs = fs; this.clock = clock; this.runGpu = runGpu;
    this.build = /^[0-9a-f]{7,40}$/i.test(env.AGENT_BUILD_SHA || '') ? env.AGENT_BUILD_SHA : undefined;
    this.previousCpu = null; this.previousAt = null; this.cached = null; this.inFlight = null;
  }
  async collect(hasNvidia = false) {
    if (this.inFlight) return this.inFlight;
    if (this.cached && this.clock() >= this.cached.at && this.clock() - this.cached.at < SAMPLE_TTL_MS) return this.cached.value;
    this.inFlight = this.sample(hasNvidia);
    try { return await this.inFlight; } finally { this.inFlight = null; }
  }
  async sample(hasNvidia) {
    const at = this.clock();
    const [stat, gpuTelemetry] = await Promise.all([
      this.fs.readFile('/proc/stat', 'utf8').catch(() => ''),
      hasNvidia ? queryNvidiaTelemetry(this.runGpu) : undefined,
    ]);
    const cpu = parseCpuTimes(stat);
    const usage = cpuUtilization(this.previousCpu, cpu);
    const seconds = this.previousAt == null ? undefined : (at - this.previousAt) / 1000;
    this.previousCpu = cpu; this.previousAt = at;
    const value = {
      agentVersion: version, ...(this.build ? { agentBuild: this.build } : {}),
      metricsSampledAt: new Date(at).toISOString(),
      ...(usage == null || seconds == null || seconds <= 0 ? {} : { cpuUsagePercent: usage, cpuSampleSeconds: Math.round(seconds * 10) / 10 }),
      ...(gpuTelemetry ? { gpuTelemetry } : {}),
    };
    this.cached = { at, value };
    return value;
  }
}
