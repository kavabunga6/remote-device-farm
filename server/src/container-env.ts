// Extra environment variables an administrator may set on an emulator container (for images that read their own
// settings from the environment). Deliberately narrow: this is data, never a way to change how Docker runs the
// container (no mounts, devices, capabilities, networks or command line).
export const MAX_CONTAINER_ENV = 16;
const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
// The farm sets these itself; a profile must not be able to override them.
const RESERVED_NAMES = new Set(['ADBKEY_PUB', 'EMULATOR_PARAMS', 'AVD_CONFIG', 'GPU_ACCELERATED', 'PATH', 'HOME', 'USER', 'HOSTNAME']);
const RESERVED_PREFIXES = ['NVIDIA_', 'LD_', 'DOCKER_', 'RDF_'];

/** Returns the cleaned map, or null when the input is not a valid environment. */
export function validateContainerEnv(value: unknown, options: { allowKeep?: boolean; extraReserved?: string[] } = {}): Record<string, string | null> | null {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) return null;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > MAX_CONTAINER_ENV) return null;
  const result: Record<string, string | null> = {};
  for (const [name, item] of entries) {
    if (options.extraReserved?.some(reserved => reserved.toUpperCase() === name.toUpperCase())) return null;
    if (!NAME.test(name) || RESERVED_NAMES.has(name.toUpperCase()) || RESERVED_PREFIXES.some(prefix => name.toUpperCase().startsWith(prefix))) return null;
    // null means "keep the value that is already stored": variable values are never sent back to the browser.
    if (item === null && options.allowKeep) { result[name] = null; continue; }
    if (typeof item !== 'string' || item.length > 512 || /[\x00-\x1f\x7f]/.test(item)) return null;
    result[name] = item;
  }
  return result;
}
