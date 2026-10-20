import { devicePlatform, normalizeDeviceMetadata, sessionCapabilities, type DevicePlatform, type DeviceCapabilityReasons } from './generated/device-contract.js';
import { uiMessage } from './messages.js';
import { normalizeProfileResources, mergeLaunchStorage, type LaunchOptions } from './launch-options.js';
import { validateDockerOptions } from './docker-options.js';
import type { IncomingMessage } from 'node:http';
import type { Request, Response, RequestHandler } from 'express';
import type { Config } from './config.js';
import { validateContainerEnv } from './container-env.js';
import { cleanPhysicalDevices } from './physical-devices.js';
import { storedStartupProgress, type StartupProgress } from './startup-progress.js';

export class ApiError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) { super(message); }
}

export const route = (fn: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req, res, next) => { void fn(req, res).catch(next); };

export const statusMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);
export const boundedString = (value: unknown, max = 255): string => typeof value === 'string' && value.trim().length > 0 && value.length <= max ? value.trim() : '';
export const isUuid = (value: string): boolean => /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);

export function safeUploadName(original: unknown): string {
  if (typeof original !== 'string') return 'upload.bin';
  const name = original.normalize('NFC').replace(/[\/\\\p{Cc}\p{Cs}]/gu, '_').trim();
  if (!name || name === '.' || name === '..') return 'upload.bin';
  const truncate = (value: string, limit: number): string => {
    let output = '';
    let bytes = 0;
    for (const character of value) {
      const length = Buffer.byteLength(character, 'utf8');
      if (bytes + length > limit) break;
      output += character;
      bytes += length;
    }
    return output;
  };
  if (Buffer.byteLength(name, 'utf8') <= 240) return name;
  const dot = name.lastIndexOf('.');
  const extension = dot > 0 && Buffer.byteLength(name.slice(dot), 'utf8') <= 32 ? name.slice(dot) : '';
  const shortened = truncate(extension ? name.slice(0, dot) : name, 240 - Buffer.byteLength(extension)).trimEnd() + extension;
  return shortened && shortened !== '.' && shortened !== '..' ? shortened : 'upload.bin';
}

export type Session = {
  id: string; ownerId: string; hostId: string; profileId: string; adbKeyId: string | null; state: string;
  containerId: string | null; orientation: string; audioEnabled: boolean; networkEnabled: boolean;
  createdAt: string; startedAt: string | null; endedAt: string | null;
  profileName?: string; hostName?: string; ownerName?: string; error?: string | null;
  label: string | null; lastActivityAt: string;
  leaseTtlSeconds?: number | null; leaseExpiresAt?: string | null;
  startupProgress?: StartupProgress | null;
  platform?: DevicePlatform;
  sdkLevel?: number | null; osVersion?: string | null; capabilityReasons?: DeviceCapabilityReasons;
  deviceKind: string; deviceId: string | null; capabilities: string[] | null;
  launchOptions?: LaunchOptions;
  gpuMode: string | null; launchImage: string | null; launchMemoryMb: number | null;
  idleExpiresAt?: string | null; expiresAt?: string | null;
};

export function sessionJson(row: Record<string, unknown>): Session {
  return {
    id: String(row.id), ownerId: String(row.owner_user_id), hostId: String(row.host_id),
    profileId: String(row.profile_id), adbKeyId: row.adb_key_id == null ? null : String(row.adb_key_id), state: String(row.state),
    startupProgress: storedStartupProgress(row.startup_progress),
    containerId: row.container_id == null ? null : String(row.container_id),
    orientation: String(row.orientation), audioEnabled: row.audio_enabled === true,
    networkEnabled: row.network_enabled === true,
    gpuMode: row.gpu_mode == null ? null : String(row.gpu_mode),
    launchImage: row.launch_image == null ? null : String(row.launch_image),
    launchOptions: mergeLaunchStorage(row.launch_options ?? {}, { diskGb: row.launch_disk_gb == null ? undefined : Number(row.launch_disk_gb), sdcardGb: row.launch_sdcard_gb == null ? undefined : Number(row.launch_sdcard_gb) }),
    launchMemoryMb: row.launch_memory_mb == null ? null : Number(row.launch_memory_mb),
    createdAt: new Date(String(row.created_at)).toISOString(),
    startedAt: row.started_at ? new Date(String(row.started_at)).toISOString() : null,
    endedAt: row.ended_at ? new Date(String(row.ended_at)).toISOString() : null,
    profileName: row.profile_name ? String(row.profile_name) : undefined,
    hostName: row.host_name ? String(row.host_name) : undefined,
    ownerName: row.owner_name ? String(row.owner_name) : undefined,
    error: row.error ? String(row.error) : null,
    label: row.label ? String(row.label) : null,
    ...(devicePlatform(row.device_kind ?? 'emulator') ? { platform: devicePlatform(row.device_kind ?? 'emulator')! } : {}),
    deviceKind: row.device_kind == null ? 'emulator' : String(row.device_kind),
    deviceId: row.device_id == null ? null : String(row.device_id),
    ...normalizeDeviceMetadata(row.device_metadata),
    capabilities: sessionCapabilities(row.device_kind ?? 'emulator', row.capabilities),
    lastActivityAt: new Date(String(row.last_activity_at ?? row.created_at)).toISOString(),
    leaseTtlSeconds: row.lease_ttl_seconds == null ? null : Number(row.lease_ttl_seconds),
    leaseExpiresAt: row.lease_expires_at == null ? null : new Date(String(row.lease_expires_at)).toISOString(),
  };
}

/** `includeEnv` is for administrators only: container variables may hold credentials for a private image or service. */
export function profileJson(row: Record<string, unknown>, includeEnv = false) {
  row = normalizeProfileResources(row);
  return {
    id: String(row.id), name: String(row.name), androidVersion: String(row.android_version),
    recommended: row.recommended === true,
    allowLaunchOverrides: typeof row.allow_launch_overrides === 'boolean' ? row.allow_launch_overrides : null,
    launchOverridesAllowed: row.launch_overrides_allowed === true || row.allow_launch_overrides === true,
    deviceType: row.device_type == null ? null : String(row.device_type),
    imageTag: row.image_tag == null ? null : String(row.image_tag),
    imageFlavor: row.image_flavor == null ? null : String(row.image_flavor),
    image: String(row.image), cpu: Number(row.cpu), memoryMb: Number(row.memory_mb), diskGb: Number(row.disk_gb),
    diskMaxGb: row.disk_max_gb == null ? null : Number(row.disk_max_gb),
    sdcardGb: row.sdcard_gb == null ? null : Number(row.sdcard_gb),
    sdcardMaxGb: row.sdcard_max_gb == null ? null : Number(row.sdcard_max_gb),
    guestMemoryMb: row.guest_memory_mb == null ? null : Number(row.guest_memory_mb),
    guestCores: row.guest_cores == null ? null : Number(row.guest_cores),
    apiLevel: row.api_level == null ? null : Number(row.api_level),
    abi: row.abi == null ? null : String(row.abi),
    deviceModel: row.device_model == null ? null : String(row.device_model),
    resolution: row.resolution == null ? null : String(row.resolution),
    emulatorParams: String(row.emulator_params || ''),
    // Administrators see which variables exist, never their values (those are stored encrypted); null means "stored".
    ...(includeEnv === true ? {
      containerEnv: Object.fromEntries(Object.keys(row.container_env && typeof row.container_env === 'object' ? row.container_env as object : {}).map(name => [name, null])) as Record<string, string | null>,
      dockerOptions: (row.docker_options && typeof row.docker_options === 'object' ? row.docker_options : {}) as Record<string, unknown>,
    } : {}),
    enabled: row.enabled === true,
  };
}

export function hostJson(row: Record<string, unknown>) {
  const reportedSlots = Number(row.slots);
  const slotCap = row.slot_cap == null ? null : Number(row.slot_cap);
  const policySupported = Number(row.agent_policy_version) >= 1;
  const disabled = row.disabled === true;
  return {
    id: String(row.id), name: String(row.display_name || row.name),
    agentName: String(row.name), displayName: row.display_name == null ? null : String(row.display_name),
    status: String(row.status), slots: disabled ? 0 : policySupported ? reportedSlots : Math.min(reportedSlots, slotCap ?? reportedSlots, Number(row.manual_slots ?? reportedSlots)),
    reportedSlots, slotCap, slotMode: row.slot_mode === 'dynamic' ? 'dynamic' : 'manual',
    manualSlots: Number(row.manual_slots ?? 1), slotCpu: Number(row.slot_cpu ?? 4),
    slotMemoryMb: Number(row.slot_memory_mb ?? 4096), disabled, policySupported, imageBuilder: row.image_builder === true,
    policyPending: policySupported && Number(row.applied_policy_revision) !== Number(row.policy_revision),
    usedSlots: Number(row.used_slots || 0), metrics: row.metrics || {}, devices: cleanPhysicalDevices(row.devices),
    lastSeenAt: row.last_seen_at ? new Date(String(row.last_seen_at)).toISOString() : null,
  };
}

export function parseHostSettings(input: Record<string, unknown>, reportedSlots: number) {
  const displayName = input.displayName == null ? null : input.displayName;
  const slotCap = input.slotCap == null || input.slotCap === '' ? null : Number(input.slotCap);
  if ((displayName !== null && (typeof displayName !== 'string' || displayName.trim().length > 120 ||
      /[\x00-\x1f\x7f]/.test(displayName))) ||
      (slotCap !== null && (!Number.isInteger(slotCap) || slotCap < 0 || slotCap > reportedSlots))) {
    throw new ApiError(400, 'invalid_host_settings', uiMessage('ui.32e041b8df3b', {}, 'en'));
  }
  return { displayName: typeof displayName === 'string' ? displayName.trim() || null : null, slotCap };
}

export function parseProfile(input: Record<string, unknown>, options: { allowKeepEnv?: boolean } = {}) {
  const id = boundedString(input.id, 80);
  const name = boundedString(input.name, 120);
  const androidVersion = boundedString(input.androidVersion, 80);
  const image = boundedString(input.image, 255);
  const cpu = Number(input.cpu), memoryMb = Number(input.memoryMb), diskGb = Number(input.diskGb);
  const guestMemoryMb = input.guestMemoryMb == null || input.guestMemoryMb === '' ? null : Number(input.guestMemoryMb);
  const guestCores = input.guestCores == null || input.guestCores === '' ? null : Number(input.guestCores);
  const emulatorParams = input.emulatorParams == null ? '' : String(input.emulatorParams);
  const optionalGb = (value: unknown): number | null => value == null || value === '' ? null : Number(value);
  const diskMaxGb = optionalGb(input.diskMaxGb), sdcardGb = optionalGb(input.sdcardGb), sdcardMaxGb = optionalGb(input.sdcardMaxGb);
  const rawEnvNames = input.containerEnv && typeof input.containerEnv === 'object' && !Array.isArray(input.containerEnv) ? Object.keys(input.containerEnv) : [];
  const docker = validateDockerOptions(input.dockerOptions, name => rawEnvNames.some(item => item.toUpperCase() === name.toUpperCase()));
  if ('error' in docker) throw new ApiError(400, 'invalid_profile', 'Invalid container options: ' + docker.error);
  const dockerOptions = docker.value;
  const containerEnv = validateContainerEnv(input.containerEnv, { allowKeep: options.allowKeepEnv === true, extraReserved: [dockerOptions.emulatorParamsEnv, dockerOptions.adbKeyEnv].filter((item): item is string => Boolean(item)) });
  if (!containerEnv) throw new ApiError(400, 'invalid_profile', uiMessage('ui.9066d77faef6', {}, 'en'));
  // Legacy GPU fields are ignored. Acceleration is a session choice supported by the node.
  const allowLaunchOverrides = input.allowLaunchOverrides ?? null;
  if (allowLaunchOverrides !== null && typeof allowLaunchOverrides !== 'boolean') throw new ApiError(400, 'invalid_profile', uiMessage('ui.62c7404a574d', {}, 'en'));
  const recommended = input.recommended === undefined ? false : input.recommended;
  if (typeof recommended !== 'boolean') throw new ApiError(400, 'invalid_profile', uiMessage('ui.cd996b55df74', {}, 'en'));
  const deviceType = input.deviceType == null || input.deviceType === '' ? null : input.deviceType;
  const imageFlavor = input.imageFlavor == null || input.imageFlavor === '' ? null : input.imageFlavor;
  const optionalText = (value: unknown, max: number): string | null => {
    if (value == null || value === '') return null;
    if (typeof value !== 'string' || value.trim().length > max || /[\x00-\x1f\x7f]/.test(value)) {
      throw new ApiError(400, 'invalid_profile', uiMessage('ui.9c8933e8089d', {}, 'en'));
    }
    return value.trim() || null;
  };
  if (input.apiLevel != null && input.apiLevel !== '' && (typeof input.apiLevel !== 'number' && typeof input.apiLevel !== 'string' || !/^[0-9]+$/.test(String(input.apiLevel)))) {
    throw new ApiError(400, 'invalid_profile', uiMessage('ui.9c8933e8089d', {}, 'en'));
  }
  const apiLevel = input.apiLevel == null || input.apiLevel === '' ? null : Number(input.apiLevel);
  const abi = optionalText(input.abi, 120);
  const imageTag = optionalText(input.imageTag, 120);
  const deviceModel = optionalText(input.deviceModel, 120);
  const resolution = optionalText(input.resolution, 20)?.replace(/\s/g, '').replace(/[×х]/gi, 'x') ?? null;
  if ((apiLevel !== null && (!Number.isInteger(apiLevel) || apiLevel < 1 || apiLevel > 999)) ||
      (imageTag !== null && !/^[a-zA-Z0-9_.-]+$/.test(imageTag)) ||
      (abi !== null && !/^[a-zA-Z0-9_-]+(?:\s*,\s*[a-zA-Z0-9_-]+)*$/.test(abi)) ||
      (resolution !== null && !/^[1-9][0-9]{1,4}x[1-9][0-9]{1,4}$/.test(resolution))) {
    throw new ApiError(400, 'invalid_profile', uiMessage('ui.9c8933e8089d', {}, 'en'));
  }
  if (!/^[a-z][a-z0-9-]{1,79}$/.test(id) || !name || !androidVersion ||
      !/^[A-Za-z0-9._:/@-]+$/.test(image) || image.includes('..') ||
      (imageFlavor !== null && (typeof imageFlavor !== 'string' || !['aosp', 'google_apis', 'google_play'].includes(imageFlavor))) ||
      !Number.isInteger(cpu) || cpu < 1 || cpu > 16 ||
      !Number.isInteger(memoryMb) || memoryMb < 1024 || memoryMb > 65536 ||
      (guestMemoryMb !== null && (!Number.isInteger(guestMemoryMb) || guestMemoryMb < 1024 || guestMemoryMb > memoryMb - 1024)) ||
      (guestCores !== null && (!Number.isInteger(guestCores) || guestCores < 1 || guestCores > cpu)) ||
      !Number.isInteger(diskGb) || diskGb < 2 || diskGb > 128 ||
      (diskMaxGb !== null && (!Number.isInteger(diskMaxGb) || diskMaxGb < diskGb || diskMaxGb > 128)) ||
      (sdcardGb !== null && (!Number.isInteger(sdcardGb) || sdcardGb < 1 || sdcardGb > 32)) ||
      (sdcardMaxGb !== null && (!Number.isInteger(sdcardMaxGb) || sdcardMaxGb < (sdcardGb ?? 1) || sdcardMaxGb > 32)) ||
      // the sizes have their own fields; a second source in EMULATOR_PARAMS would silently win
      /(?:^|\s)-partition-size(?:\s|=|$)/.test(emulatorParams) ||
      ((sdcardGb !== null || sdcardMaxGb !== null) && /(?:^|\s)-sdcard(?:\s|=|$)/.test(emulatorParams)) ||
      emulatorParams.length > 500 || !/^[A-Za-z0-9._ ,=:+/\-]*$/.test(emulatorParams) ||
      (deviceType !== null && (typeof deviceType !== 'string' || !['mobile', 'tv', 'wear', 'automotive', 'desktop'].includes(deviceType))) ||
      /(?:^|\s)-{1,2}gpu(?:\s|=|$)/i.test(emulatorParams) ||
      (guestMemoryMb !== null && /(?:^|\s)-memory(?:\s|=|$)/i.test(emulatorParams)) ||
      (guestCores !== null && /(?:^|\s)-cores(?:\s|=|$)/i.test(emulatorParams))) {
    throw new ApiError(400, 'invalid_profile', uiMessage('ui.798f0abdf949', {}, 'en'));
  }
  return { id, name, androidVersion, recommended, allowLaunchOverrides, image, cpu, memoryMb, guestMemoryMb, guestCores, diskGb, diskMaxGb, sdcardGb, sdcardMaxGb, emulatorParams, containerEnv, dockerOptions, imageFlavor, deviceType, imageTag, apiLevel, abi, deviceModel, resolution };
}

export function inputParams(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApiError(400, 'invalid_input', uiMessage('ui.d8a2c836e52c', {}, 'en'));
  const input = value as Record<string, unknown>;
  const kind = input.kind;
  if (!['tap', 'swipe', 'key', 'text', 'touch'].includes(String(kind))) throw new ApiError(400, 'invalid_input', uiMessage('ui.2b3d96e2c537', {}, 'en'));
  if (kind === 'touch') {
    const action = input.action;
    const pointerId = Number(input.pointerId);
    const x = Number(input.x), y = Number(input.y);
    if (!['down', 'move', 'up'].includes(String(action)) || pointerId !== 0 ||
        !Number.isInteger(x) || x < 0 || x > 8192 ||
        !Number.isInteger(y) || y < 0 || y > 8192) {
      throw new ApiError(400, 'invalid_input', uiMessage('ui.9dc840102f82', {}, 'en'));
    }
    return { kind, action, pointerId, x, y };
  }
  if (kind === 'key') {
    const keyCode = Number(input.keyCode);
    if (!Number.isInteger(keyCode) || keyCode < 1 || keyCode > 300) throw new ApiError(400, 'invalid_input', uiMessage('ui.ee172faa9c17', {}, 'en'));
    return { kind, keyCode };
  }
  if (kind === 'text') {
    if (typeof input.text !== 'string' || input.text.length > 1000 || /[\r\n\0]/.test(input.text)) throw new ApiError(400, 'invalid_input', uiMessage('ui.1e3390409346', {}, 'en'));
    return { kind, text: input.text };
  }
  const keys = kind === 'tap' ? ['x', 'y'] : ['x1', 'y1', 'x2', 'y2'];
  const output: Record<string, unknown> = { kind };
  for (const key of keys) {
    const number = Number(input[key]);
    if (!Number.isInteger(number) || number < 0 || number > 8192) throw new ApiError(400, 'invalid_input', uiMessage('ui.e92fb0e92093', {}, 'en'));
    output[key] = number;
  }
  if (kind === 'swipe') {
    const durationMs = input.durationMs == null ? 300 : Number(input.durationMs);
    if (!Number.isInteger(durationMs) || durationMs < 50 || durationMs > 5000) throw new ApiError(400, 'invalid_input', uiMessage('ui.601d84d1f23d', {}, 'en'));
    output.durationMs = durationMs;
  }
  return output;
}

export function isAllowedOrigin(req: IncomingMessage, config: Config): boolean {
  const origin = req.headers.origin || req.headers.referer;
  if (!origin) return !req.headers.cookie || !!req.headers.authorization;
  let parsed: string;
  try { parsed = new URL(origin).origin; } catch { return false; }
  if (config.allowedOrigins.has(parsed)) return true;
  if (config.publicUrl) return false;
  const host = req.headers.host;
  if (!host) return false;
  return parsed === `http://${host}` || parsed === `https://${host}`;
}
