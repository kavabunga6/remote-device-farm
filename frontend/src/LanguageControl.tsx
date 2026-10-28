import { getLanguage, setLanguage, subscribeLanguage, supportedLanguages, t, type Language } from './i18n';
import { useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Icon } from './icons';

export function useInterfaceLanguage() { return useSyncExternalStore(subscribeLanguage, getLanguage, getLanguage); }
export function LanguageControl() {
  const language = useInterfaceLanguage(), id = useId();
  const [open, setOpen] = useState(false), [query, setQuery] = useState('');
  const root = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null);
  const selected = supportedLanguages.find(item => item.id === language)!;
  const searchable = supportedLanguages.length > 6;
  const matches = supportedLanguages.filter(item => t(item.labelKey).toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const close = (restoreFocus = false) => { setOpen(false); setQuery(''); if (restoreFocus) trigger.current?.focus(); };
  useLayoutEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) close(); };
    document.addEventListener('pointerdown', outside);
    root.current?.querySelector<HTMLElement>(searchable ? 'input' : '[aria-checked="true"]')?.focus();
    return () => document.removeEventListener('pointerdown', outside);
  }, [open, searchable]);
  const choose = (value: Language) => { setLanguage(value); close(true); };
  return <div className="language-control" ref={root} onBlur={event => { if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) close(); }}>
    <button type="button" className="language-trigger" ref={trigger} aria-label={`${t('language.label')}: ${t(selected.labelKey)}`} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => { if (open) close(); else setOpen(true); }} onKeyDown={event => { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setOpen(true); } }}>
      <Icon name="globe" size={17}/><span>{t(selected.labelKey)}</span><Icon name="chevronDown" size={14}/>
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
      <div role="menu" aria-label={t('language.label')} className="language-options">{matches.map(item => <button key={item.id} type="button" role="menuitemradio" aria-checked={language === item.id} lang={item.id} onClick={() => choose(item.id)}><span>{t(item.labelKey)}</span>{language === item.id && <Icon name="check" size={17}/>}</button>)}</div>
      {!matches.length && <p role="status">{t('language.noResults')}</p>}
    </div>}
  </div>;
}
