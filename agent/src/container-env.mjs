import { diagnostic } from './diagnostics.mjs';
// Extra environment variables for an emulator container. Same rules as the broker (server/src/container-env.ts):
// plain data only, never Docker run options, and the names the farm sets itself cannot be overridden.
export const MAX_CONTAINER_ENV = 16;
const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const RESERVED_NAMES = new Set(['ADBKEY_PUB', 'EMULATOR_PARAMS', 'AVD_CONFIG', 'GPU_ACCELERATED', 'PATH', 'HOME', 'USER', 'HOSTNAME']);
const RESERVED_PREFIXES = ['NVIDIA_', 'LD_', 'DOCKER_', 'RDF_'];

export function validateContainerEnv(value, extraReserved = []) {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error(diagnostic('container-env.26d41cf114'));
  const entries = Object.entries(value);
  if (entries.length > MAX_CONTAINER_ENV) throw new Error(diagnostic('container-env.0e8e743aff'));
  const result = {};
  for (const [name, item] of entries) {
    const upper = name.toUpperCase();
    if (extraReserved.some((reserved) => reserved.toUpperCase() === upper)) throw new Error(diagnostic('container-env.b565387247'));
    if (!NAME.test(name) || RESERVED_NAMES.has(upper) || RESERVED_PREFIXES.some((prefix) => upper.startsWith(prefix))) {
      throw new Error(diagnostic('container-env.b565387247'));
    }
    if (typeof item !== 'string' || item.length > 512 || /[\x00-\x1f\x7f]/.test(item)) throw new Error(diagnostic('container-env.f4443c5ce5'));
    result[name] = item;
  }
  return result;
}
