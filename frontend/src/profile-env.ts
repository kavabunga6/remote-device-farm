import { t } from './i18n';
// Container environment variables are edited as text, one NAME=value per line, and sent as an object.
// Limits mirror the broker and the agent: 16 variables, plain names, the farm's own names are reserved.
const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const RESERVED_NAMES = new Set(['ADBKEY_PUB', 'EMULATOR_PARAMS', 'PATH', 'HOME', 'USER', 'HOSTNAME']);
const RESERVED_PREFIXES = ['NVIDIA_', 'LD_', 'DOCKER_', 'RDF_'];
export const MAX_CONTAINER_ENV = 16;

// Stored values are never sent back to the browser: the editor shows this mask, and a line that still holds it keeps the stored value.
export const ENV_VALUE_MASK = '••••••••';

export const containerEnvToText = (env: Record<string, string | null> | undefined): string =>
  Object.entries(env ?? {}).map(([name, value]) => `${name}=${value === null ? ENV_VALUE_MASK : value}`).join('\n');

export function parseContainerEnvText(text: string): { env: Record<string, string | null>; error?: string } {
  const env: Record<string, string | null> = {};
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (lines.length > MAX_CONTAINER_ENV) return { env, error: t('ui.013d8361fa70', { p0: MAX_CONTAINER_ENV }) };
  for (const line of lines) {
    const at = line.indexOf('=');
    const name = at < 0 ? line : line.slice(0, at).trim();
    const value = at < 0 ? '' : line.slice(at + 1);
    const upper = name.toUpperCase();
    if (at < 0) return { env, error: t('ui.91f07581d091', { p0: line.slice(0, 40) }) };
    if (!NAME.test(name)) return { env, error: t('ui.e3f56ac7eb52', { p0: name.slice(0, 40) }) };
    if (RESERVED_NAMES.has(upper) || RESERVED_PREFIXES.some(prefix => upper.startsWith(prefix))) return { env, error: t('ui.6260fc64b350', { p0: name }) };
    if (value.length > 512 || /[\x00-\x1f\x7f]/.test(value)) return { env, error: t('ui.8528b7dcc2c6', { p0: name }) };
    if (Object.hasOwn(env, name)) return { env, error: t('ui.ce8e2c3f85ce', { p0: name }) };
    env[name] = value === ENV_VALUE_MASK ? null : value;
  }
  return { env };
}
