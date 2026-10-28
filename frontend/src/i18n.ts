import dictionary from '../../shared/messages.json';

export const supportedLanguages = [
  { id: 'ru', locale: 'ru-RU', labelKey: 'language.ru' },
  { id: 'en', locale: 'en-US', labelKey: 'language.en' },
] as const;
export type Language = typeof supportedLanguages[number]['id'];
export type MessageKey = keyof typeof dictionary;
type Params = Record<string, string | number | boolean | null | undefined>;
const storageKey = 'rdf.language';
const listeners = new Set<() => void>();
let language: Language = 'ru';
try { if (typeof localStorage !== 'undefined' && localStorage.getItem(storageKey) === 'en') language = 'en'; } catch { /* Optional storage. */ }
export const getLanguage = () => language;
export const getLocale = () => supportedLanguages.find(item => item.id === language)!.locale;
export const subscribeLanguage = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
function applyDocumentLanguage() { if (typeof document !== 'undefined') { document.documentElement.lang = language; document.title = t('app.title'); } }
applyDocumentLanguage();
export function setLanguage(value: Language): void {
  if (language === value || !supportedLanguages.some(item => item.id === value)) return;
  language = value; applyDocumentLanguage();
  try { localStorage.setItem(storageKey, value); } catch { /* Optional storage. */ }
  for (const listener of listeners) listener();
}
if (typeof window !== 'undefined') window.addEventListener('storage', event => {
  if (event.key === storageKey) setLanguage(event.newValue === 'en' ? 'en' : 'ru');
});
const rendered = new Map<string, { key: MessageKey; params: Params }>();
const exact = new Map<string, MessageKey>();
for (const [key, values] of Object.entries(dictionary)) for (const value of Object.values(values)) {
  if (!/\{p\d+\}/.test(value)) { exact.set(value, key as MessageKey); exact.set(value.replace(/[\s.]+$/, ''), key as MessageKey); }
}
export function t(key: MessageKey, params: Params = {}): string {
  const entry = dictionary[key];
  if (!entry) throw new Error('Missing translation key: ' + key);
  const value = entry[language].replace(/\{(\w+)\}/g, (placeholder, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name] ?? '') : placeholder);
  if (Object.keys(params).length) {
    if (rendered.size >= 5000) rendered.delete(rendered.keys().next().value!);
    rendered.set(value, { key, params });
  }
  return value;
}
type Template = { key: MessageKey; parts: string[]; weight: number };
const templates: Template[] = [];
for (const [key, values] of Object.entries(dictionary)) for (const value of Object.values(values)) {
  const parts = value.split(/(\{p\d+\})/g);
  // Linear delimiter matching; no wildcard regex over untrusted server text.
  if (parts.length > 1 && parts[0]!.length >= 3 && parts.every((part, index) => index % 2 === 1 || index === parts.length - 1 || part.length > 0)) {
    templates.push({ key: key as MessageKey, parts, weight: parts.filter((_, index) => index % 2 === 0).join('').length });
  }
}
templates.sort((left, right) => right.weight - left.weight);
function resolveMessage(value: string): { key: MessageKey; params: Params } | undefined {
  const saved = rendered.get(value); if (saved) return saved;
  const key = exact.get(value) ?? exact.get(value.replace(/[\s.]+$/, ''));
  if (key) return { key, params: {} };
  if (value.length > 2000) return undefined;
  for (const template of templates) {
    if (!value.startsWith(template.parts[0]!)) continue;
    let cursor = template.parts[0]!.length;
    const params: Params = {};
    let matches = true;
    for (let index = 1; index < template.parts.length; index += 2) {
      const delimiter = template.parts[index + 1]!;
      const end = delimiter ? value.indexOf(delimiter, cursor) : value.length;
      if (end < 0) { matches = false; break; }
      const name = template.parts[index]!.slice(1, -1);
      const parameter = value.slice(cursor, end);
      if (name in params && params[name] !== parameter) { matches = false; break; }
      params[name] = parameter; cursor = end + delimiter.length;
    }
    if (matches && cursor === value.length) return { key: template.key, params };
  }
  return undefined;
}
export const isInterfaceMessage = (value: string): boolean => Boolean(resolveMessage(value));

/** Resolve stored server notices as well as current UI copy; raw device output stays untouched. */
export function localizeText(value: string): string {
  const message = resolveMessage(value);
  return message ? t(message.key, message.params) : value;
}

export function errorMessage(status: number, message?: string): string {
  if (message && resolveMessage(message)) return localizeText(message);
  const key: MessageKey = status === 400 || status === 422 ? 'error.invalid'
    : status === 401 ? 'error.unauthorized' : status === 403 ? 'error.forbidden'
    : status === 404 ? 'error.notFound' : status === 409 ? 'error.conflict'
    : status === 413 ? 'error.tooLarge' : status === 429 ? 'error.rateLimit' : 'error.server';
  return t(key);
}

/** API codes resolve through the same dictionary; no feature module mutates global messages. */
export function knownErrorMessages(): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of Object.keys(dictionary).filter(key => key.startsWith('api.'))) {
    Object.defineProperty(result, key.slice(4), { enumerable: true, get: () => t(key as MessageKey) });
  }
  return result;
}
