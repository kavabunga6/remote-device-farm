import { getLanguage, localizeText, t } from './i18n';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { ActivityIndicator } from './ActivityIndicator';
import { api, type LogCursor, type LogEntry, type LogLevel } from './api';
import { logcatAppsApi, type LogcatApp, type LogcatAppState } from './logcat-apps-api';
import './LogcatPanel.css';
import { Icon } from './icons';
import {
  appendEntries, buildMatcher, filterEntries, formatLogLine, highlightParts, LEVEL_ORDER, type LogFilter,
} from './logcat';
import './SessionTools.css';

const LEVELS: Array<{ id: LogLevel; label: string; title: string }> = [
  { id: 'V', get label() { return t('ui.215816bf4210'); }, get title() { return t('ui.c18fa6eb2196'); } },
  { id: 'D', get label() { return t('ui.650078a3fdbf'); }, get title() { return t('ui.8cbef24712a2'); } },
  { id: 'I', get label() { return t('ui.b7fd9a78a434'); }, get title() { return t('ui.81a902c00f90'); } },
  { id: 'W', get label() { return t('ui.299907c3fb21'); }, get title() { return t('ui.08a9aec6a872'); } },
  { id: 'E', get label() { return t('ui.bb095483d8f2'); }, get title() { return t('ui.ac49a274902d'); } },
];
const LEVEL_NAME: Record<LogLevel, string> = { V: 'Verbose', D: 'Debug', I: 'Info', W: 'Warning', E: 'Error', F: 'Fatal' };
const RENDER_LIMIT = 2000;
const POLL_MS = 2000;
const FONT_SIZE_KEY = 'rdf-logcat-font-size';
const MIN_FONT_SIZE = 10, MAX_FONT_SIZE = 20;
function savedFontSize(): number {
  try {
    const saved = Number(localStorage.getItem(FONT_SIZE_KEY));
    if (Number.isInteger(saved) && saved >= MIN_FONT_SIZE && saved <= MAX_FONT_SIZE) return saved;
  } catch { /* Reading logs also works with browser storage disabled. */ }
  return 13;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : t('ui.1d4df994b9e8');
}

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url; link.download = name;
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function LogcatPanel({ sessionId, active, running }: { sessionId: string; active: boolean; running: boolean }) {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [readingEntries, setReadingEntries] = useState<LogEntry[] | null>(null);
  const [fontSize, setFontSize] = useState(savedFontSize);
  const followRef = useRef(true);
  const menuRef = useRef<HTMLDetailsElement>(null);
  const [apps, setApps] = useState<LogcatApp[]>([]);
  const [appsLoading, setAppsLoading] = useState(false);
  const [appsLoaded, setAppsLoaded] = useState(false);
  const [appsError, setAppsError] = useState('');
  const [packageName, setPackageName] = useState('');
  const [appState, setAppState] = useState<LogcatAppState | null>(null);
  const appsRequestRef = useRef(0);
  const [live, setLive] = useState(true);
  const [pageVisible, setPageVisible] = useState(() => document.visibilityState !== 'hidden');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [wrap, setWrap] = useState(true);
  const [follow, setFollow] = useState(true);
  const [copied, setCopied] = useState(false);
  const [filter, setFilter] = useState<LogFilter>({ query: '', regex: false, matchCase: false, minLevel: 'V', tag: null, pid: null });
  const [errorIndex, setErrorIndex] = useState(-1);
  const viewportRef = useRef<HTMLDivElement>(null);
  const cursorRef = useRef<LogCursor | null>(null);
  const busyRef = useRef(false);
  const generationRef = useRef(0);
  const loadedRef = useRef(false);

  useEffect(() => {
    const updateVisibility = () => setPageVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', updateVisibility);
    return () => document.removeEventListener('visibilitychange', updateVisibility);
  }, []);

  useEffect(() => {
    generationRef.current += 1;
    busyRef.current = false;
    loadedRef.current = false;
    cursorRef.current = null;
    setEntries([]); setReadingEntries(null); setAppState(null); setError('');
    setErrorIndex(-1); setFollow(true); followRef.current = true;
    return () => { generationRef.current += 1; busyRef.current = false; };
  }, [sessionId, packageName]);

  const loadApps = useCallback(async () => {
    const request = ++appsRequestRef.current;
    setAppsLoading(true); setAppsError('');
    try {
      const result = await logcatAppsApi.list(sessionId);
      if (request !== appsRequestRef.current) return;
      setApps(result.apps); setAppsLoaded(true);
    } catch (failure) {
      if (request === appsRequestRef.current) setAppsError(errorText(failure));
    } finally {
      if (request === appsRequestRef.current) setAppsLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    setApps([]); setAppsLoaded(false); setAppsError(''); setAppsLoading(false); setPackageName('');
    return () => { appsRequestRef.current += 1; };
  }, [sessionId]);
  useEffect(() => {
    if (active && running && !appsLoaded && !appsLoading && !appsError) void loadApps();
  }, [active, running, appsLoaded, appsLoading, appsError, loadApps]);

  const fetchPage = useCallback(async (initial: boolean) => {
    if (busyRef.current) return;
    busyRef.current = true;
    const generation = generationRef.current;
    if (initial) setLoading(true);
    try {
      const page = await logcatAppsApi.page(sessionId, initial || !cursorRef.current
        ? { lines: 1500 }
        : { since: cursorRef.current.since, skip: cursorRef.current.skip, lines: 2000 }, packageName);
      if (generation !== generationRef.current) return;
      setAppState(page.app ?? null);
      if (page.cursor) cursorRef.current = page.cursor;
      setEntries(previous => initial ? page.entries : appendEntries(previous, page.entries));
      setError('');
      loadedRef.current = true;
    } catch (failure) {
      if (generation === generationRef.current) { setError(errorText(failure)); if (packageName) setAppState(null); }
    } finally {
      if (generation === generationRef.current) {
        busyRef.current = false;
        setLoading(false);
      }
    }
  }, [sessionId, packageName]);

  // Read only the visible logcat. Catch up from the cursor when returning to it.
  useEffect(() => {
    if (!running || !active || !pageVisible) return undefined;
    if (!loadedRef.current) void fetchPage(true);
    if (!live) return undefined;
    const timer = window.setInterval(() => { void fetchPage(false); }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [active, pageVisible, running, live, fetchPage]);


  const matcher = useMemo(() => buildMatcher(filter.query, filter.regex, filter.matchCase), [filter.query, filter.regex, filter.matchCase, getLanguage()]);
  const displayed = readingEntries ?? entries;
  const visible = useMemo(() => filterEntries(displayed, filter, matcher), [displayed, filter, matcher, getLanguage()]);
  const shown = useMemo(() => visible.length > RENDER_LIMIT ? visible.slice(-RENDER_LIMIT) : visible, [visible, getLanguage()]);
  const errorRows = useMemo(() => shown.reduce<number[]>((list, entry, index) => {
    if (LEVEL_ORDER[entry.level] >= LEVEL_ORDER.E) list.push(index);
    return list;
  }, []), [shown, getLanguage()]);

  // Pin the displayed buffer while reading: new batches and buffer trimming must
  // not replace the user's line or text selection. Polling continues in the background.
  const readHistory = () => {
    followRef.current = false;
    setFollow(false);
    setReadingEntries(previous => previous ?? entries);
  };
  const followLatest = () => {
    followRef.current = true;
    setFollow(true);
    setReadingEntries(null);
    setErrorIndex(-1);
  };
  useLayoutEffect(() => {
    if (!followRef.current || !active) return;
    const viewport = viewportRef.current;
    if (viewport) viewport.scrollTop = viewport.scrollHeight;
  }, [shown, follow, active, fontSize, wrap]);

  const onScroll = () => {
    const viewport = viewportRef.current;
    if (viewport && followRef.current && viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight > 24) readHistory();
  };
  const toggleLive = () => {
    if (live) { readHistory(); setLive(false); }
    else { followLatest(); setLive(true); void fetchPage(false); }
  };
  useEffect(() => {
    try { localStorage.setItem(FONT_SIZE_KEY, String(fontSize)); } catch { /* Optional preference. */ }
  }, [fontSize]);
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) menuRef.current.open = false;
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, []);
  const menuAction = (action: () => void) => { if (menuRef.current) { menuRef.current.open = false; menuRef.current.querySelector('summary')?.focus(); } action(); };

  const jumpToError = (direction: 1 | -1) => {
    if (!errorRows.length) return;
    const current = errorIndex < 0 || errorIndex >= errorRows.length ? (direction === 1 ? -1 : errorRows.length) : errorIndex;
    const next = (current + direction + errorRows.length) % errorRows.length;
    setErrorIndex(next); readHistory();
    const viewport = viewportRef.current;
    const row = viewport?.querySelector(`[data-row="${errorRows[next]}"]`);
    if (viewport && row) viewport.scrollTop += row.getBoundingClientRect().top - viewport.getBoundingClientRect().top - viewport.clientHeight / 2 + row.getBoundingClientRect().height / 2;
  };

  const clear = async () => {
    try { await api.clearLogcat(sessionId); setError(''); }
    catch (failure) { setError(errorText(failure)); return; }
    generationRef.current += 1;
    busyRef.current = false;
    setLoading(false);
    setEntries([]); setReadingEntries(null); setErrorIndex(-1); setFollow(true); followRef.current = true;
    cursorRef.current = null;
  };

  const copy = async () => {
    try { await navigator.clipboard.writeText(visible.map(formatLogLine).join('\n')); setCopied(true); window.setTimeout(() => setCopied(false), 1400); }
    catch { setError(t('ui.e0c3c40626f4')); }
  };

  const update = (patch: Partial<LogFilter>) => setFilter(previous => ({ ...previous, ...patch }));
  const selectApp = (name: string) => { setPackageName(name); update({ pid: null, tag: null }); };
  const hasFilter = packageName !== '' || filter.query !== '' || filter.minLevel !== 'V' || filter.tag !== null || filter.pid !== null;

  return <div className="log-panel" hidden={!active} style={{ '--log-font-size': fontSize + 'px' } as CSSProperties}>
    <div className="log-head">
      <h2 className="log-sr-only">{t('ui.8e309dfb82e0')}</h2>
      <button type="button" className={'log-control log-live' + (live ? ' on' : '')} onClick={toggleLive} disabled={!running}
        title={live ? t('ui.9770c63bcf89') : t('ui.bc49b4d1e835')} aria-pressed={!live}>
        <Icon name={live ? 'pause' : 'play'} size={15} />{live ? t('ui.65530fd463ea') : t('ui.a42aee58d60a')}
      </button>
      <div className="log-font-controls" role="group" aria-label={t('ui.780e6aee2cbc')}>
        <button type="button" className="log-control" onClick={() => setFontSize(value => Math.max(MIN_FONT_SIZE, value - 1))} disabled={fontSize === MIN_FONT_SIZE} aria-label={t('ui.583001c59536')} title={t('ui.2ce211762cc4')}><Icon name="minus" size={15}/></button>
        <output aria-label={t('ui.9f9d637d4607')}>{fontSize} {t('ui.bc913fd04325')}</output>
        <button type="button" className="log-control" onClick={() => setFontSize(value => Math.min(MAX_FONT_SIZE, value + 1))} disabled={fontSize === MAX_FONT_SIZE} aria-label={t('ui.587fd05a12fc')} title={t('ui.d58d963c745d')}><Icon name="plus" size={15}/></button>
      </div>
      <details className="log-menu" ref={menuRef} onKeyDown={event => { if (event.key === 'Escape' && menuRef.current) { menuRef.current.open = false; menuRef.current.querySelector('summary')?.focus(); } }}>
        <summary className="log-control" aria-label={t('ui.092101b7ebad')} title={t('ui.092101b7ebad')}><Icon name="more" size={17}/></summary>
        <div className="log-menu-actions">
          <button type="button" className="log-menu-error" onClick={() => menuAction(() => jumpToError(-1))} disabled={!errorRows.length}><Icon name="arrowUp" size={15}/>{t('ui.fd595a810f23')}</button>
          <button type="button" className="log-menu-error" onClick={() => menuAction(() => jumpToError(1))} disabled={!errorRows.length}><Icon name="arrowDown" size={15}/>{t('ui.82dd8e4ac792')}</button>
          <button type="button" onClick={() => menuAction(() => { followLatest(); void fetchPage(true); })} disabled={loading || !running}><Icon name="refresh" size={15}/>{t('ui.9449575c0465')}</button>
          <button type="button" onClick={() => void copy()} disabled={!visible.length}><Icon name={copied ? 'check' : 'copy'} size={15}/>{copied ? t('ui.d2d08c715ee6') : t('ui.296257e3983b')}</button>
          <button type="button" onClick={() => menuAction(() => download('logcat-' + sessionId.slice(0, 8) + '.log', visible.map(formatLogLine).join('\n') + '\n'))} disabled={!visible.length}><Icon name="download" size={15}/>{t('ui.c4e961bed0c1')}</button>
          <button type="button" className="log-menu-clear" onClick={() => menuAction(() => { void clear(); })} disabled={!running}><Icon name="trash" size={15}/>{t('ui.fafd0c22168c')}</button>
        </div>
      </details>
    </div>

    <div className="log-filters">
      <div className="log-filter-field">
        <label htmlFor={'log-app-' + sessionId}>{t('ui.26b855cc1660')}</label>
        <div className="log-app-select-row">
          <select id={'log-app-' + sessionId} value={packageName} onChange={event => selectApp(event.target.value)} disabled={!running || appsLoading}>
            <option value="">{t('ui.e350d91f01f5')}</option>
            {packageName && !apps.some(app => app.packageName === packageName) && <option value={packageName}>{packageName}</option>}
            {apps.map(app => <option key={app.packageName} value={app.packageName}>{app.packageName}</option>)}
          </select>
          <button type="button" className="log-control" onClick={() => void loadApps()} disabled={!running || appsLoading} aria-label={t('ui.f0d9ec6e63a3')} title={t('ui.f0d9ec6e63a3')}>{appsLoading ? <ActivityIndicator/> : <Icon name="refresh" size={15}/>}</button>
        </div>
      </div>
      <div className="log-filter-field">
        <label htmlFor={'log-level-' + sessionId}>{t('ui.7f67af3d6cd9')}</label>
        <select id={'log-level-' + sessionId} value={filter.minLevel} onChange={event => update({ minLevel: event.target.value as LogLevel })}>
          {LEVELS.map(level => <option key={level.id} value={level.id} title={level.title}>{level.label}</option>)}
        </select>
      </div>
    </div>
    {(packageName || appsLoaded && !apps.length) && <div className="log-app-state" role="status">
      {packageName ? appState ? appState.pids === null ? t('ui.babf43590699') : appState.pids.length ? t('ui.f526c143f270') + appState.pids.join(', ') : t('ui.34a80cfcf8a0')
        : loading ? t('ui.0d82c5634e29') : '' : t('ui.1d5198ef06be')}
    </div>}
    {appState && appState.sharedPackages.length > 0 && <p className="log-app-warning">{t('ui.22b0d9039e0f')}{appState.sharedPackages.join(', ')}.</p>}
    {appsError && <div className="log-error" role="alert">{t('ui.9270a3e71538')}{localizeText(appsError)} <button type="button" onClick={() => void loadApps()}>{t('ui.5189135a6110')}</button></div>}

    <div className="log-search">
      <div className={'log-search-field' + (matcher.error ? ' invalid' : '')}>
        <Icon name="search" size={16} />
        <input value={filter.query} onChange={event => update({ query: event.target.value })} placeholder={filter.regex ? t('ui.d2ad22823bac') : t('ui.9c51b14d60cb')} aria-label={t('ui.1d2cb1eecd90')} spellCheck={false} />
        {filter.query && <button type="button" className="log-clear-input" onClick={() => update({ query: '' })} aria-label={t('ui.6e1f7baa472f')}><Icon name="close" size={14} /></button>}
        <button type="button" className={'log-toggle mono' + (filter.matchCase ? ' on' : '')} onClick={() => update({ matchCase: !filter.matchCase })} title={t('ui.e16976aeee37')} aria-label={t('ui.e16976aeee37')} aria-pressed={filter.matchCase}>{t('ui.81acaafba961')}</button>
        <button type="button" className={'log-toggle mono' + (filter.regex ? ' on' : '')} onClick={() => update({ regex: !filter.regex })} title={t('ui.72ed3ab98243')} aria-label={t('ui.72ed3ab98243')} aria-pressed={filter.regex}>.*</button>
      </div>
      {matcher.error && <div className="log-regex-error" role="alert">{matcher.error}</div>}
      <div className="log-read-controls" role="group" aria-label={t('ui.694b865d27a5')}>
        <button type="button" className="log-control" onClick={() => jumpToError(-1)} disabled={!errorRows.length} aria-label={t('ui.fd595a810f23')} title={t('ui.fd595a810f23')}><Icon name="arrowUp" size={14}/></button>
        <button type="button" className="log-control" onClick={() => jumpToError(1)} disabled={!errorRows.length} aria-label={t('ui.82dd8e4ac792')} title={t('ui.82dd8e4ac792')}><Icon name="arrowDown" size={14}/></button>
        <button type="button" className={'log-control' + (wrap ? ' on' : '')} onClick={() => setWrap(value => !value)} aria-pressed={wrap} title={t('ui.d775dff1fb8f')}>{t('ui.04120307c467')}</button>
      </div>
      {hasFilter && <div className="log-chips">
        {filter.tag !== null && <button type="button" className="log-chip" onClick={() => update({ tag: null })}>{t('ui.8f3be0181bfd')}{filter.tag}<Icon name="close" size={13} /></button>}
        {filter.pid !== null && <button type="button" className="log-chip" onClick={() => update({ pid: null })}>{t('ui.606f2113571d')}{filter.pid}<Icon name="close" size={13} /></button>}
        <button type="button" className="log-chip" onClick={() => { selectApp(''); update({ query: '', minLevel: 'V', tag: null, pid: null }); }}>{t('ui.cd45ec7836b5')}</button>
      </div>}
    </div>

    <div className={'log-viewport' + (wrap ? ' wrap' : '')} ref={viewportRef} onScroll={onScroll} onWheel={event => { if (event.deltaY < 0) readHistory(); }}
      onPointerDown={event => { if (event.button === 0 && (event.target as Element).closest('.log-message,.log-time')) readHistory(); }}
      onKeyDown={event => { if (['ArrowUp', 'PageUp', 'Home'].includes(event.key)) readHistory(); }}
      tabIndex={0} role="log" aria-live="off" aria-label={t('ui.c976d7796f82')}>
      {!running ? <div className="log-empty">{t('ui.18f498ca4630')}</div>
        : loading && !entries.length ? <div className="log-empty">{t('ui.34eda6823874')}</div>
          : !shown.length ? <div className="log-empty">{entries.length ? t('ui.fd025a57518e') : t('ui.2ce1f37d53a8')}</div>
            : <>
              {visible.length > shown.length && <div className="log-trim">{t('ui.e7bde075273a')}</div>}
              {shown.map((entry, index) => <div key={entry.ts + ':' + index + ':' + entry.tid} data-row={index} className={'log-row level-' + entry.level + (errorRows[errorIndex] === index ? ' current' : '')}>
                <span className="log-time">{entry.ts.slice(6)}</span>
                <span className="log-level-badge" title={LEVEL_NAME[entry.level]}>{entry.level}</span>
                <button type="button" className="log-tag" onClick={() => update({ tag: entry.tag })} title={t('ui.7e21f7dc136d')}>{highlightParts(entry.tag, matcher.pattern).map((part, partIndex) => part.hit ? <mark key={partIndex}>{part.text}</mark> : part.text)}</button>
                <button type="button" className="log-pid" onClick={() => update({ pid: entry.pid })} title={t('ui.2f283a3c6ed1', { p0: entry.pid })}>{entry.pid}</button>
                <span className="log-message">{highlightParts(entry.message, matcher.pattern).map((part, partIndex) => part.hit ? <mark key={partIndex}>{part.text}</mark> : part.text)}</span>
              </div>)}
            </>}
    </div>
    <div className="log-reader-bar">
      <span role="status">{!running ? t('ui.000019a95793') : !live ? t('ui.36d2f35d0ef7') : follow ? t('ui.893fdfe48b5c') : t('ui.c41895695c7c')}</span>
      <button type="button" className="log-control log-follow" disabled={follow || !shown.length} onClick={followLatest}><Icon name="arrowDown" size={14}/>{t('ui.69428933e3e9')}</button>
    </div>
    {error && <div className="log-error" role="alert"><Icon name="alert" size={15}/>{localizeText(error)}</div>}
  </div>;
}
