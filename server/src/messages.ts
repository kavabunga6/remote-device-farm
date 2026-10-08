import { readFileSync } from 'node:fs';

// One source for browser copy, API explanations and persisted notifications.
// Keep the established wire language; the browser resolves it in the selected language.
const dictionary = JSON.parse(readFileSync(new URL('../../shared/messages.json', import.meta.url), 'utf8')) as Record<string, { ru: string; en: string }>;
export function uiMessage(key: string, params: Record<string, unknown> = {}, language: 'ru' | 'en' = 'ru'): string {
  const entry = dictionary[key];
  if (!entry) throw new Error('Missing UI message key: ' + key);
  return entry[language].replace(/\{(\w+)\}/g, (placeholder, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name] ?? '') : placeholder);
}
