import { readFile, statfs } from 'node:fs/promises';

export class BuildResourceError extends Error {
  constructor(code) { super(code); this.code = code; }
}

export function parseBuildMetrics(cpuText, memoryText, pressureText, disk, previous) {
  const cpu = /^cpu\s+(.+)$/m.exec(cpuText)?.[1].trim().split(/\s+/).slice(0, 8).map(Number);
  const available = Number(/^MemAvailable:\s+(\d+) kB$/m.exec(memoryText)?.[1]);
  const pressure = Number(/^some .*?avg10=([\d.]+)/m.exec(pressureText)?.[1]);
  if (!cpu || cpu.length !== 8 || cpu.some(value => !Number.isFinite(value)) || !Number.isFinite(available) || !Number.isFinite(pressure) || !disk || !Number.isFinite(disk.bavail * disk.bsize)) throw new BuildResourceError('build_metrics_unavailable');
  const total = cpu.reduce((sum, value) => sum + value, 0), idle = cpu[3], wait = cpu[4];
  const delta = previous ? total - previous.total : 0;
  const busy = delta > 0 ? Math.max(0, Math.min(100, (delta - (idle - previous.idle) - (wait - previous.wait)) * 100 / delta)) : 0;
  return { freeGiB: disk.bavail * disk.bsize / 1024 ** 3, availableGiB: available / 1024 ** 2, ioPressure: pressure, cpuPercent: busy, total, idle, wait };
}

export class BuildResourceGuard {
  constructor({ path, fs = { readFile, statfs }, now = () => performance.now(), intervalMs = 5000, startDiskGiB = 35, stopDiskGiB = 20, startMemoryGiB = 12, stopMemoryGiB = 8, pressureDurationMs = 15_000 } = {}) {
    Object.assign(this, { path, fs, now, intervalMs, startDiskGiB, stopDiskGiB, startMemoryGiB, stopMemoryGiB, pressureDurationMs });
    this.previous = undefined; this.highSince = undefined;
  }
  async sample(start = false) {
    const [cpu, memory, pressure, disk] = await Promise.all([
      this.fs.readFile('/proc/stat', 'utf8'), this.fs.readFile('/proc/meminfo', 'utf8'), this.fs.readFile('/proc/pressure/io', 'utf8'), this.fs.statfs(this.path),
    ]).catch(() => { throw new BuildResourceError('build_metrics_unavailable'); });
    const metrics = parseBuildMetrics(cpu, memory, pressure, disk, this.previous); this.previous = metrics;
    if (metrics.freeGiB < (start ? this.startDiskGiB : this.stopDiskGiB)) throw new BuildResourceError('build_disk_reserve');
    if (metrics.availableGiB < (start ? this.startMemoryGiB : this.stopMemoryGiB)) throw new BuildResourceError('build_memory_reserve');
    const high = metrics.cpuPercent > 85 || metrics.ioPressure > 30;
    this.highSince = high ? this.highSince ?? this.now() : undefined;
    if ((start && metrics.ioPressure > 15) || (this.highSince !== undefined && this.now() - this.highSince >= this.pressureDurationMs)) throw new BuildResourceError('build_host_pressure');
    return metrics;
  }
  async run(work, { signal, onSample = () => {} } = {}) {
    onSample(await this.sample(true));
    const controller = new AbortController(), combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    let timer, stopped = false, checking;
    const poll = () => {
      checking = this.sample().then(onSample).catch(error => controller.abort(error)).finally(() => { if (!stopped && !combined.aborted) timer = setTimeout(poll, this.intervalMs); });
    };
    timer = setTimeout(poll, this.intervalMs);
    try { const result = await work(combined); combined.throwIfAborted(); return result; }
    catch (error) { if (combined.aborted) throw combined.reason; throw error; }
    finally { stopped = true; clearTimeout(timer); await checking; }
  }
}
