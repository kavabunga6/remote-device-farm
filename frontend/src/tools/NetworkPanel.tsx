import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { t } from '../i18n';
import { Icon } from '../icons';
import type { TrafficEntry } from './debug-api';
import { filterTraffic, type TrafficFilter } from './traffic-entries';
import { TrafficDetails } from './TrafficDetails';
import { TrafficList } from './TrafficList';
import { useTrafficCapture } from './useTrafficCapture';
import './DeviceDebug.css';
import './NetworkPanel.css';

export function NetworkPanel({ sessionId, active, running, canExport }: { sessionId: string; active: boolean; running: boolean; canExport: boolean }) {
  const { state, busy, error, refresh, action, exportPcap } = useTrafficCapture(sessionId, active, running);
  const [pcap, setPcap] = useState(false), [options, setOptions] = useState(false);
  const [query, setQuery] = useState(''), [filter, setFilter] = useState<TrafficFilter>('all');
  const [mode, setMode] = useState<'sequence' | 'structure'>('sequence');
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [frozen, setFrozen] = useState<TrafficEntry[] | null>(null);
  const [split, setSplit] = useState(48), [wide, setWide] = useState(false);
  const workspace = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  useEffect(() => {
    setSelectedId(null); setFrozen(null); setQuery(''); setFilter('all');
  }, [sessionId]);
  useEffect(() => {
    if (!active || !workspace.current) return;
    const observer = new ResizeObserver(([entry]) => {
      const font = parseFloat(getComputedStyle(workspace.current!).fontSize);
      setWide(entry!.contentRect.width >= 56 * font);
    });
    observer.observe(workspace.current);
    return () => observer.disconnect();
  }, [active]);

  const allEntries = frozen ?? state?.entries ?? [];
  const entries = useMemo(() => filterTraffic(allEntries, query, filter), [allEntries, query, filter]);
  const selected = selectedId === null ? undefined : allEntries.find(entry => entry.id === selectedId);
  const expired = selectedId !== null && !selected;
  const recording = state?.recording === true;
  const canAct = running && state?.available === true && !busy;
  const toggleCapture = async () => {
    const op = recording || state?.proxyActive ? 'stop' : 'start';
    if (await action(op, pcap) && op === 'start') { setFrozen(null); setSelectedId(null); }
  };
  const clear = async () => {
    if (await action('clear')) { setSelectedId(null); setFrozen(null); }
  };
  const resetFilters = () => { setFilter('all'); setQuery(''); };
  const resizeKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const backward = wide ? 'ArrowLeft' : 'ArrowUp', forward = wide ? 'ArrowRight' : 'ArrowDown';
    if (![backward, forward, 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    setSplit(value => event.key === 'Home' ? 25 : event.key === 'End' ? 75 : Math.max(25, Math.min(75, value + (event.key === forward ? 5 : -5))));
  };
  return <section className="device-debug-panel traffic-panel" id="tool-panel-traffic" role="tabpanel" aria-labelledby="tool-tab-traffic" hidden={!active}>
    <h2 className="traffic-sr-only">{t('networkInspector.title')}</h2>
    <div className="traffic-toolbar">
      <div className="traffic-toolbar-group">
        <button type="button" className="traffic-control traffic-record" disabled={!canAct} onClick={() => void toggleCapture()} data-recording={recording}>
          {busy ? <span className="mini-spinner"/> : <Icon name={recording || state?.proxyActive ? 'stop' : 'record'} size={15}/>}
          {t(recording || state?.proxyActive ? 'networkInspector.stop' : 'networkInspector.start')}
        </button>
        <button type="button" className="traffic-control traffic-icon" disabled={!canAct || recording || !state?.entries.length} onClick={() => void clear()}
          aria-label={t('networkInspector.clear')} title={t(recording ? 'networkInspector.stopBeforeClear' : 'networkInspector.clear')}><Icon name="trash" size={15}/></button>
        <button type="button" className="traffic-control traffic-icon" disabled={!running || busy} onClick={() => void refresh()} aria-label={t('debug.refresh')} title={t('debug.refresh')}><Icon name="refresh" size={15}/></button>
      </div>
      <div className="traffic-toolbar-group traffic-exports">
        {canExport && <>
          <a className="traffic-control" href={'/api/sessions/' + encodeURIComponent(sessionId) + '/network-inspector/har'} aria-disabled={!running || busy || !state?.entries.length}
            onClick={event => { if (!running || busy || !state?.entries.length) event.preventDefault(); }} title={t('networkInspector.harHelp')}><Icon name="download" size={15}/>{t('debug.har')}</a>
          <button type="button" className="traffic-control" disabled={!canAct || recording || !state?.pcapBytes} onClick={() => void exportPcap()}
            title={t(recording ? 'networkInspector.stopBeforeExport' : 'networkInspector.pcapDownload')}><Icon name="download" size={15}/>{t('debug.pcap')}</button>
        </>}
        <button type="button" className="traffic-control traffic-icon" onClick={() => setOptions(value => !value)} aria-expanded={options} aria-controls="traffic-options"
          aria-label={t('networkInspector.options')} title={t('networkInspector.options')}><Icon name="info" size={16}/></button>
      </div>
    </div>
    <div className="traffic-options" id="traffic-options" hidden={!options}>
      <label className="device-debug-check"><input type="checkbox" checked={pcap} disabled={busy || recording} onChange={event => setPcap(event.target.checked)}/>{t('networkInspector.pcap')}</label>
      <p>{t('networkInspector.hint')}</p><p>{t('networkInspector.pcapWarning')}</p>
    </div>
    {(!running || state?.available === false || error) && <div className={error ? 'traffic-error' : 'traffic-note'} role={error ? 'alert' : undefined}>
      {error || t(!running ? 'debug.stopped' : 'networkInspector.unavailable')}
    </div>}
    <div className="traffic-filterbar">
      <div className="traffic-modes" role="group" aria-label={t('networkInspector.view')}>
        <button type="button" className="traffic-control" aria-pressed={mode === 'sequence'} onClick={() => setMode('sequence')}><Icon name="list" size={15}/>{t('networkInspector.sequence')}</button>
        <button type="button" className="traffic-control" aria-pressed={mode === 'structure'} onClick={() => setMode('structure')}><Icon name="layers" size={15}/>{t('networkInspector.structure')}</button>
      </div>
      <div className="traffic-search">
        <Icon name="search" size={15}/><input type="search" value={query} onChange={event => setQuery(event.target.value)} aria-label={t('debug.search')} placeholder={t('networkInspector.search')}/>
      </div>
      <select className="traffic-filter" value={filter} onChange={event => setFilter(event.target.value as TrafficFilter)} aria-label={t('networkInspector.filter')}>
        <option value="all">{t('networkInspector.all')}</option><option value="http">{t('networkInspector.httpOnly')}</option>
        <option value="tunnels">{t('networkInspector.tunnelsOnly')}</option><option value="errors">{t('networkInspector.errorsOnly')}</option>
      </select>
      <button type="button" className="traffic-control traffic-icon traffic-freeze" aria-pressed={frozen !== null} disabled={!state}
        onClick={() => setFrozen(value => value === null ? [...state!.entries] : null)} aria-label={t(frozen ? 'networkInspector.resume' : 'networkInspector.freeze')}
        title={t(frozen ? 'networkInspector.resume' : 'networkInspector.freeze')}><Icon name={frozen ? 'play' : 'pause'} size={15}/></button>
    </div>
    <div ref={workspace} className="traffic-workspace" data-wide={wide} style={{ '--traffic-split': split + '%' } as CSSProperties}>
      <div className="traffic-navigation">
        {entries.length ? <TrafficList entries={entries} mode={mode} selectedId={selectedId} onSelect={setSelectedId} searching={Boolean(query.trim()) || filter !== 'all'}/>
          : <div className="traffic-empty"><Icon name="wifi" size={24}/><p>{t(!state && running ? error ? 'networkInspector.readFailed' : 'networkInspector.loading' : allEntries.length ? 'networkInspector.noMatches' : 'networkInspector.empty')}</p>
            {(query || filter !== 'all') && <button type="button" className="traffic-control" onClick={resetFilters}>{t('networkInspector.resetFilters')}</button>}</div>}
      </div>
      <div className="traffic-divider" role="separator" tabIndex={0} aria-orientation={wide ? 'vertical' : 'horizontal'} aria-label={t('networkInspector.resize')}
        aria-valuemin={25} aria-valuemax={75} aria-valuenow={split} aria-valuetext={t('networkInspector.splitValue', { p0: split })}
        onKeyDown={resizeKey} onDoubleClick={() => setSplit(48)}
        onPointerDown={event => { if (event.button !== 0) return; event.preventDefault(); event.currentTarget.focus(); dragging.current = true; event.currentTarget.setPointerCapture(event.pointerId); }}
        onPointerMove={event => {
          if (!dragging.current || !workspace.current) return;
          const rect = workspace.current.getBoundingClientRect();
          const position = wide ? (event.clientX - rect.left) / rect.width : (event.clientY - rect.top) / rect.height;
          setSplit(Math.round(Math.max(25, Math.min(75, position * 100))));
        }}
        onPointerUp={event => { dragging.current = false; if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }}
        onLostPointerCapture={() => { dragging.current = false; }}
        onPointerCancel={() => { dragging.current = false; }}/>
      <TrafficDetails entry={selected} expired={expired}/>
    </div>
    <footer className="traffic-footer">
      <span className="traffic-capture-state" data-recording={recording} role="status">
        {busy || (!state && running && !error) ? <span className="mini-spinner"/> : <Icon name={recording ? 'record' : 'stop'} size={12}/>}
        {t(busy ? 'debug.working' : !running ? 'debug.stopped' : !state ? error ? 'networkInspector.readFailed' : 'networkInspector.loading' : recording ? 'networkInspector.recording' : 'networkInspector.idle')}
      </span>
      <span>{t('networkInspector.shown', { p0: entries.length, p1: allEntries.length })}</span>
      {frozen && <span className="traffic-paused"><Icon name="pause" size={12}/>{t('networkInspector.frozen')}</span>}
      <span className="traffic-limit" title={t('networkInspector.hint')}>{t('networkInspector.retention')}</span>
    </footer>
  </section>;
}
