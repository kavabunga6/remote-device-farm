import { readFileSync } from 'node:fs';

// Operational diagnostics retain their stable wire text for log correlation.
const messages = JSON.parse(readFileSync(new URL('../../shared/diagnostics.json', import.meta.url), 'utf8')) as Record<string, string>;
export function diagnostic(key: string, params: Record<string, unknown> = {}): string {
  const message = messages[key];
  if (message === undefined) throw new Error('Missing diagnostic key: ' + key);
  return message.replace(/\{(p\d+)\}/g, (placeholder, name: string) => Object.hasOwn(params, name) ? String(params[name]) : placeholder);
}
