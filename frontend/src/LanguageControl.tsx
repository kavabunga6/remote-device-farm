import { getLanguage, languageInitializationFailed, setLanguage, subscribeLanguage, supportedLanguages, t, type Language } from './i18n';
import { useCallback, useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type FocusEvent, type KeyboardEvent, type RefObject } from 'react';
import { Icon } from './icons';

const searchable = supportedLanguages.length > 6;
const searchableText = (text: string) => text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
export function useInterfaceLanguage() { return useSyncExternalStore(subscribeLanguage, getLanguage, getLanguage); }

function useLanguageMenu() {
  const root = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false), [query, setQuery] = useState('');
  const close = useCallback((restoreFocus = false) => {
    setOpen(false); setQuery('');
    if (restoreFocus) trigger.current?.focus();
  }, []);
  useLayoutEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) close(); };
    document.addEventListener('pointerdown', outside);
    root.current?.querySelector<HTMLElement>(searchable ? 'input' : '[aria-checked="true"]')?.focus();
    return () => document.removeEventListener('pointerdown', outside);
  }, [open, close]);
  return { root, trigger, open, setOpen, query, setQuery, close };
}
function useLanguageSelection(close: (restoreFocus: boolean) => void) {
  const [pending, setPending] = useState<Language | null>(null);
  const mounted = useRef(true);
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const choose = async (value: Language) => {
    if (pending) return;
    setPending(value);
    try { await setLanguage(value); if (mounted.current) close(true); }
    catch { /* The shared language state exposes the failure. */ }
    finally { if (mounted.current) setPending(null); }
  };
  return { pending, choose };
}
function nextMenuIndex(key: string, current: number, length: number) {
  if (key === 'Home') return 0;
  if (key === 'End') return length - 1;
  const offset = key === 'ArrowDown' ? 1 : -1;
  if (current < 0) return offset > 0 ? 0 : length - 1;
  return (current + offset + length) % length;
}
function moveMenuFocus(event: KeyboardEvent, root: RefObject<HTMLDivElement | null>, close: (restoreFocus: boolean) => void) {
  if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); return; }
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
  if (event.target instanceof HTMLInputElement && !event.key.startsWith('Arrow')) return;
  const items = [...root.current!.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')];
  if (!items.length) return;
  event.preventDefault();
  const current = items.indexOf(document.activeElement as HTMLButtonElement);
  items[nextMenuIndex(event.key, current, items.length)]?.focus();
}
function closeOnBlur(event: FocusEvent, close: () => void) {
  if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) close();
}
function openOnArrow(event: KeyboardEvent, open: () => void) {
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); open(); }
}
type LanguageMenuProps = ReturnType<typeof useLanguageMenu> & ReturnType<typeof useLanguageSelection> & { id: string; language: Language; showFailure: boolean };
function LanguageMenu({ id, root, query, setQuery, language, pending, choose, close, showFailure }: LanguageMenuProps) {
  const matches = supportedLanguages.filter(item => searchableText([item.name, item.search, item.id].join(' ')).includes(searchableText(query.trim())));
  return <div className="language-popover" id={id} onKeyDown={event => moveMenuFocus(event, root, close)}>
    <div className="language-menu-label">{t('language.label')}</div>
    {searchable && <input type="search" aria-label={t('language.search')} placeholder={t('language.search')} value={query} onChange={event => setQuery(event.target.value)} />}
    <div role="menu" aria-label={t('language.label')} className="language-options">{matches.map(item => <button key={item.id} type="button" role="menuitemradio" aria-checked={language === item.id} lang={item.id} disabled={Boolean(pending)} onClick={() => void choose(item.id)}><bdi>{item.name}</bdi>{language === item.id && <Icon name="check" size={17}/>}</button>)}</div>
    {!matches.length && <p role="status">{t('language.noResults')}</p>}
    {showFailure && <p role="alert">{t('language.loadFailed')}</p>}
  </div>;
}
export function LanguageControl() {
  const language = useInterfaceLanguage(), id = useId();
  const menu = useLanguageMenu(), selection = useLanguageSelection(menu.close);
  const initializationFailed = useSyncExternalStore(subscribeLanguage, languageInitializationFailed, languageInitializationFailed);
  const showFailure = !selection.pending && initializationFailed;
  const selected = supportedLanguages.find(item => item.id === language)!;
  return <div className="language-control" ref={menu.root} onBlur={event => closeOnBlur(event, menu.close)}>
    <button type="button" className="language-trigger" ref={menu.trigger} aria-busy={Boolean(selection.pending)} aria-label={t('language.label') + ': ' + selected.name} aria-haspopup="menu" aria-expanded={menu.open} aria-controls={menu.open ? id : undefined} onClick={() => { if (menu.open) menu.close(); else menu.setOpen(true); }} onKeyDown={event => openOnArrow(event, () => menu.setOpen(true))}>
      {selection.pending ? <span className="mini-spinner" aria-hidden="true"/> : <Icon name="globe" size={17}/>}<bdi>{selected.name}</bdi><Icon name="chevronDown" size={14}/>
    </button>
    {menu.open && <LanguageMenu {...menu} {...selection} id={id} language={language} showFailure={showFailure}/>}
    {showFailure && !menu.open && <span role="alert" className="language-load-error">{t('language.loadFailed')}</span>}
  </div>;
}
