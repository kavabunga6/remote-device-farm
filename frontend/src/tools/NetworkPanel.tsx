import { useCallback, useEffect, useRef, useState } from 'react';
import { t } from '../i18n';
import { Icon } from '../icons';
import { useNotifications } from '../notifications';
import { debugApi, downloadDebug, type TrafficState, type TrafficEntry } from './debug-api';
import './DeviceDebug.css';

export function NetworkPanel({ sessionId, active, running, canExport }: { sessionId: string; active: boolean; running: boolean; canExport: boolean }) {
  const [state, setState] = useState<TrafficState | null>(null), [busy, setBusy] = useState(false);
  const [pcap, setPcap] = useState(false), [query, setQuery] = useState(''), [selected, setSelected] = useState<TrafficEntry | null>(null), [error, setError] = useState('');
  const { notifyError } = useNotifications();
  const current = useRef(sessionId), pending = useRef(false), revision = useRef(0), acting = useRef(false);
  useEffect(() => { current.current = sessionId; setState(null); setSelected(null); return () => { current.current = ''; }; }, [sessionId]);
  const refresh = useCallback(async (signal?: AbortSignal) => {
    if (pending.current || acting.current) return; pending.current = true;
    const version = ++revision.current;
    try {
      const next = await debugApi<TrafficState>(sessionId, 'network-inspector', undefined, signal);
      if (current.current === sessionId && !signal?.aborted && revision.current === version) { setState(next); setError(''); }
    } catch (cause) { if (current.current === sessionId && !signal?.aborted) setError(cause instanceof Error ? cause.message : t('networkInspector.failed')); }
    finally { pending.current = false; }
  }, [sessionId]);
  useEffect(() => {
    if (!active || !running) return;
    const abort = new AbortController(); void refresh(abort.signal);
    const timer = window.setInterval(() => { if (!document.hidden) void refresh(abort.signal); }, 2500);
    return () => { abort.abort(); clearInterval(timer); };
  }, [active, running, refresh]);
  const action = async (op: string) => {
    if (busy) return; acting.current = true; revision.current++; setBusy(true);
    try {
      const next = await debugApi<TrafficState>(sessionId, 'network-inspector', { op, ...(op === 'start' ? { pcap } : {}) });
      if (current.current === sessionId) { setState(next); setError(''); if (op === 'clear' || op === 'start') setSelected(null); }
    } catch (cause) { notifyError(t('networkInspector.failed'), cause); }
    finally { acting.current = false; if (current.current === sessionId) setBusy(false); }
  };
  const exportPcap = async () => {
    setBusy(true);
    try {
      const chunks: BlobPart[] = []; let offset = 0, total = -1;
      while (current.current === sessionId) {
        const part = await debugApi<{ contentBase64: string; offset: number; size: number }>(sessionId, 'network-inspector', { op: 'pcap', offset });
        if (part.offset !== offset || part.size > 40 * 1024 * 1024 || (total >= 0 && total !== part.size)) throw new Error(t('networkInspector.exportFailed'));
        total = part.size;
        const bytes = Uint8Array.from(atob(part.contentBase64), c => c.charCodeAt(0));
        if (!bytes.length && offset < total) throw new Error(t('networkInspector.exportFailed'));
        chunks.push(bytes.buffer); offset += bytes.length;
        if (offset === total) { downloadDebug('session-' + sessionId.slice(0, 8) + '.pcap', chunks, 'application/vnd.tcpdump.pcap'); break; }
        if (offset > total) throw new Error(t('networkInspector.exportFailed'));
      }
    } catch (cause) { notifyError(t('networkInspector.exportFailed'), cause); }
    finally { if (current.current === sessionId) setBusy(false); }
  };
  const entries = (state?.entries ?? []).filter(item => (item.url + ' ' + item.method).toLowerCase().includes(query.toLowerCase()));
  return <section className="device-debug-panel" id="tool-panel-traffic" role="tabpanel" aria-labelledby="tool-tab-traffic" hidden={!active}>
    <div className="device-debug-head"><div><h2>{t('networkInspector.title')}</h2><p>{t('networkInspector.description')}</p></div>
      <button className="button" disabled={!running || busy} onClick={() => void refresh()} aria-label={t('debug.refresh')}><Icon name="refresh" size={16}/></button></div>
    <div className="device-debug-state" data-recording={state?.recording === true} role="status">
      {state?.recording || (running && (busy || !state)) ? <span className="mini-spinner"/> : <Icon name="stop" size={16}/>}
      {busy ? t('debug.working') : !state ? t('networkInspector.loading') : state.recording ? t('networkInspector.recording') : t('networkInspector.idle')}
    </div>
    {!running ? <p className="device-debug-hint">{t('debug.stopped')}</p> : state?.available === false ? <p>{t('networkInspector.unavailable')}</p> : <>
      <div className="device-debug-actions">
        <button className="button primary" disabled={!state || busy || state.recording} onClick={() => void action('start')}><Icon name="record" size={16}/>{t('networkInspector.start')}</button>
        <button className="button" disabled={!state || busy || (!state.recording && !state.proxyActive)} onClick={() => void action('stop')}><Icon name="stop" size={16}/>{t('networkInspector.stop')}</button>
        <button className="button" disabled={busy || state?.recording || !state?.entries.length} onClick={() => void action('clear')}><Icon name="trash" size={16}/>{t('networkInspector.clear')}</button>
        {canExport && <a className="button" href={'/api/sessions/' + encodeURIComponent(sessionId) + '/network-inspector/har'} aria-disabled={!state?.entries.length} onClick={event => { if (!state?.entries.length) event.preventDefault(); }}>{t('debug.har')}</a>}
        {canExport && <button className="button" disabled={busy || state?.recording || !state?.pcapBytes} onClick={() => void exportPcap()}>{t('debug.pcap')}</button>}
      </div>
      <label className="device-debug-check"><input type="checkbox" checked={pcap} disabled={busy || state?.recording} onChange={event => setPcap(event.target.checked)}/>{t('networkInspector.pcap')}</label>
      <p className="device-debug-hint">{t('networkInspector.hint')}</p>
      {(pcap || Boolean(state?.pcapBytes)) && <p className="device-debug-hint">{t('networkInspector.pcapWarning')}</p>}
    </>}
    {error && <div className="banner-error" role="alert">{error}</div>}
    <label className="device-debug-field">{t('debug.search')}<input type="search" value={query} onChange={event => setQuery(event.target.value)}/></label>
    {entries.length ? <div className="device-debug-table"><table><thead><tr><th>{t('networkInspector.url')}</th><th>{t('networkInspector.status')}</th><th>{t('networkInspector.time')}</th><th>{t('networkInspector.size')}</th></tr></thead>
      <tbody>{entries.map(item => <tr key={item.id}><td><button className="debug-url" onClick={() => setSelected(item)}>{item.url}<small>{item.method}</small></button></td><td>{item.status ?? '—'}</td><td>{item.durationMs ?? '—'}</td><td>{item.bytes.toLocaleString()}</td></tr>)}</tbody></table></div>
      : <p className="device-debug-hint">{t('networkInspector.empty')}</p>}
    {selected && <div><h3>{t('networkInspector.headers')}</h3><pre className="device-debug-code">{[...selected.requestHeaders, ...selected.responseHeaders].map(h => h.name + ': ' + h.value).join('\n') || t('networkInspector.noHeaders')}</pre></div>}
  </section>;
}
