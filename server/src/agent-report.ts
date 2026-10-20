import { devicePlatform, normalizeCapabilities, normalizeDeviceMetadata, type DeviceDescriptor } from './generated/device-contract.js';
import { cleanLiveTelemetry } from './live-telemetry.js';

// Untrusted agent payload normalization; transport and persistence belong to AgentHub.
export type ActiveSessionReport = { containerId: string; networkEnabled: boolean | null; preparing: boolean; bootReady: boolean; details?: Partial<DeviceDescriptor> };

export function parseActiveSessions(input: unknown[]): Map<string, ActiveSessionReport> {
  const sessions = new Map<string, ActiveSessionReport>();
  for (const item of input) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const sessionId = String(record.sessionId || '');
    const containerId = String(record.containerId || '');
    if (/^[a-f0-9-]{36}$/i.test(sessionId) && containerId.length <= 128) sessions.set(sessionId, {
      containerId, preparing: record.preparing === true, bootReady: record.bootReady === true,
      ...(Array.isArray(record.capabilities) ? { details: normalizeDeviceMetadata(record) } : {}),
      networkEnabled: typeof record.networkEnabled === 'boolean' ? record.networkEnabled : null,
    });
  }
  return sessions;
}


export function cleanProviderCapabilities(input: unknown): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  if (!Array.isArray(input)) return result;
  for (const provider of input.slice(0, 8)) {
    const record = provider as Record<string, unknown> | null;
    if (!record || record.status === 'unavailable' || !devicePlatform(record.kind) || typeof record.kind !== 'string' || !Array.isArray(record.capabilities)) continue;
    result[record.kind] = normalizeCapabilities(record.capabilities);
  }
  return result;
}


export function cleanAgentMetrics(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const source = input as Record<string, unknown>;
  const result: Record<string, unknown> = cleanLiveTelemetry(source);
  const numbers = ['cpuCores', 'cpuThreads', 'cpuPhysicalCores', 'memoryTotalMb',
    'memoryFreeMb', 'memoryAvailableMb', 'diskFreeGb', 'diskTotalGb',
    'cpuAllocatableCores', 'memoryAllocatableMb', 'agentCpuLimitCores', 'agentMemoryLimitMb'];
  const booleans = ['kvm', 'nvidiaGpuAvailable', 'driGpuAvailable', 'gpuPresent', 'privilegedEmulatorsAllowed'];
  const strings = ['cpuModel', 'architecture', 'gpuModel', 'gpuVendor', 'virtualizationType', 'hostIp'];
  if (Array.isArray(source.gpuCapabilities)) result.gpuCapabilities = [...new Set(source.gpuCapabilities.filter(value => value === 'cuda' || value === 'gpu'))];
  for (const key of numbers) {
    const value = source[key];
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000_000) result[key] = value;
  }
  for (const key of booleans) {
    if (typeof source[key] === 'boolean') result[key] = source[key];
  }
  for (const key of strings) {
    const value = source[key];
    if (typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[\x00-\x1f\x7f]/.test(value)) result[key] = value;
  }
  if (['bare-metal', 'virtual-machine', 'kubernetes-pod', 'unknown'].includes(String(source.environmentType))) {
    result.environmentType = source.environmentType;
  }
  if (['container', 'kubernetes-pod', 'process'].includes(String(source.agentRuntime))) {
    result.agentRuntime = source.agentRuntime;
  }
  return result;
}
