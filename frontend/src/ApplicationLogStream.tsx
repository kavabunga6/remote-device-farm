import { getLanguage, getLocale, localizeText, t } from './i18n';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from './icons';
import './ApplicationLogStream.css';

type Entry = { id: string; occurredAt: string; level: 'debug' | 'info' | 'warning' | 'error'; source?: 'server' | 'agent' | 'emulator'; message: string };
const CAPACITY = 2000;
const levelLabel = { debug: 'DEBUG', info: 'INFO', warning: 'WARN', error: 'ERROR' };
const textLine = (entry: Entry) => `${entry.occurredAt} ${levelLabel[entry.level]} [${entry.source ?? 'server'}] ${entry.message}`;

export function ApplicationLogStream() {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [pausedEntries, setPausedEntries] = useState<Entry[] | null>(null);
  const [connection, setConnection] = useState<'connecting' | 'live' | 'retrying' | 'denied'>('connecting');
  const [notice, setNotice] = useState('');
  const [copyState, setCopyState] = useState('');
  const [search, setSearch] = useState('');
  const [level, setLevel] = useState('');
  const [following, setFollowing] = useState(true);
  const viewport = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const source = new EventSource('/api/admin/application-log/stream', { withCredentials: true });
    let pending: Entry[] = [];
    let frame: number | undefined;
    const flush = () => {
      frame = undefined;
      const batch = pending; pending = [];
      setEntries(previous => {
        const seen = new Set(previous.map(entry => entry.id));
        return [...previous, ...batch.filter(entry => !seen.has(entry.id) && seen.add(entry.id))].slice(-CAPACITY);
      });
    };
    source.addEventListener('ready', event => {
      setConnection('live');
      const data = JSON.parse((event as MessageEvent).data) as { reset: boolean; gap: boolean };
      if (data.reset) { pending = []; setEntries([]); setPausedEntries(null); setNotice(t('ui.df2f4b6605a4')); }
      else if (data.gap) setNotice(t('ui.906de6ef1a0c'));
    });
    source.addEventListener('entry', event => {
      const entry = JSON.parse((event as MessageEvent).data) as Entry;
      pending.push(entry);
      if (pending.length > CAPACITY) pending = pending.slice(-CAPACITY);
      if (frame === undefined) frame = requestAnimationFrame(flush);
    });
    source.addEventListener('unauthorized', () => { source.close(); setConnection('denied'); });
    source.onerror = () => setConnection(source.readyState === EventSource.CLOSED ? 'denied' : 'retrying');
    return () => { source.close(); if (frame !== undefined) cancelAnimationFrame(frame); };
  }, []);
  const paused = pausedEntries !== null;
  const displayed = pausedEntries ?? entries;
  const visible = useMemo(() => displayed.filter(entry => (!level || entry.level === level) &&
    (!search || textLine(entry).toLocaleLowerCase().includes(search.toLocaleLowerCase()))), [displayed, level, search, getLanguage()]);
  const pausedTail = pausedEntries?.at(-1)?.id;
  const unread = paused ? entries.length - (pausedTail ? entries.findIndex(entry => entry.id === pausedTail) + 1 : 0) : 0;
  useEffect(() => {
    if (!paused && following && viewport.current) viewport.current.scrollTop = viewport.current.scrollHeight;
  }, [visible, paused, following]);
  const copy = async () => {
    try { await navigator.clipboard.writeText(visible.map(textLine).join('\n')); setCopyState(t('ui.75af2edc9ce5')); }
    catch { setCopyState(t('ui.8110d1821f6f')); }
  };
  const download = () => {
    const url = URL.createObjectURL(new Blob([visible.map(textLine).join('\n') + '\n'], { type: 'text/plain;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url; link.download = 'remote-device-farm-' + new Date().toISOString().replace(/[:.]/g, '-') + '.log'; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return <section className="application-log" aria-label={t('ui.400d4bb34893')}>
    <div className="application-log-intro"><div><h3>{t('ui.400d4bb34893')}</h3><p>{t('ui.9dc322c63fa2')}{CAPACITY.toLocaleString(getLocale())} {t('ui.f105b20e3c88')}</p></div>
      <span className={'application-log-connection is-' + connection} role="status"><span aria-hidden="true" />{connection === 'live' ? t('ui.128f434e8bf8') : connection === 'connecting' ? t('ui.752829a478a6') : connection === 'denied' ? t('ui.5f124a9d0609') : t('ui.275cb49eede9')}</span>
    </div>
    <div className="application-log-toolbar">
      <div className="application-log-filters">
        <div className="application-log-field"><label htmlFor="application-log-search">{t('ui.295dffaa0ab3')}</label><input id="application-log-search" type="search" placeholder={t('ui.0dd731e54a41')} value={search} onChange={event => setSearch(event.target.value)} /></div>
        <div className="application-log-field"><label htmlFor="application-log-level">{t('ui.7f67af3d6cd9')}</label><select id="application-log-level" value={level} onChange={event => setLevel(event.target.value)}><option value="">{t('ui.56894a445022')}</option><option value="debug">{t('ui.1a03bd2fd107')}</option><option value="info">{t('ui.3319b9b01f2a')}</option><option value="warning">{t('ui.d6155fcb9bcd')}</option><option value="error">{t('ui.bb095483d8f2')}</option></select></div>
      </div>
      <div className="application-log-actions">
        <button type="button" className="button outline" aria-pressed={paused} onClick={() => { setPausedEntries(paused ? null : entries); setFollowing(true); }}><Icon name={paused ? 'play' : 'pause'} size={16} />{paused ? t('ui.a42aee58d60a') : t('ui.65530fd463ea')}</button>
        <button type="button" className="button outline" disabled={!visible.length} onClick={() => void copy()}><Icon name="copy" size={16} />{t('ui.1ecddf40bfeb')}</button>
        <button type="button" className="button outline" disabled={!visible.length} onClick={download}><Icon name="download" size={16} />{t('ui.535119bf3cc5')}</button>
      </div>
    </div>
    {notice && <p className="application-log-notice" role="status">{localizeText(notice)}</p>}
    {connection === 'denied' && <p className="inline-error" role="alert">{t('ui.a83baaee52fa')}</p>}
    <div className="application-log-viewport" ref={viewport} tabIndex={0} aria-label={t('ui.5671ebbc0b5a')} onScroll={event => {
      const box = event.currentTarget;
      setFollowing(box.scrollHeight - box.scrollTop - box.clientHeight < 32);
    }}>
      {visible.length ? <pre>{visible.map(entry => <span className={'application-log-line is-' + entry.level} key={entry.id}><span className="application-log-time">{entry.occurredAt}</span>{' '}<span className="application-log-level">{levelLabel[entry.level].padEnd(5)}</span>{' [' + (entry.source ?? 'server') + '] '}{entry.message}{'\n'}</span>)}</pre> :
        <p className="application-log-empty">{connection === 'connecting' ? t('ui.48e8674821e6') : entries.length ? t('ui.cf85a43c3b76') : t('ui.c8ba28053344')}</p>}
    </div>
    <div className="application-log-footer">
      <span>{t('ui.5ac780ba11a5')}{visible.length.toLocaleString(getLocale())}{paused && t('ui.1f7cd169c3de') + (unread ? t('ui.f8a40f8ec8e7') + unread : '')}</span>
      <span role="status">{localizeText(copyState)}</span>
      <button className="text-button" type="button" disabled={!visible.length || following} onClick={() => { setFollowing(true); if (viewport.current) viewport.current.scrollTop = viewport.current.scrollHeight; }}><Icon name="arrowDown" size={16} />{t('ui.33da185d65d6')}</button>
    </div>
  </section>;
}
