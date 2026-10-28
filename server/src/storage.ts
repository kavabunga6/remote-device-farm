import { diagnostic } from './diagnostics.js';
import { uiMessage } from './messages.js';
import { ApiError } from './http-common.js';

export const MIN_DISK_GB = 2;
export const MAX_DISK_GB = 128;
export const MAX_SDCARD_GB = 32;

export type StorageRequest = { diskGb?: number; sdcardGb?: number };
export type Storage = { diskGb: number; sdcardGb: number | null };
type ProfileStorage = { disk_gb?: unknown; disk_max_gb?: unknown; sdcard_gb?: unknown; sdcard_max_gb?: unknown };

const whole = (value: unknown): number | null => typeof value === 'number' && Number.isInteger(value) ? value : null;

/** Reads the optional user choice from a request body. Absent values mean "use the profile default". */
export function parseStorageRequest(body: unknown): StorageRequest {
  const source = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const request: StorageRequest = {};
  for (const key of ['diskGb', 'sdcardGb'] as const) {
    if (source[key] === undefined || source[key] === null || source[key] === '') continue;
    const value = whole(source[key]);
    if (value === null) throw new ApiError(400, 'invalid_storage', uiMessage('ui.2d5aa067776b', {}, 'en'));
    request[key] = value;
  }
  return request;
}

/** Limits a profile allows: what the user may pick when starting a session. */
export function storageLimits(profile: ProfileStorage): { diskMin: number; diskDefault: number; diskMax: number; sdcardDefault: number; sdcardMax: number } {
  const diskDefault = Number(profile.disk_gb);
  const diskMax = profile.disk_max_gb == null ? diskDefault : Math.max(diskDefault, Number(profile.disk_max_gb));
  const sdcardDefault = profile.sdcard_gb == null ? 0 : Number(profile.sdcard_gb);
  const sdcardMax = profile.sdcard_max_gb == null ? sdcardDefault : Math.max(sdcardDefault, Number(profile.sdcard_max_gb));
  return { diskMin: Math.min(MIN_DISK_GB, diskDefault), diskDefault, diskMax, sdcardDefault, sdcardMax };
}

/** Applies the user's choice inside the profile limits. A size of 0 for the SD card means no card. */
export function resolveStorage(profile: ProfileStorage, request: StorageRequest = {}): Storage {
  const limits = storageLimits(profile);
  const diskGb = request.diskGb ?? limits.diskDefault;
  const sdcardGb = request.sdcardGb ?? limits.sdcardDefault;
  if (!Number.isInteger(diskGb) || diskGb < limits.diskMin || diskGb > Math.min(MAX_DISK_GB, limits.diskMax)) {
    throw new ApiError(409, 'storage_out_of_range', uiMessage('ui.e242377da8ff', { p0: limits.diskMin, p1: limits.diskMax }, 'en'));
  }
  if (!Number.isInteger(sdcardGb * 1024) || sdcardGb < 0 || (sdcardGb > 0 && sdcardGb < 0.125) || sdcardGb > Math.min(MAX_SDCARD_GB, limits.sdcardMax)) {
    throw new ApiError(409, 'storage_out_of_range', limits.sdcardMax ? diagnostic('storage.4eef2b8c39', { p0: limits.sdcardMax }) : diagnostic('storage.47fb7a24c3'));
  }
  return { diskGb, sdcardGb: sdcardGb > 0 ? sdcardGb : null };
}
