export type GpuMode = 'software' | 'nvidia';
export type GpuBackend = 'cuda' | 'gpu';

/** Choose from the node, never from profile metadata. Explicit capabilities are authoritative. */
export function hostGpuBackend(metrics: Record<string, unknown> | null | undefined): GpuBackend | null {
  if (Array.isArray(metrics?.gpuCapabilities)) {
    if (metrics.gpuCapabilities.includes('cuda')) return 'cuda';
    if (metrics.gpuCapabilities.includes('gpu')) return 'gpu';
    return null;
  }
  // Older agents report these booleans during a rolling upgrade.
  if (metrics?.nvidiaGpuAvailable === true) return 'cuda';
  return metrics?.driGpuAvailable === true ? 'gpu' : null;
}
