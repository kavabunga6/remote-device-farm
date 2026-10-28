import dictionary from '../../shared/messages.json';
import languages from '../../shared/languages.json';

async function fetchDictionary(url: URL): Promise<Messages> {
  const response = await fetch(url, { credentials: 'same-origin', cache: 'no-cache', signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error('language.download_failed');
  return response.json() as Promise<Messages>;
}
const loaders = {
  'zh-Hans': () => fetchDictionary(new URL('../../shared/locales/zh-Hans.json', import.meta.url)),
  hi: () => fetchDictionary(new URL('../../shared/locales/hi.json', import.meta.url)),
  es: () => fetchDictionary(new URL('../../shared/locales/es.json', import.meta.url)),
  ar: () => fetchDictionary(new URL('../../shared/locales/ar.json', import.meta.url)),
  fr: () => fetchDictionary(new URL('../../shared/locales/fr.json', import.meta.url)),
  bn: () => fetchDictionary(new URL('../../shared/locales/bn.json', import.meta.url)),
  'pt-BR': () => fetchDictionary(new URL('../../shared/locales/pt-BR.json', import.meta.url)),
  ur: () => fetchDictionary(new URL('../../shared/locales/ur.json', import.meta.url)),
  id: () => fetchDictionary(new URL('../../shared/locales/id.json', import.meta.url)),
  de: () => fetchDictionary(new URL('../../shared/locales/de.json', import.meta.url)),
};
export type Language = 'ru' | 'en' | keyof typeof loaders;
export type MessageKey = keyof typeof dictionary;
export const supportedLanguages = languages as ReadonlyArray<{ id: Language; locale: string; name: string; search: string; direction: 'ltr' | 'rtl' }>;
type Params = Record<string, string | number | boolean | null | undefined>;
type Messages = Record<MessageKey, string>;
const messages = new Map<Language, Messages>(['ru', 'en'].map(id => [id as Language, Object.fromEntries(Object.entries(dictionary).map(([key, entry]) => [key, entry[id as 'ru' | 'en']])) as Messages]));
const pendingLoads = new Map<Language, Promise<Messages>>();
const storageKey = 'rdf.language';
const listeners = new Set<() => void>();
export const isLanguage = (value: unknown): value is Language => supportedLanguages.some(item => item.id === value);
function storedLanguage(): Language {
  try { const saved = localStorage.getItem(storageKey); if (isLanguage(saved)) return saved; } catch { /* Optional storage. */ }
  return 'ru';
}
let language: Language = storedLanguage() === 'en' ? 'en' : 'ru';
let languageRequest = 0;
let initialLoadFailed = false;
export const getLanguage = () => language;
export const getLocale = () => supportedLanguages.find(item => item.id === language)!.locale;
export const getDirection = () => supportedLanguages.find(item => item.id === language)!.direction;
export const languageInitializationFailed = () => initialLoadFailed;
export const subscribeLanguage = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
function applyDocumentLanguage() {
  if (typeof document === 'undefined') return;
  document.documentElement.lang = language;
  document.documentElement.dir = getDirection();
  document.title = t('app.title');
}
async function loadLanguage(value: Language): Promise<Messages> {
  const cached = messages.get(value);
  if (cached) return cached;
  let pending = pendingLoads.get(value);
  if (!pending) {
    pending = loaders[value as keyof typeof loaders]().then(copy => {
      for (const key of Object.keys(dictionary) as MessageKey[]) {
        if (typeof copy[key] !== 'string' || !copy[key].trim()) throw new Error('Incomplete locale: ' + value + ':' + key);
      }
      messages.set(value, copy);
      indexMessages(copy);
      return copy;
    }).finally(() => pendingLoads.delete(value));
    pendingLoads.set(value, pending);
  }
  return pending;
}
/** Commit a language only after its complete dictionary has loaded. Older requests cannot replace a newer choice. */
export async function setLanguage(value: Language, persist = true): Promise<void> {
  if (!isLanguage(value)) return;
  const request = ++languageRequest;
  if (!messages.has(value)) await loadLanguage(value);
  if (request !== languageRequest) return;
  const recovered = initialLoadFailed;
  initialLoadFailed = false;
  if (persist) try { localStorage.setItem(storageKey, value); } catch { /* Optional storage. */ }
  if (language === value) { if (recovered) for (const listener of listeners) listener(); return; }
  language = value;
  applyDocumentLanguage();
  for (const listener of listeners) listener();
}
export async function initializeLanguage(): Promise<void> {
  try { await setLanguage(storedLanguage(), false); }
  catch { initialLoadFailed = true; }
  applyDocumentLanguage();
}
if (typeof window !== 'undefined') window.addEventListener('storage', event => {
  if (event.key === storageKey || event.key === null) void setLanguage(isLanguage(event.newValue) ? event.newValue : 'ru', false).catch(() => {
    initialLoadFailed = true;
    for (const listener of listeners) listener();
  });
});
const rendered = new Map<string, { key: MessageKey; params: Params }>();
const exact = new Map<string, MessageKey>();
type Template = { key: MessageKey; parts: string[]; weight: number };
const templates: Template[] = [];
function indexMessages(copy: Messages) {
  for (const [key, value] of Object.entries(copy)) {
    if (!/\{\w+\}/.test(value)) { exact.set(value, key as MessageKey); exact.set(value.replace(/[\s.]+$/, ''), key as MessageKey); }
    const parts = value.split(/(\{\w+\})/g);
    // Linear delimiter matching; no wildcard regex over untrusted server text.
    if (parts.length > 1 && parts[0]!.length >= 3 && parts.every((part, index) => index % 2 === 1 || index === parts.length - 1 || part.length > 0)) {
      templates.push({ key: key as MessageKey, parts, weight: parts.filter((_, index) => index % 2 === 0).join('').length });
    }
  }
  templates.sort((left, right) => right.weight - left.weight);
}
for (const copy of messages.values()) indexMessages(copy);
applyDocumentLanguage();
export function t(key: MessageKey, params: Params = {}): string {
  const entry = messages.get(language)![key];
  if (entry === undefined) throw new Error('Missing translation key: ' + key);
  const value = entry.replace(/\{(\w+)\}/g, (placeholder, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name] ?? '') : placeholder);
  if (Object.keys(params).length) {
    if (rendered.size >= 5000) rendered.delete(rendered.keys().next().value!);
    rendered.set(value, { key, params });
  }
  return value;
}
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
