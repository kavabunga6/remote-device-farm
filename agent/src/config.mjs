import os from 'node:os';
import { GPU_BACKENDS, validateDockerOptions } from './docker-options.mjs';
import { validateContainerEnv } from './container-env.mjs';
import path from 'node:path';
import { validateEmulatorParams } from './emulator-params.mjs';

const imageNameComponent = '[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*';
const registryDomain = '[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?(?:\\.[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)*(?::[0-9]+)?';
const imageTag = '[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}';
const imageDigest = '@sha256:[a-f0-9]{64}';
const imagePattern = new RegExp(`^(?:${registryDomain}/)?${imageNameComponent}(?:/${imageNameComponent})*(?::${imageTag}(?:${imageDigest})?|${imageDigest})$`);
const googleImagePattern = /^us-docker\.pkg\.dev\/android-emulator-268719\/images\/(?:[0-9]+|[pqr])-(?:aosp|google|playstore)-x64(?:-no-metrics)?(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}(?:@sha256:[a-f0-9]{64})?|@sha256:[a-f0-9]{64})$/;
const identifierPattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

// The farm's own registry (same host as the broker, repository rdf-emulator) is trusted without configuration.
export function farmRegistryPrefix(brokerUrl) {
  try { return brokerUrl ? `${new URL(brokerUrl).host}/rdf-emulator` : null; } catch { return null; }
}

/** Credentials for one pull from the farm or company registry, sent by the server with the start command. */
export function validateRegistryAuth(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => !['username', 'password', 'serveraddress'].includes(key))) {
    throw new Error('Invalid registry credentials');
  }
  const { username, password, serveraddress } = value;
  if (typeof username !== 'string' || !username || username.length > 200 || typeof password !== 'string' || !password || password.length > 1000 ||
      typeof serveraddress !== 'string' || !/^[a-z0-9.-]+(:[0-9]{1,5})?$/i.test(serveraddress) || /[\x00-\x1f\x7f]/.test(username + password)) {
    throw new Error('Invalid registry credentials');
  }
  return { username, password, serveraddress };
}

export function validateImage(image, allowedPrefixes = [], trustedPrefixes = []) {
  if (typeof image !== 'string' || image.length > 256 || !imagePattern.test(image) || image.includes('..')) {
    throw new Error('Invalid Docker image reference');
  }
  if (/(?:^|\/)rdf-sdk-emulator(?::|@)/.test(image)) {
    throw new Error('SDK build placeholders are not supported; use a ready Docker image with an explicit tag or digest');
  }
  if (trustedPrefixes.some((prefix) => prefix && (image.startsWith(prefix + ':') || image.startsWith(prefix + '@')))) return image;
  if (!allowedPrefixes.length && !googleImagePattern.test(image)) {
    throw new Error('Only published Google Docker images are allowed by default; add a trusted ready Docker image to AGENT_ALLOWED_IMAGE_PREFIXES');
  }
  if (allowedPrefixes.length && !allowedPrefixes.some((prefix) =>
    image === prefix || (image.startsWith(prefix) &&
      (/[/:@]$/.test(prefix) || '/:@'.includes(image[prefix.length]))))) {
    throw new Error('Docker image is outside AGENT_ALLOWED_IMAGE_PREFIXES');
  }
  return image;
}

export function validateProfile(profile, allowedPrefixes = [], trustedPrefixes = []) {
  if (!profile || typeof profile !== 'object') throw new Error('Missing emulator profile');
  const image = validateImage(profile.image, allowedPrefixes, trustedPrefixes);
  const registryAuth = validateRegistryAuth(profile.registryAuth);
  const cpu = Number(profile.cpu);
  const memoryMb = Number(profile.memoryMb);
  const diskGb = Number(profile.diskGb ?? 8);
  if (!Number.isInteger(cpu) || cpu < 1 || cpu > 16) throw new Error('Profile CPU must be 1–16');
  if (!Number.isInteger(memoryMb) || memoryMb < 1024 || memoryMb > 65536) throw new Error('Profile memoryMb must be 1024–65536');
  const guestMemoryMb = profile.guestMemoryMb == null ? null : Number(profile.guestMemoryMb);
  const guestCores = profile.guestCores == null ? null : Number(profile.guestCores);
  if (guestMemoryMb !== null && (!Number.isInteger(guestMemoryMb) || guestMemoryMb < 1024 || guestMemoryMb > memoryMb - 1024)) {
    throw new Error('Guest memory must leave at least 1024 MiB for emulator overhead');
  }
  if (guestCores !== null && (!Number.isInteger(guestCores) || guestCores < 1 || guestCores > cpu)) {
    throw new Error('Guest cores must be within the container CPU limit');
  }
  if (!Number.isInteger(diskGb) || diskGb < 2 || diskGb > 128) throw new Error('Profile diskGb must be 2–128');
  const sdcardGb = profile.sdcardGb == null ? null : profile.sdcardGb;
  if (sdcardGb !== null && (!Number.isInteger(sdcardGb) || sdcardGb < 0 || sdcardGb > 32)) {
    throw new Error('Profile sdcardGb must be 0–32');
  }
  const sdCardMb = profile.sdCardMb == null ? (sdcardGb === null ? null : sdcardGb * 1024) : profile.sdCardMb;
  if (sdCardMb !== null && (!Number.isInteger(sdCardMb) || (sdCardMb !== 0 && (sdCardMb < 128 || sdCardMb > 32768)))) {
    throw new Error('Profile sdCardMb must be 0 or 128–32768');
  }
  if (profile.sdCardMb != null && sdcardGb !== null && profile.sdCardMb !== sdcardGb * 1024) {
    throw new Error('Conflicting SD card sizes');
  }
  const emulatorParams = profile.emulatorParams ?? '';
  if (typeof emulatorParams !== 'string' || emulatorParams.length > 2048 || /[\r\n\0]/.test(emulatorParams)) {
    throw new Error('Invalid EMULATOR_PARAMS');
  }
  const gpuMode = profile.gpuMode ?? 'software';
  if (gpuMode !== 'software' && gpuMode !== 'nvidia') throw new Error('Invalid GPU mode');
  const gpuBackend = profile.gpuBackend ?? null;
  if (gpuBackend !== null && !GPU_BACKENDS.includes(gpuBackend)) throw new Error('Invalid GPU backend');
  if (/(?:^|\s)-{1,2}gpu(?:\s|=|$)/i.test(emulatorParams)) {
    throw new Error('Select the GPU mode at session launch instead of EMULATOR_PARAMS');
  }
  if (guestMemoryMb !== null && /(?:^|\s)-memory(?:\s|=|$)/i.test(emulatorParams)) {
    throw new Error('Set guest RAM in one place');
  }
  if (guestCores !== null && /(?:^|\s)-cores(?:\s|=|$)/i.test(emulatorParams)) {
    throw new Error('Set guest cores in one place');
  }
  const checkedParams = validateEmulatorParams(emulatorParams);
  const rawEnv = profile.containerEnv && typeof profile.containerEnv === 'object' ? Object.keys(profile.containerEnv) : [];
  const dockerOptions = validateDockerOptions(profile.dockerOptions, (name) => rawEnv.some((item) => item.toUpperCase() === name.toUpperCase()));
  const containerEnv = validateContainerEnv(profile.containerEnv, [dockerOptions.emulatorParamsEnv, dockerOptions.adbKeyEnv].filter(Boolean));
  const deviceType = profile.deviceType == null ? null : String(profile.deviceType);
  if (deviceType !== null && !['mobile', 'tv', 'wear', 'automotive', 'desktop'].includes(deviceType)) throw new Error('Invalid device type');
  const resolution = profile.resolution == null ? null : String(profile.resolution);
  if (resolution !== null && !/^[1-9][0-9]{1,4}x[1-9][0-9]{1,4}$/.test(resolution)) throw new Error('Invalid screen resolution');
  return { image, cpu, memoryMb, guestMemoryMb, guestCores, diskGb,
    ...(sdCardMb === null ? {} : { sdCardMb }), emulatorParams: checkedParams, containerEnv, dockerOptions, gpuMode,
    gpuBackend: gpuMode === 'nvidia' ? gpuBackend : null, deviceType, resolution, ...(registryAuth ? { registryAuth } : {}) };
}

// Render node of the host GPU for the plain-GPU (non-NVIDIA) mode, for example /dev/dri/renderD128.
export function validateDriDevice(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !/^\/dev\/dri\/(?:renderD|card)[0-9]{1,3}$/.test(value)) {
    throw new Error('AGENT_DRI_DEVICE must look like /dev/dri/renderD128');
  }
  return value;
}

export function validateNvidiaXorgModuleDir(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > 4096 ||
      !path.posix.isAbsolute(value) || value === '/' || value.endsWith('/') ||
      path.posix.normalize(value) !== value ||
      /[\x00-\x1f\x7f:\\]/.test(value) ||
      value.split('/').some((part) => part === '.' || part === '..')) {
    throw new Error('AGENT_NVIDIA_XORG_MODULE_DIR must be a normalized absolute Linux directory');
  }
  return value;
}

export function loadConfig(env = process.env) {
  const brokerUrl = env.AGENT_BROKER_URL;
  const token = env.AGENT_TOKEN;
  const agentId = env.AGENT_ID;
  if (!brokerUrl || !/^wss?:\/\//.test(brokerUrl)) throw new Error('AGENT_BROKER_URL must be a ws:// or wss:// URL');
  if (!token || token.length < 32) throw new Error('AGENT_TOKEN must contain at least 32 characters');
  if (!agentId || !identifierPattern.test(agentId)) throw new Error('AGENT_ID must be 1–64 safe characters');
  const selfContainerId = env.AGENT_SELF_CONTAINER_ID || os.hostname();
  if (!identifierPattern.test(selfContainerId)) throw new Error('Invalid AGENT_SELF_CONTAINER_ID');
  const slots = Number(env.AGENT_SLOTS ?? Math.max(1, Math.floor(os.cpus().length / 2)));
  if (!Number.isInteger(slots) || slots < 1 || slots > 128) throw new Error('AGENT_SLOTS must be 1–128');
  const allowedPrefixes = (env.AGENT_ALLOWED_IMAGE_PREFIXES || '').split(',').map((x) => x.trim()).filter(Boolean);
  const nvidiaXorgModuleDir = validateNvidiaXorgModuleDir(env.AGENT_NVIDIA_XORG_MODULE_DIR);
  const driDevice = validateDriDevice(env.AGENT_DRI_DEVICE);
  const emuConsole = env.AGENT_EMU_CONSOLE || 'auto';
  if (!['auto', 'control', 'adb'].includes(emuConsole)) throw new Error('AGENT_EMU_CONSOLE must be auto, control or adb');
  const list = (value) => value ? new Set(value.split(',').map((x) => x.trim()).filter(Boolean)) : null;
  const usbEnabled = env.AGENT_USB_ENABLED === '1';
  const wipe = env.AGENT_USB_WIPE || null;
  const wipeCmd = env.AGENT_USB_WIPE_CMD || null;
  if (usbEnabled) {
    // A phone must never be handed to a second person without a full cleanup, so none of this has a lenient default.
    if (!list(env.AGENT_USB_ALLOWLIST)) throw new Error('AGENT_USB_ENABLED requires AGENT_USB_ALLOWLIST: only enrolled phones are managed (and wiped)');
    if (wipe !== 'command') {
      throw new Error('AGENT_USB_WIPE must be command: partial cleanup cannot protect the next user');
    }
    if (typeof wipeCmd !== 'string' || !wipeCmd.startsWith('/') || /[\0\r\n]/.test(wipeCmd) || path.posix.normalize(wipeCmd) === '/opt/rdf/reset-android.sh') {
      throw new Error('AGENT_USB_WIPE_CMD must explicitly name a trusted full reset/reprovision script; the legacy baseline reset is not sufficient');
    }
  }
  return {
    stateDir: env.AGENT_STATE_DIR || path.join(os.homedir(), '.android', 'rdf-state'),
    usb: { enabled: env.AGENT_USB_ENABLED === '1', allowlist: list(env.AGENT_USB_ALLOWLIST), wipe, wipeCmd },
    brokerUrl,
    token,
    agentId,
    name: env.AGENT_NAME || os.hostname(),
    selfContainerId,
    slots,
    allowedPrefixes,
    trustedPrefixes: [farmRegistryPrefix(brokerUrl)].filter(Boolean),
    nvidiaXorgModuleDir,
    driDevice,
    emuConsole,
    dockerSocket: env.DOCKER_SOCKET || '/var/run/docker.sock',
    scrcpyServerPath: env.SCRCPY_SERVER_PATH || '/opt/scrcpy/scrcpy-server',
    streamIntervalMs: Number(env.AGENT_SCREENSHOT_INTERVAL_MS || 800),
  };
}
