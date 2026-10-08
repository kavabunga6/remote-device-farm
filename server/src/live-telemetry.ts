const boundedNumber = (value: unknown, max: number): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= max;

// Optional fields: absent samples remain absent; zero is a real measurement.
export function cleanLiveTelemetry(source: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  if (boundedNumber(source.cpuUsagePercent, 100)) result.cpuUsagePercent = source.cpuUsagePercent;
  if (boundedNumber(source.cpuSampleSeconds, 86400) && source.cpuSampleSeconds > 0) result.cpuSampleSeconds = source.cpuSampleSeconds;
  if (typeof source.agentVersion === 'string' && /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9a-z.-]+)?$/i.test(source.agentVersion) && source.agentVersion.length <= 64) result.agentVersion = source.agentVersion;
  if (typeof source.agentBuild === 'string' && /^[0-9a-f]{7,40}$/i.test(source.agentBuild)) result.agentBuild = source.agentBuild;
  if (typeof source.metricsSampledAt === 'string' && source.metricsSampledAt.length <= 32 && Number.isFinite(Date.parse(source.metricsSampledAt))) result.metricsSampledAt = new Date(source.metricsSampledAt).toISOString();
  if (Array.isArray(source.gpuTelemetry) && source.gpuTelemetry.length <= 16) {
    const seen = new Set<number>();
    const devices = source.gpuTelemetry.flatMap((raw: unknown) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
      const item = raw as Record<string, unknown>;
      if (!boundedNumber(item.index, 255) || !Number.isInteger(item.index) || seen.has(item.index)) return [];
      seen.add(item.index);
      const device: Record<string, number> = { index: item.index };
      if (boundedNumber(item.utilizationPercent, 100)) device.utilizationPercent = item.utilizationPercent;
      if (boundedNumber(item.memoryUsedMb, 1_000_000_000)) device.memoryUsedMb = item.memoryUsedMb;
      if (boundedNumber(item.memoryTotalMb, 1_000_000_000)) device.memoryTotalMb = item.memoryTotalMb;
      if (device.memoryUsedMb != null && device.memoryTotalMb != null && device.memoryUsedMb > device.memoryTotalMb) { delete device.memoryUsedMb; delete device.memoryTotalMb; }
      return Object.keys(device).length > 1 ? [device] : [];
    });
    if (devices.length) result.gpuTelemetry = devices;
  }
  return result;
}
