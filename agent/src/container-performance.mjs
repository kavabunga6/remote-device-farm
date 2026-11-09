const SAMPLE_INTERVAL_MS = 5000;
const MAX_CACHED_CONTAINERS = 128;

function counter(value) {
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function delta(before, after) {
  return before === null || after === null || after < before ? null : after - before;
}

function ioBytes(stats, operation) {
  const entries = stats.blkio_stats?.io_service_bytes_recursive;
  if (!Array.isArray(entries) || !entries.length) return null;
  const matches = entries.filter(entry => entry.op?.toLowerCase() === operation);
  return matches.reduce((total, entry) => total + (counter(entry.value) ?? 0), 0);
}

export class ContainerPerformance {
  constructor(docker, clock = Date.now) {
    this.docker = docker;
    this.clock = clock;
    this.cache = new Map();
    this.inFlight = new Map();
  }

  latest(containerId) { return this.cache.get(containerId)?.sample ?? null; }

  sample(containerId) {
    const cached = this.cache.get(containerId);
    if (cached && this.clock() - cached.at < SAMPLE_INTERVAL_MS) return Promise.resolve(cached.sample);
    const pending = this.inFlight.get(containerId);
    if (pending) return pending;
    const reading = this.read(containerId, cached).finally(() => this.inFlight.delete(containerId));
    this.inFlight.set(containerId, reading);
    return reading;
  }

  async read(containerId, previous) {
    const stats = await this.docker.request('GET', `/containers/${encodeURIComponent(containerId)}/stats?stream=false&one-shot=true`,
      undefined, { timeoutMs: 3000, maxBytes: 256 * 1024 });
    const at = this.clock();
    const throttle = stats.cpu_stats?.throttling_data;
    const counters = {
      cpu: counter(stats.cpu_stats?.cpu_usage?.total_usage),
      periods: counter(throttle?.periods),
      throttled: counter(throttle?.throttled_periods),
      read: ioBytes(stats, 'read'),
      write: ioBytes(stats, 'write'),
    };
    const elapsed = previous ? at - previous.at : 0;
    const change = key => elapsed >= 1000 && elapsed <= 60_000
      ? delta(previous.counters[key], counters[key]) : null;
    const cpu = change('cpu');
    const periods = change('periods');
    const throttled = change('throttled');
    const read = change('read'), write = change('write');
    const memory = stats.memory_stats;
    const memoryBytes = counter(memory?.usage);
    const inactiveFile = counter(memory?.stats?.total_inactive_file ?? memory?.stats?.inactive_file);
    const sample = {
      sampledAt: new Date(at).toISOString(),
      cpuCores: cpu === null ? null : cpu / (elapsed * 1_000_000),
      throttlePercent: periods && throttled !== null ? Math.min(100, 100 * throttled / periods) : null,
      memoryBytes,
      memoryWorkingSetBytes: memoryBytes !== null && inactiveFile !== null && inactiveFile < memoryBytes
        ? memoryBytes - inactiveFile : null,
      memoryLimitBytes: counter(memory?.limit),
      readBytesPerSecond: read === null ? null : read * 1000 / elapsed,
      writeBytesPerSecond: write === null ? null : write * 1000 / elapsed,
    };
    this.cache.delete(containerId);
    this.cache.set(containerId, { at, counters, sample });
    if (this.cache.size > MAX_CACHED_CONTAINERS) this.cache.delete(this.cache.keys().next().value);
    return sample;
  }
}
