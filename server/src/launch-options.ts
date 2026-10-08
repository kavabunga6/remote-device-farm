import { hasPermission } from './permissions.js';
import { uiMessage } from './messages.js';
import { ApiError } from './http-common.js';
import { resolveStorage, type StorageRequest } from './storage.js';

export type LaunchOptions = {
  cpu?: number; memoryMb?: number; guestCores?: number | null; guestMemoryMb?: number | null;
  diskGb?: number; sdCardMb?: number; emulatorParams?: string; privileged?: boolean;
};
export type ResolvedLaunchOptions = LaunchOptions & {
  cpu: number; memoryMb: number; guestCores: number | null; guestMemoryMb: number | null;
  diskGb: number; sdCardMb: number; emulatorParams: string;
};
const FLAGS = new Set(['-no-snapshot', '-no-snapshot-load', '-no-snapshot-save', '-no-boot-anim', '-wipe-data', '-no-audio', '-noaudio', '-no-window', '-no-cache', '-nocache', '-show-kernel', '-verbose', '-no-metrics']);
const NETWORK = new Set(['gsm', 'hscsd', 'gprs', 'edge', 'umts', 'hsdpa', 'lte', 'evdo']);
function invalid(message: string): never { throw new ApiError(400, 'invalid_launch_options', message); }
function range(value: string, min: number, max: number, ordered = true): boolean {
  if (!/^[0-9]+(?::[0-9]+)?$/.test(value)) return false;
  const parts = value.split(':').map(Number);
  return parts.every(n => Number.isSafeInteger(n) && n >= min && n <= max) && (!ordered || parts.length === 1 || parts[0]! <= parts[1]!);
}
export function parseEmulatorParams(value: unknown): string {
  if (typeof value !== 'string' || value.length > 500 || /[^A-Za-z0-9._ :/+-]/.test(value)) invalid('emulatorParams must be at most 500 characters and contain only supported emulator arguments');
  const tokens = value.trim() ? value.trim().split(/ +/) : [];
  const seen = new Set<string>();
  for (let i = 0; i < tokens.length; i++) {
    const flag = tokens[i]!;
    const canonical = flag === '-noaudio' ? '-no-audio' : flag === '-nocache' ? '-no-cache' : flag;
    if (seen.has(canonical)) invalid('Duplicate emulator argument: ' + flag);
    seen.add(canonical);
    if (FLAGS.has(flag)) continue;
    const argument = tokens[++i] ?? '';
    const valid = flag === '-timezone' ? /^[A-Za-z][A-Za-z0-9_+\-]*(?:\/[A-Za-z0-9_+\-]+){1,2}$/.test(argument)
      : flag === '-change-language' ? /^[A-Za-z]{2,3}$/.test(argument)
      : flag === '-change-country' ? /^[A-Za-z]{2}$/.test(argument)
      : flag === '-netdelay' ? NETWORK.has(argument) || argument === 'none' || range(argument, 0, 60_000)
      : flag === '-netspeed' ? NETWORK.has(argument) || argument === 'full' || range(argument, 1, 1_000_000, false)
      : flag === '-camera-back' || flag === '-camera-front' ? ['emulated', 'none', 'environment'].includes(argument)
      : flag === '-screen' ? ['touch', 'multi-touch', 'no-touch'].includes(argument) : false;
    if (!valid) invalid('Unsupported emulator argument or value: ' + flag);
  }
  return tokens.join(' ');
}
export function parseLaunchOptions(value: unknown): LaunchOptions {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('launchOptions must be an object');
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !['cpu', 'memoryMb', 'guestCores', 'guestMemoryMb', 'diskGb', 'sdCardMb', 'emulatorParams', 'privileged'].includes(key))) invalid('Unknown launch option; Docker host arguments are not supported');
  const result: LaunchOptions = {};
  for (const [key, min, max] of [['cpu', 1, 16], ['memoryMb', 1024, 65536], ['guestCores', 1, 16], ['guestMemoryMb', 1024, 64512]] as const) {
    const value = input[key];
    if (value === undefined) continue;
    // null preserves an explicit image default in queued/session snapshots.
    if (value === null && (key === 'guestCores' || key === 'guestMemoryMb')) { result[key] = null; continue; }
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) invalid(`${key} must be an integer from ${min} to ${max}`);
    result[key] = value;
  }
  if (input.diskGb !== undefined) {
    if (typeof input.diskGb !== 'number' || !Number.isInteger(input.diskGb) || input.diskGb < 2 || input.diskGb > 128) invalid('diskGb must be an integer from 2 to 128 GiB');
    result.diskGb = input.diskGb;
  }
  if (input.sdCardMb !== undefined) {
    if (typeof input.sdCardMb !== 'number' || !Number.isInteger(input.sdCardMb) || (input.sdCardMb !== 0 && (input.sdCardMb < 128 || input.sdCardMb > 32768))) invalid('sdCardMb must be 0 or an integer from 128 to 32768 MiB');
    result.sdCardMb = input.sdCardMb;
  }
  if (input.emulatorParams !== undefined) result.emulatorParams = parseEmulatorParams(input.emulatorParams);
  if (input.privileged !== undefined) {
    if (typeof input.privileged !== 'boolean') invalid('privileged must be a boolean');
    result.privileged = input.privileged;
  }
  return result;
}
export function assertLaunchOptionsAccess(options: LaunchOptions, user: { role: string }): void {
  if (options.privileged === true && !hasPermission(user, 'sessions.configure')) {
    throw new ApiError(403, 'privileged_launch_forbidden', uiMessage('ui.396b811c890c', {}, 'en'));
  }
}
export function assertHostLaunchOptions(options: LaunchOptions, metrics: Record<string, unknown>): void {
  if (options.privileged === true && metrics.privilegedEmulatorsAllowed !== true) {
    throw new ApiError(409, 'privileged_launch_unavailable', uiMessage('ui.96b8feeb12d9', {}, 'en'));
  }
}
// Older administrator profiles stored guest CPU/RAM flags in EMULATOR_PARAMS.
// Lift only these bounded resource flags into typed fields before applying user overrides.
export function normalizeProfileResources<T extends Record<string, unknown>>(profile: T): T {
  const normalized: Record<string, unknown> = { ...profile };
  const remaining: string[] = [];
  const seen = new Set<string>();
  const tokens = String(profile.emulator_params || '').trim().split(/ +/).filter(Boolean);
  for (let i = 0; i < tokens.length; i++) {
    const match = /^(-memory|-cores)(?:=([0-9]+))?$/.exec(tokens[i]!);
    if (!match) { remaining.push(tokens[i]!); continue; }
    const flag = match[1]!;
    const field = flag === '-memory' ? 'guest_memory_mb' : 'guest_cores';
    const raw = match[2] ?? tokens[++i] ?? '';
    const value = Number(raw);
    const minimum = flag === '-memory' ? 1024 : 1;
    const maximum = flag === '-memory' ? Number(profile.memory_mb) - 1024 : Number(profile.cpu);
    if (seen.has(flag) || profile[field] != null || !/^[0-9]+$/.test(raw) || !Number.isInteger(value) || value < minimum || value > maximum) {
      invalid('Invalid or conflicting resource argument in administrator profile: ' + flag);
    }
    seen.add(flag);
    normalized[field] = value;
  }
  normalized.emulator_params = remaining.join(' ');
  return normalized as T;
}
/** One representation for legacy GiB fields and nested MiB launch options. */
export function mergeLaunchStorage(requested: unknown, storage: StorageRequest = {}): LaunchOptions {
  const options = parseLaunchOptions(requested);
  if (storage.diskGb !== undefined) {
    if (options.diskGb !== undefined && options.diskGb !== storage.diskGb) invalid('diskGb conflicts with launchOptions.diskGb');
    options.diskGb = storage.diskGb;
  }
  if (storage.sdcardGb !== undefined) {
    const mb = storage.sdcardGb * 1024;
    if (options.sdCardMb !== undefined && options.sdCardMb !== mb) invalid('sdcardGb conflicts with launchOptions.sdCardMb');
    options.sdCardMb = mb;
  }
  // Reparse aliases and stabilize property order for idempotency fingerprints.
  return parseLaunchOptions(options);
}
/** Snapshot effective values once; later profile edits do not change queued or running resources. */
export function resolveLaunchOptions(profile: Record<string, unknown>, requested: LaunchOptions, user: { role: string } = { role: 'user' }): ResolvedLaunchOptions {
  const options = parseLaunchOptions(requested);
  const normalized = normalizeProfileResources(profile);
  const cpu = options.cpu ?? Number(normalized.cpu);
  const memoryMb = options.memoryMb ?? Number(normalized.memory_mb);
  const guestCores = options.guestCores !== undefined ? options.guestCores : normalized.guest_cores == null ? null : Number(normalized.guest_cores);
  const guestMemoryMb = options.guestMemoryMb !== undefined ? options.guestMemoryMb : normalized.guest_memory_mb == null ? null : Number(normalized.guest_memory_mb);
  if (!Number.isInteger(cpu) || cpu < 1 || cpu > 16 || !Number.isInteger(memoryMb) || memoryMb < 1024 || memoryMb > 65536) {
    throw new ApiError(409, 'invalid_profile', uiMessage('ui.4820e3030385', {}, 'en'));
  }
  if (!hasPermission(user, 'sessions.configure') && (cpu > Number(normalized.cpu) || memoryMb > Number(normalized.memory_mb))) {
    throw new ApiError(403, 'resource_limit_forbidden', uiMessage('ui.97acdae50af9', {}, 'en'));
  }
  if (guestCores !== null && (!Number.isInteger(guestCores) || guestCores < 1 || guestCores > cpu)) {
    throw new ApiError(409, 'resources_out_of_range', uiMessage('ui.57da7ffe19c2', {}, 'en'));
  }
  if (guestMemoryMb !== null && (!Number.isInteger(guestMemoryMb) || guestMemoryMb < 1024 || guestMemoryMb > memoryMb - 1024)) {
    throw new ApiError(409, 'resources_out_of_range', uiMessage('ui.f16e742c8d4e', {}, 'en'));
  }
  const storage = resolveStorage(normalized, { diskGb: options.diskGb, sdcardGb: options.sdCardMb === undefined ? undefined : options.sdCardMb / 1024 });
  return { ...options, cpu, memoryMb, guestCores, guestMemoryMb, diskGb: storage.diskGb, sdCardMb: (storage.sdcardGb ?? 0) * 1024, emulatorParams: options.emulatorParams ?? parseEmulatorParams(normalized.emulator_params || '') };
}
