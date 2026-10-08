// Docker-level options an administrator may set per profile. This is an allowlist: anything that could widen the
// container's reach (privileged mode, host network or PID/IPC, devices, bind mounts, capabilities, the Docker socket)
// is not representable here at all. Broker and agent run the same rules (agent/src/docker-options.mjs).
const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const ULIMITS = new Set(['nofile', 'nproc', 'core', 'stack']);
const SYSCTLS = new Set(['net.core.somaxconn', 'net.ipv4.tcp_syncookies', 'net.ipv4.ip_local_port_range', 'net.ipv4.tcp_tw_reuse']);
const TMPFS_PATH = /^\/(?:tmp|run|var\/tmp|dev\/shm)(?:\/[A-Za-z0-9._-]{1,64}){0,3}$/;
const KEYS = ['shmSizeMb', 'ulimits', 'tmpfs', 'sysctls', 'command', 'entrypoint', 'emulatorParamsEnv', 'adbKeyEnv', 'farmFlags'] as const;
// Flags managed by the farm, except graphics which is selected at launch.
export const FARM_FLAGS = ['partition-size', 'memory', 'cores', 'gpu', 'sdcard'] as const;
export const DEFAULT_EMULATOR_PARAMS_ENV = 'EMULATOR_PARAMS';
export const DEFAULT_ADB_KEY_ENV = 'ADBKEY_PUB';

export type DockerOptions = {
  shmSizeMb?: number;
  ulimits?: Array<{ name: string; soft: number; hard: number }>;
  tmpfs?: Array<{ path: string; sizeMb: number }>;
  sysctls?: Record<string, string>;
  command?: string[];
  entrypoint?: string[];
  emulatorParamsEnv?: string;
  adbKeyEnv?: string;
  farmFlags?: string[];
};

const integer = (value: unknown, min: number, max: number): value is number => typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
const argv = (value: unknown): string[] | null => {
  if (!Array.isArray(value) || value.length > 16) return null;
  return value.every(item => typeof item === 'string' && item.length > 0 && item.length <= 256 && !/[\x00-\x1f\x7f]/.test(item)) ? value as string[] : null;
};

/** Cleaned options, or an error that names the offending field. */
export function validateDockerOptions(value: unknown, reservedEnv: (name: string) => boolean = () => false): { value: DockerOptions } | { error: string } {
  if (value === undefined || value === null) return { value: {} };
  if (typeof value !== 'object' || Array.isArray(value)) return { error: 'dockerOptions must be an object' };
  const input = value as Record<string, unknown>;
  const unknown = Object.keys(input).find(key => !(KEYS as readonly string[]).includes(key));
  if (unknown) return { error: `${unknown} is not an allowed container option` };
  const out: DockerOptions = {};
  if (input.shmSizeMb !== undefined) {
    if (!integer(input.shmSizeMb, 64, 8192)) return { error: 'shmSizeMb must be a whole number from 64 to 8192' };
    out.shmSizeMb = input.shmSizeMb;
  }
  if (input.ulimits !== undefined) {
    if (!Array.isArray(input.ulimits) || input.ulimits.length > 4) return { error: 'ulimits must be a list of at most 4 items' };
    const seen = new Set<string>();
    out.ulimits = [];
    for (const item of input.ulimits as Array<Record<string, unknown>>) {
      if (!item || typeof item !== 'object' || !ULIMITS.has(String(item.name)) || seen.has(String(item.name)) ||
          !integer(item.soft, 0, 1_048_576) || !integer(item.hard, 0, 1_048_576) || (item.soft as number) > (item.hard as number)) {
        return { error: `each ulimit needs a name from ${[...ULIMITS].join(', ')}, soft <= hard, both up to 1048576` };
      }
      seen.add(String(item.name));
      out.ulimits.push({ name: String(item.name), soft: item.soft as number, hard: item.hard as number });
    }
  }
  if (input.tmpfs !== undefined) {
    if (!Array.isArray(input.tmpfs) || input.tmpfs.length > 4) return { error: 'tmpfs must be a list of at most 4 items' };
    out.tmpfs = [];
    for (const item of input.tmpfs as Array<Record<string, unknown>>) {
      if (!item || typeof item !== 'object' || typeof item.path !== 'string' || !TMPFS_PATH.test(item.path) || item.path.includes('..') || !integer(item.sizeMb, 1, 4096)) {
        return { error: 'each tmpfs item needs a path under /tmp, /run, /var/tmp or /dev/shm and sizeMb from 1 to 4096' };
      }
      out.tmpfs.push({ path: item.path, sizeMb: item.sizeMb as number });
    }
  }
  if (input.sysctls !== undefined) {
    if (!input.sysctls || typeof input.sysctls !== 'object' || Array.isArray(input.sysctls)) return { error: 'sysctls must be an object' };
    out.sysctls = {};
    for (const [key, item] of Object.entries(input.sysctls as Record<string, unknown>)) {
      if (!SYSCTLS.has(key) || (typeof item !== 'string' && typeof item !== 'number') || !/^[0-9 ]{1,32}$/.test(String(item))) {
        return { error: `sysctls allows only ${[...SYSCTLS].join(', ')} with numeric values` };
      }
      out.sysctls[key] = String(item);
    }
  }
  for (const key of ['command', 'entrypoint'] as const) {
    if (input[key] === undefined) continue;
    const list = argv(input[key]);
    if (!list) return { error: `${key} must be a list of at most 16 non-empty strings (no control characters, up to 256 each)` };
    out[key] = list;
  }
  for (const key of ['emulatorParamsEnv', 'adbKeyEnv'] as const) {
    if (input[key] === undefined) continue;
    const name = input[key];
    const fallback = key === 'emulatorParamsEnv' ? DEFAULT_EMULATOR_PARAMS_ENV : DEFAULT_ADB_KEY_ENV;
    if (typeof name !== 'string' || !NAME.test(name) || (name !== fallback && /^(PATH|HOME|USER|HOSTNAME|GPU_ACCELERATED$|NVIDIA_|LD_|DOCKER_|RDF_)/i.test(name)) || reservedEnv(name)) {
      return { error: `${key} must be a plain variable name that is not reserved and not also set as a container variable` };
    }
    out[key] = name;
  }
  if (input.farmFlags !== undefined) {
    if (!Array.isArray(input.farmFlags) || input.farmFlags.some(flag => !(FARM_FLAGS as readonly string[]).includes(String(flag))) || new Set(input.farmFlags).size !== input.farmFlags.length) {
      return { error: `farmFlags must be a list without repeats from: ${FARM_FLAGS.join(', ')}` };
    }
    out.farmFlags = input.farmFlags as string[];
  }
  if (out.emulatorParamsEnv && out.emulatorParamsEnv === out.adbKeyEnv) return { error: 'emulatorParamsEnv and adbKeyEnv must differ' };
  return { value: out };
}
