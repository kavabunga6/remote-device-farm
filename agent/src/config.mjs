import { agentIdentity, agentBrokerUrl } from './connection-config.mjs';
import { diagnostic } from './diagnostics.mjs';
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
    throw new Error(diagnostic('config.970966e516'));
  }
  const { username, password, serveraddress } = value;
  if (typeof username !== 'string' || !username || username.length > 200 || typeof password !== 'string' || !password || password.length > 1000 ||
      typeof serveraddress !== 'string' || !/^[a-z0-9.-]+(:[0-9]{1,5})?$/i.test(serveraddress) || /[\x00-\x1f\x7f]/.test(username + password)) {
    throw new Error(diagnostic('config.970966e516'));
  }
  return { username, password, serveraddress };
}

export function validateImage(image, allowedPrefixes = [], trustedPrefixes = []) {
  if (typeof image !== 'string' || image.length > 256 || !imagePattern.test(image) || image.includes('..')) {
    throw new Error(diagnostic('config.938fe9259c'));
  }
  if (/(?:^|\/)rdf-sdk-emulator(?::|@)/.test(image)) {
    throw new Error(diagnostic('config.2f9ffc482f'));
  }
  if (trustedPrefixes.some((prefix) => prefix && (image.startsWith(prefix + ':') || image.startsWith(prefix + '@')))) return image;
  if (!allowedPrefixes.length && !googleImagePattern.test(image)) {
    throw new Error(diagnostic('config.d15d0ef401'));
  }
  if (allowedPrefixes.length && !allowedPrefixes.some((prefix) =>
    image === prefix || (image.startsWith(prefix) &&
      (/[/:@]$/.test(prefix) || '/:@'.includes(image[prefix.length]))))) {
    throw new Error(diagnostic('config.5c7d02ad51'));
  }
  return image;
}

export function validateProfile(profile, allowedPrefixes = [], trustedPrefixes = []) {
  if (!profile || typeof profile !== 'object') throw new Error(diagnostic('config.0a398f25d2'));
  const image = validateImage(profile.image, allowedPrefixes, trustedPrefixes);
  const registryAuth = validateRegistryAuth(profile.registryAuth);
  const cpu = Number(profile.cpu);
  const memoryMb = Number(profile.memoryMb);
  const diskGb = Number(profile.diskGb ?? 8);
  if (!Number.isInteger(cpu) || cpu < 1 || cpu > 16) throw new Error(diagnostic('config.9b877e25a4'));
  if (!Number.isInteger(memoryMb) || memoryMb < 1024 || memoryMb > 65536) throw new Error(diagnostic('config.8a22287124'));
  const guestMemoryMb = profile.guestMemoryMb == null ? null : Number(profile.guestMemoryMb);
  const guestCores = profile.guestCores == null ? null : Number(profile.guestCores);
  if (guestMemoryMb !== null && (!Number.isInteger(guestMemoryMb) || guestMemoryMb < 1024 || guestMemoryMb > memoryMb - 1024)) {
    throw new Error(diagnostic('config.c216b77f2c'));
  }
  if (guestCores !== null && (!Number.isInteger(guestCores) || guestCores < 1 || guestCores > cpu)) {
    throw new Error(diagnostic('config.6990284d25'));
  }
  if (!Number.isInteger(diskGb) || diskGb < 2 || diskGb > 128) throw new Error(diagnostic('config.a7477231cc'));
  const sdcardGb = profile.sdcardGb == null ? null : profile.sdcardGb;
  if (sdcardGb !== null && (!Number.isInteger(sdcardGb) || sdcardGb < 0 || sdcardGb > 32)) {
    throw new Error(diagnostic('config.1e1a76a4a9'));
  }
  const sdCardMb = profile.sdCardMb == null ? (sdcardGb === null ? null : sdcardGb * 1024) : profile.sdCardMb;
  if (sdCardMb !== null && (!Number.isInteger(sdCardMb) || (sdCardMb !== 0 && (sdCardMb < 128 || sdCardMb > 32768)))) {
    throw new Error(diagnostic('config.28436bee10'));
  }
  if (profile.sdCardMb != null && sdcardGb !== null && profile.sdCardMb !== sdcardGb * 1024) {
    throw new Error(diagnostic('config.a35f42a187'));
  }
  const emulatorParams = profile.emulatorParams ?? '';
  if (typeof emulatorParams !== 'string' || emulatorParams.length > 2048 || /[\r\n\0]/.test(emulatorParams)) {
    throw new Error(diagnostic('config.ccfc57c42c'));
  }
  const gpuMode = profile.gpuMode ?? 'software';
  if (gpuMode !== 'software' && gpuMode !== 'nvidia') throw new Error(diagnostic('config.48e19476eb'));
  const gpuBackend = profile.gpuBackend ?? null;
  if (gpuBackend !== null && !GPU_BACKENDS.includes(gpuBackend)) throw new Error(diagnostic('config.4443b2186a'));
  if (/(?:^|\s)-{1,2}gpu(?:\s|=|$)/i.test(emulatorParams)) {
    throw new Error(diagnostic('config.7197b666f9'));
  }
  if (guestMemoryMb !== null && /(?:^|\s)-memory(?:\s|=|$)/i.test(emulatorParams)) {
    throw new Error(diagnostic('config.52fdf8d919'));
  }
  if (guestCores !== null && /(?:^|\s)-cores(?:\s|=|$)/i.test(emulatorParams)) {
    throw new Error(diagnostic('config.2c2373aa56'));
  }
  const checkedParams = validateEmulatorParams(emulatorParams);
  const rawEnv = profile.containerEnv && typeof profile.containerEnv === 'object' ? Object.keys(profile.containerEnv) : [];
  const dockerOptions = validateDockerOptions(profile.dockerOptions, (name) => rawEnv.some((item) => item.toUpperCase() === name.toUpperCase()));
  const containerEnv = validateContainerEnv(profile.containerEnv, [dockerOptions.emulatorParamsEnv, dockerOptions.adbKeyEnv].filter(Boolean));
  const deviceType = profile.deviceType == null ? null : String(profile.deviceType);
  if (deviceType !== null && !['mobile', 'tv', 'wear', 'automotive', 'desktop'].includes(deviceType)) throw new Error(diagnostic('config.7e13aba6db'));
  const resolution = profile.resolution == null ? null : String(profile.resolution);
  if (resolution !== null && !/^[1-9][0-9]{1,4}x[1-9][0-9]{1,4}$/.test(resolution)) throw new Error(diagnostic('config.872c97e09f'));
  return { image, cpu, memoryMb, guestMemoryMb, guestCores, diskGb,
    ...(sdCardMb === null ? {} : { sdCardMb }), emulatorParams: checkedParams, containerEnv, dockerOptions, gpuMode,
    gpuBackend: gpuMode === 'nvidia' ? gpuBackend : null, deviceType, resolution, ...(registryAuth ? { registryAuth } : {}) };
}

// Render node of the host GPU for the plain-GPU (non-NVIDIA) mode, for example /dev/dri/renderD128.
export function validateDriDevice(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !/^\/dev\/dri\/(?:renderD|card)[0-9]{1,3}$/.test(value)) {
    throw new Error(diagnostic('config.872d999074'));
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
    throw new Error(diagnostic('config.3aa4af5d7d'));
  }
  return value;
}

export function loadConfig(env = process.env) {
  const brokerUrl = agentBrokerUrl(env);
  const token = env.AGENT_TOKEN;
  const agentId = agentIdentity(env);
  if (!brokerUrl || !/^wss?:\/\//.test(brokerUrl)) throw new Error(diagnostic('config.03668fdbb8'));
  if (!token || token.length < 32) throw new Error(diagnostic('config.6644247c0c'));
  if (!agentId || !identifierPattern.test(agentId)) throw new Error(diagnostic('config.fee2f7bc20'));
  const selfContainerId = env.AGENT_SELF_CONTAINER_ID || os.hostname();
  if (!identifierPattern.test(selfContainerId)) throw new Error(diagnostic('config.fb11cd1562'));
  const slots = Number(env.AGENT_SLOTS ?? Math.max(1, Math.floor(os.cpus().length / 2)));
  if (!Number.isInteger(slots) || slots < 1 || slots > 128) throw new Error(diagnostic('config.746bdb70c0'));
  const allowedPrefixes = (env.AGENT_ALLOWED_IMAGE_PREFIXES || '').split(',').map((x) => x.trim()).filter(Boolean);
  const nvidiaXorgModuleDir = validateNvidiaXorgModuleDir(env.AGENT_NVIDIA_XORG_MODULE_DIR);
  const driDevice = validateDriDevice(env.AGENT_DRI_DEVICE);
  const emuConsole = env.AGENT_EMU_CONSOLE || 'auto';
  if (!['auto', 'control', 'adb'].includes(emuConsole)) throw new Error(diagnostic('config.b554dbae59'));
  const list = (value) => value ? new Set(value.split(',').map((x) => x.trim()).filter(Boolean)) : null;
  const usbEnabled = env.AGENT_USB_ENABLED === '1';
  const wipe = env.AGENT_USB_WIPE || null;
  const wipeCmd = env.AGENT_USB_WIPE_CMD || null;
  if (usbEnabled) {
    // A phone must never be handed to a second person without a full cleanup, so none of this has a lenient default.
    if (!list(env.AGENT_USB_ALLOWLIST)) throw new Error(diagnostic('config.ff46e8ed87'));
    if (wipe !== 'command') {
      throw new Error(diagnostic('config.cac238ed9f'));
    }
    if (typeof wipeCmd !== 'string' || !wipeCmd.startsWith('/') || /[\0\r\n]/.test(wipeCmd) || path.posix.normalize(wipeCmd) === '/opt/rdf/reset-android.sh') {
      throw new Error(diagnostic('config.298894e4d6'));
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
