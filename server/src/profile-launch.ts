import { uiMessage } from './messages.js';
import { ApiError } from './http-common.js';
import type { GpuMode } from './gpu-modes.js';
export type { GpuMode } from './gpu-modes.js';

export function parseRequestedGpuMode(value: unknown): GpuMode | undefined {
  if (value === undefined) return undefined;
  if (value !== 'software' && value !== 'nvidia') throw new ApiError(400, 'invalid_gpu_mode', uiMessage('ui.0049c11e2298', {}, 'en'));
  return value;
}

export function resolveProfileLaunch(
  profile: { id?: unknown; device_type?: unknown; abi?: unknown; image?: unknown; memory_mb?: unknown }, requested?: GpuMode,
): { gpuMode: GpuMode; image: string; memoryMb: number } {
  const gpuMode = parseRequestedGpuMode(requested) ?? 'software';
  const image = profile.image;
  if (typeof image !== 'string' || !image) throw new ApiError(409, 'invalid_profile', uiMessage('ui.8d02bff71eee', {}, 'en'));
  const memoryMb = Number(profile.memory_mb);
  if (!Number.isInteger(memoryMb) || memoryMb < 1024 || memoryMb > 65536) {
    throw new ApiError(409, 'invalid_profile', uiMessage('ui.cf98c2157e00', {}, 'en'));
  }
  return { gpuMode, image, memoryMb };
}
