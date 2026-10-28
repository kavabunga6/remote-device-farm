import { getLanguage, languageInitializationFailed, setLanguage, subscribeLanguage, supportedLanguages, t, type Language } from './i18n';
import { useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Icon } from './icons';

export function useInterfaceLanguage() { return useSyncExternalStore(subscribeLanguage, getLanguage, getLanguage); }
export function LanguageControl() {
  const language = useInterfaceLanguage(), id = useId();
  const [open, setOpen] = useState(false), [query, setQuery] = useState('');
  const [pending, setPending] = useState<Language | null>(null);
  const [failed, setFailed] = useState(false);
  const initializationFailed = useSyncExternalStore(subscribeLanguage, languageInitializationFailed, languageInitializationFailed);
  const showFailure = failed || (!pending && initializationFailed);
  const mounted = useRef(true);
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const root = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null);
  const selected = supportedLanguages.find(item => item.id === language)!;
  const searchable = supportedLanguages.length > 6;
  const searchableText = (text: string) => text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
  const matches = supportedLanguages.filter(item => searchableText([item.name, item.search, item.id].join(' ')).includes(searchableText(query.trim())));
  const close = (restoreFocus = false) => { setOpen(false); setQuery(''); if (restoreFocus) trigger.current?.focus(); };
  useLayoutEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) close(); };
    document.addEventListener('pointerdown', outside);
    root.current?.querySelector<HTMLElement>(searchable ? 'input' : '[aria-checked="true"]')?.focus();
    return () => document.removeEventListener('pointerdown', outside);
  }, [open, searchable]);
  const choose = async (value: Language) => {
    if (pending) return;
    setPending(value); setFailed(false);
    try { await setLanguage(value); if (mounted.current) close(true); }
    catch { if (mounted.current) setFailed(true); }
    finally { if (mounted.current) setPending(null); }
  };
  return <div className="language-control" ref={root} onBlur={event => { if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) close(); }}>
    <button type="button" className="language-trigger" ref={trigger} aria-busy={Boolean(pending)} aria-label={`${t('language.label')}: ${selected.name}`} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => { if (open) close(); else setOpen(true); }} onKeyDown={event => { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setOpen(true); } }}>
      {pending ? <span className="mini-spinner" aria-hidden="true"/> : <Icon name="globe" size={17}/>}<bdi>{selected.name}</bdi><Icon name="chevronDown" size={14}/>
    </button>
    {open && <div className="language-popover" id={id} onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) || event.target instanceof HTMLInputElement && !event.key.startsWith('Arrow')) return;
      const items = [...root.current!.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')];
      if (!items.length) return;
      event.preventDefault();
      const at = items.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : at < 0 ? (event.key === 'ArrowDown' ? 0 : items.length - 1) : (at + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      items[next]?.focus();
    }}>
      <div className="language-menu-label">{t('language.label')}</div>
      {searchable && <input type="search" aria-label={t('language.search')} placeholder={t('language.search')} value={query} onChange={event => setQuery(event.target.value)} />}
      <div role="menu" aria-label={t('language.label')} className="language-options">{matches.map(item => <button key={item.id} type="button" role="menuitemradio" aria-checked={language === item.id} lang={item.id} disabled={Boolean(pending)} onClick={() => void choose(item.id)}><bdi>{item.name}</bdi>{language === item.id && <Icon name="check" size={17}/>}</button>)}</div>
      {!matches.length && <p role="status">{t('language.noResults')}</p>}
      {showFailure && <p role="alert">{t('language.loadFailed')}</p>}
    </div>}
    {showFailure && !open && <span role="alert" className="language-load-error">{t('language.loadFailed')}</span>}
  </div>;
}
