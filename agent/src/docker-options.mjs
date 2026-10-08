// Docker-level options a profile may set. An allowlist, mirrored from the broker (server/src/docker-options.ts): privileged
// mode, host network/PID/IPC, devices, bind mounts, capabilities and the Docker socket cannot be expressed here at all.
const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const ULIMITS = new Set(['nofile', 'nproc', 'core', 'stack']);
const SYSCTLS = new Set(['net.core.somaxconn', 'net.ipv4.tcp_syncookies', 'net.ipv4.ip_local_port_range', 'net.ipv4.tcp_tw_reuse']);
const TMPFS_PATH = /^\/(?:tmp|run|var\/tmp|dev\/shm)(?:\/[A-Za-z0-9._-]{1,64}){0,3}$/;
const KEYS = ['shmSizeMb', 'ulimits', 'tmpfs', 'sysctls', 'command', 'entrypoint', 'emulatorParamsEnv', 'adbKeyEnv', 'farmFlags'];
export const GPU_BACKENDS = ['cuda', 'gpu'];
export const DEFAULT_NVIDIA_CAPABILITIES = ['compute', 'graphics', 'utility', 'display'];
export const FARM_FLAGS = ['partition-size', 'memory', 'cores', 'gpu', 'sdcard'];
export const DEFAULT_EMULATOR_PARAMS_ENV = 'EMULATOR_PARAMS';
export const DEFAULT_ADB_KEY_ENV = 'ADBKEY_PUB';

const integer = (value, min, max) => typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
const argv = (value) => Array.isArray(value) && value.length <= 16 &&
  value.every((item) => typeof item === 'string' && item.length > 0 && item.length <= 256 && !/[\x00-\x1f\x7f]/.test(item)) ? value : null;

export function validateDockerOptions(value, reservedEnv = () => false) {
  if (value === undefined || value === null) return {};
  const fail = (message) => { throw new Error(`Invalid container options: ${message}`); };
  if (typeof value !== 'object' || Array.isArray(value)) fail('dockerOptions must be an object');
  const unknown = Object.keys(value).find((key) => !KEYS.includes(key));
  if (unknown) fail(`${unknown} is not allowed`);
  const out = {};
  if (value.shmSizeMb !== undefined) {
    if (!integer(value.shmSizeMb, 64, 8192)) fail('shmSizeMb');
    out.shmSizeMb = value.shmSizeMb;
  }
  if (value.ulimits !== undefined) {
    if (!Array.isArray(value.ulimits) || value.ulimits.length > 4) fail('ulimits');
    const seen = new Set();
    out.ulimits = value.ulimits.map((item) => {
      if (!item || typeof item !== 'object' || !ULIMITS.has(item.name) || seen.has(item.name) ||
          !integer(item.soft, 0, 1_048_576) || !integer(item.hard, 0, 1_048_576) || item.soft > item.hard) fail('ulimit');
      seen.add(item.name);
      return { name: item.name, soft: item.soft, hard: item.hard };
    });
  }
  if (value.tmpfs !== undefined) {
    if (!Array.isArray(value.tmpfs) || value.tmpfs.length > 4) fail('tmpfs');
    out.tmpfs = value.tmpfs.map((item) => {
      if (!item || typeof item !== 'object' || typeof item.path !== 'string' || !TMPFS_PATH.test(item.path) ||
          item.path.includes('..') || !integer(item.sizeMb, 1, 4096)) fail('tmpfs item');
      return { path: item.path, sizeMb: item.sizeMb };
    });
  }
  if (value.sysctls !== undefined) {
    if (!value.sysctls || typeof value.sysctls !== 'object' || Array.isArray(value.sysctls)) fail('sysctls');
    out.sysctls = {};
    for (const [key, item] of Object.entries(value.sysctls)) {
      if (!SYSCTLS.has(key) || (typeof item !== 'string' && typeof item !== 'number') || !/^[0-9 ]{1,32}$/.test(String(item))) fail('sysctl');
      out.sysctls[key] = String(item);
    }
  }
  for (const key of ['command', 'entrypoint']) {
    if (value[key] === undefined) continue;
    const list = argv(value[key]);
    if (!list) fail(key);
    out[key] = list;
  }
  for (const key of ['emulatorParamsEnv', 'adbKeyEnv']) {
    if (value[key] === undefined) continue;
    const fallback = key === 'emulatorParamsEnv' ? DEFAULT_EMULATOR_PARAMS_ENV : DEFAULT_ADB_KEY_ENV;
    const name = value[key];
    if (typeof name !== 'string' || !NAME.test(name) || (name !== fallback && /^(PATH|HOME|USER|HOSTNAME|GPU_ACCELERATED|NVIDIA_|LD_|DOCKER_|RDF_)/i.test(name)) || reservedEnv(name)) fail(key);
    out[key] = name;
  }
  if (value.farmFlags !== undefined) {
    if (!Array.isArray(value.farmFlags) || value.farmFlags.some((flag) => !FARM_FLAGS.includes(flag)) || new Set(value.farmFlags).size !== value.farmFlags.length) fail('farmFlags');
    out.farmFlags = value.farmFlags;
  }
  if (out.emulatorParamsEnv && out.emulatorParamsEnv === out.adbKeyEnv) fail('emulatorParamsEnv and adbKeyEnv must differ');
  return out;
}

/** The broker selects a backend from node capabilities for this launch only. */
export const gpuKind = (profile) => profile?.gpuBackend === 'gpu' ? 'dri' : profile?.gpuBackend === 'cuda' ? 'nvidia' : null;

export function resolveGpuBackend(profile, host) {
  if (profile.gpuMode !== 'nvidia') return null;
  const capabilities = Array.isArray(host.gpuCapabilities) ? host.gpuCapabilities : [
    ...(host.nvidiaRuntime === true || host.nvidiaGpuAvailable === true ? ['cuda'] : []),
    ...(host.driGpu === true || host.driGpuAvailable === true ? ['gpu'] : []),
  ];
  const backend = profile.gpuBackend ?? GPU_BACKENDS.find(value => capabilities.includes(value));
  if (!backend || !GPU_BACKENDS.includes(backend) || !capabilities.includes(backend)) {
    throw new Error('Requested GPU backend is not available on this node');
  }
  return backend;
}
