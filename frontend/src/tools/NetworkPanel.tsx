import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { t } from '../i18n';
import { Icon } from '../icons';
import { trafficHar } from '../../../shared/traffic-har.mjs';
import { downloadDebug, type TrafficEntry, type TrafficState } from './debug-api';
import { filterTraffic, type TrafficFilter } from './traffic-entries';
import { TrafficDetails, trafficSize } from './TrafficDetails';
import { TrafficList } from './TrafficList';
import { TrafficPopover } from './TrafficPopover';
import { useTrafficCapture } from './useTrafficCapture';
import './DeviceDebug.css';
import './NetworkPanel.css';

const stopKeys = { manual: 'networkInspector.stoppedManual', time_limit: 'networkInspector.stoppedTime', size_limit: 'networkInspector.stoppedSize',
  recovery: 'networkInspector.stoppedRecovery', start_failed: 'networkInspector.stoppedFailed' } as const;
const pcapKeys = { none: 'networkInspector.pcapOff', starting: 'networkInspector.pcapStarting', recording: 'networkInspector.pcapRecording',
  finalizing: 'networkInspector.pcapFinalizing', stopped: 'networkInspector.pcapReady', error: 'networkInspector.pcapFailed' } as const;

export function NetworkPanel({ sessionId, active, running, canExport, onExpand }: {
  sessionId: string; active: boolean; running: boolean; canExport: boolean; onExpand?: () => void;
}) {
  const { state, busy, error, refresh, action, exportPcap } = useTrafficCapture(sessionId, active, running);
  const [pcap, setPcap] = useState(false), [bodies, setBodies] = useState(false), [popover, setPopover] = useState<'settings' | 'export' | null>(null);
  const [query, setQuery] = useState(''), [filter, setFilter] = useState<TrafficFilter>('all');
  const [mode, setMode] = useState<'sequence' | 'structure'>('structure');
  const [selected, setSelected] = useState<TrafficEntry | undefined>();
  const [orderedIds, setOrderedIds] = useState<number[]>([]);
  const updateOrder = useCallback((ids: number[]) => setOrderedIds(previous => previous.length === ids.length && previous.every((id, index) => id === ids[index]) ? previous : ids), []);
  const [frozen, setFrozen] = useState<TrafficState | null>(null);
  const [split, setSplit] = useState(58), [wide, setWide] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const [now, setNow] = useState(Date.now);
  const workspace = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  useEffect(() => {
    setSelected(undefined); setOrderedIds([]); setFrozen(null); setQuery(''); setFilter('all'); setPcap(false); setBodies(false); setDetailOpen(false); setPopover(null); setMode('structure');
  }, [sessionId]);
  useEffect(() => {
    if (!state?.captureId) return;
    setPcap(Boolean(state.pcapRequested)); setBodies(Boolean(state.captureBodies));
  }, [state?.captureId]);
  useEffect(() => {
    if (!active || !state?.recording) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active, state?.recording]);
  useEffect(() => {
    if (!active || !workspace.current) return;
    const observer = new ResizeObserver(([entry]) => {
      const font = parseFloat(getComputedStyle(workspace.current!).fontSize);
      setWide(entry!.contentRect.width >= Math.max(900, 68 * font));
    });
    observer.observe(workspace.current);
    return () => observer.disconnect();
  }, [active]);

  const view = frozen ?? state;
  const allEntries = view?.entries ?? [];
  const entries = useMemo(() => filterTraffic(allEntries, query, filter), [allEntries, query, filter]);
  const latestSelected = selected && allEntries.find(entry => entry.id === selected.id && entry.captureId === selected.captureId);
  const shownSelected = latestSelected || selected;
  useEffect(() => {
    if (!wide && detailOpen) workspace.current?.querySelector<HTMLButtonElement>('.traffic-back')?.focus({ preventScroll: true });
  }, [wide, detailOpen]);
  useEffect(() => { if (latestSelected && latestSelected !== selected) setSelected(latestSelected); }, [latestSelected, selected]);
  const detached = Boolean(selected && !latestSelected);
  const selectedFiltered = Boolean(shownSelected && !detached && !entries.some(entry => entry.id === shownSelected.id));
  const recording = state?.recording === true;
  const finalizing = state?.finalizing === true;
  const stopNeeded = recording || state?.proxyActive || state?.pcapState === 'error';
  const canAct = running && state?.available === true && !busy && !finalizing;
  const sameCapture = !frozen || state?.captureId === frozen.captureId;
  const added = frozen && sameCapture ? Math.max(0, (state?.totalCaptured ?? state?.entries.length ?? 0) - (frozen.totalCaptured ?? frozen.entries.length)) : 0;
  const showOptions = () => setPopover('settings');
  useEffect(() => { if (!active) setPopover(null); }, [active]);
  const selectEntry = (id: number) => { setSelected(allEntries.find(entry => entry.id === id)); setDetailOpen(true); };
  const backToList = () => {
    setDetailOpen(false);
    requestAnimationFrame(() => listRef.current?.querySelector<HTMLButtonElement>('[aria-pressed=true]')?.focus({ preventScroll: true }));
  };
  const toggleCapture = async () => {
    const op = stopNeeded ? 'stop' : 'start';
    if (await action(op, pcap, bodies) && op === 'start') { setFrozen(null); setSelected(undefined); setDetailOpen(false); }
  };
  const clear = async () => {
    if (await action('clear')) { setSelected(undefined); setFrozen(null); setDetailOpen(false); }
  };
  const exportRows = (rows: TrafficEntry[], single = false) => {
    const data = trafficHar({ ...(view ?? {}), entries: rows }, {
      tunnel: t('networkInspector.harTunnelNote'), unmeasured: t('networkInspector.harUnmeasured'),
    });
    downloadDebug('traffic-' + (single ? 'request-' + rows[0]!.id : 'visible') + '-' + sessionId.slice(0, 8) + '.har', [JSON.stringify(data, null, 2)], 'application/json');
  };
  const resetFilters = () => { setFilter('all'); setQuery(''); setDetailOpen(false); };
  const currentPosition = shownSelected ? orderedIds.indexOf(shownSelected.id) : -1;
  const previousId = currentPosition > 0 ? orderedIds[currentPosition - 1] : undefined;
  const nextId = currentPosition >= 0 ? orderedIds[currentPosition + 1] : undefined;
  const resizeKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const backward = wide ? 'ArrowLeft' : 'ArrowUp', forward = wide ? 'ArrowRight' : 'ArrowDown';
    if (![backward, forward, 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    setSplit(value => event.key === 'Home' ? 25 : event.key === 'End' ? 75 : Math.max(25, Math.min(75, value + (event.key === forward ? 5 : -5))));
  };
  const elapsed = state?.startedAt ? Math.max(0, Math.floor(((recording ? now / 1000 : state.stoppedAt ?? now / 1000) - state.startedAt))) : 0;
  const clock = String(Math.floor(elapsed / 60)).padStart(2, '0') + ':' + String(elapsed % 60).padStart(2, '0');
  const emptyKey = !state && running ? error ? 'networkInspector.readFailed' : 'networkInspector.loading'
    : allEntries.length ? 'networkInspector.noMatches' : recording ? 'networkInspector.emptyRecording' : 'networkInspector.emptyIdle';
  const stateKey = busy ? 'debug.working' : !running ? 'debug.stopped' : !state ? error ? 'networkInspector.readFailed' : 'networkInspector.loading'
    : finalizing ? 'networkInspector.pcapFinalizing' : recording && state.proxyActive === false ? 'networkInspector.proxyDisconnected'
    : recording ? 'networkInspector.recording' : state.stopReason ? stopKeys[state.stopReason] : 'networkInspector.idle';
  return <section className="device-debug-panel traffic-panel" id="tool-panel-traffic" role="tabpanel" aria-labelledby="tool-tab-traffic" hidden={!active}>
    <h2 className="traffic-sr-only">{t('networkInspector.title')}</h2>
    <div className="traffic-toolbar">
      <button type="button" className="traffic-control traffic-record" disabled={!canAct} onClick={() => void toggleCapture()} data-recording={recording}
        aria-label={t(recording ? 'networkInspector.stop' : state?.pcapState === 'error' ? 'networkInspector.retryStop' : state?.proxyActive ? 'networkInspector.disconnectProxy' : 'networkInspector.start')}
        title={t(stopNeeded ? 'networkInspector.stop' : 'networkInspector.start')}>
        {busy ? <span className="mini-spinner"/> : <Icon name={stopNeeded ? 'stop' : 'record'} size={15}/>}
        <span>{t(stopNeeded ? 'networkInspector.stopShort' : 'networkInspector.recordShort')}</span>
      </button>
      <span className="traffic-capture-state" data-recording={recording} role="status" title={t(stateKey)}>
        {finalizing && <span className="mini-spinner"/>}<span>{t(stateKey)}</span>{state?.startedAt && <time>{clock}</time>}
      </span>
      <div className="traffic-toolbar-group traffic-toolbar-utilities">
        <button type="button" className="traffic-control traffic-icon traffic-freeze" aria-pressed={frozen !== null} disabled={!state}
          onClick={() => setFrozen(value => value === null ? state : null)} aria-label={t(frozen ? 'networkInspector.resume' : 'networkInspector.freeze')}
          title={t(frozen ? 'networkInspector.resume' : 'networkInspector.freeze')}><Icon name={frozen ? 'play' : 'pause'} size={15}/></button>
        <button type="button" className="traffic-control traffic-icon" disabled={!canAct || recording || !state?.entries.length} onClick={() => void clear()}
          aria-label={t('networkInspector.clear')} title={t(recording ? 'networkInspector.stopBeforeClear' : 'networkInspector.clear')}><Icon name="trash" size={15}/></button>
        <button type="button" className="traffic-control traffic-icon" disabled={!running || busy} onClick={() => void refresh()} aria-label={t('debug.refresh')} title={t('debug.refresh')}><Icon name="refresh" size={15}/></button>
      </div>
      <div className="traffic-toolbar-group traffic-toolbar-actions">
        {canExport && <TrafficPopover label={t('networkInspector.exportMenu')} icon="download" open={popover === 'export'} onOpenChange={open => setPopover(current => open ? 'export' : current === 'export' ? null : current)}>
          <button type="button" className="traffic-menu-item" disabled={busy || !entries.length} data-autofocus onClick={() => { exportRows(entries); setPopover(null); }}>
            <Icon name="download" size={17}/><span><strong>{t('networkInspector.harShown')}</strong><small>{t('networkInspector.harMenuHelp')}</small></span>
          </button>
          <button type="button" className="traffic-menu-item" disabled={!canAct || recording || !state?.pcapBytes || state.pcapState === 'error'}
            onClick={() => { setPopover(null); void exportPcap(); }}>
            <Icon name="download" size={17}/><span><strong>{t('debug.pcap')}</strong><small>{t(recording ? 'networkInspector.stopBeforeExport' : !state?.pcapBytes ? 'networkInspector.enablePcap' : 'networkInspector.pcapDownload')}</small></span>
          </button>
        </TrafficPopover>}
        <TrafficPopover label={t('networkInspector.optionsShort')} icon="sliders" open={popover === 'settings'} onOpenChange={open => setPopover(current => open ? 'settings' : current === 'settings' ? null : current)}>
          {(recording || finalizing) && <p className="traffic-settings-hint" role="status">{t(recording ? 'networkInspector.settingsLocked' : 'networkInspector.settingsFinalizing')}</p>}
          <label className="traffic-setting"><input type="checkbox" checked={pcap} disabled={!canAct || recording} onChange={event => setPcap(event.target.checked)} data-autofocus/>
            <span><strong>{t('networkInspector.pcap')}</strong><small>{t('networkInspector.pcapWarningShort')}</small></span></label>
          <label className="traffic-setting"><input type="checkbox" checked={bodies} disabled={!canAct || recording} onChange={event => setBodies(event.target.checked)}/>
            <span><strong>{t('networkInspector.captureBodies')}</strong><small>{t('networkInspector.bodyWarning')}</small></span></label>
          <div className="traffic-capture-info"><p>{t('networkInspector.visibleScope')}</p><p>{t('networkInspector.hint')}</p>
            <span>{t('networkInspector.bufferLimit', { p0: state?.limit ?? 200 })}</span>
            {state?.activeConnections != null && <span>{t('networkInspector.connections', { p0: state.activeConnections, p1: state.connectionLimit ?? 64 })}</span>}
          </div>
        </TrafficPopover>
        {onExpand && <button type="button" className="traffic-control traffic-icon traffic-expand" onClick={onExpand} aria-label={t('networkInspector.expand')} title={t('networkInspector.expand')}><Icon name="expand" size={16}/></button>}
      </div>
    </div>
    {(!running || state?.available === false || error) && <div className={error ? 'traffic-error' : 'traffic-note'} role={error ? 'alert' : undefined}>
      {error || t(!running ? 'debug.stopped' : 'networkInspector.unavailable')}
    </div>}
    {state?.available && state.protocolVersion !== 2 && <p className="traffic-note">{t('networkInspector.restartRequired')}</p>}
    {recording && state?.proxyActive === false && <p className="traffic-note traffic-warning" role="status">{t('networkInspector.proxyDisconnectedHelp')}</p>}
    {Boolean(state?.rejectedConnections) && <p className="traffic-note traffic-warning" role="status">{t('networkInspector.overloaded', { p0: state!.rejectedConnections })}</p>}
    {state?.pcapState === 'error' && <p className="traffic-note traffic-warning" role="status">{t('networkInspector.pcapStopHelp')}</p>}
    <div className="traffic-filterbar">
      <div className="traffic-modes" role="group" aria-label={t('networkInspector.view')}>
        <button type="button" className="traffic-control" aria-pressed={mode === 'structure'} aria-label={t('networkInspector.structure')} onClick={() => { setMode('structure'); setDetailOpen(false); }}><Icon name="layers" size={15}/><span>{t('networkInspector.structure')}</span></button>
        <button type="button" className="traffic-control" aria-pressed={mode === 'sequence'} aria-label={t('networkInspector.sequence')} onClick={() => { setMode('sequence'); setDetailOpen(false); }}><Icon name="list" size={15}/><span>{t('networkInspector.sequence')}</span></button>
      </div>
      <div className="traffic-search">
        <Icon name="search" size={15}/><input type="search" value={query} onChange={event => { setQuery(event.target.value); setDetailOpen(false); }} aria-label={t('debug.search')} placeholder={t('networkInspector.search')}/>
      </div>
      <select className="traffic-filter" value={filter} onChange={event => { setFilter(event.target.value as TrafficFilter); setDetailOpen(false); }} aria-label={t('networkInspector.filter')}>
        <option value="all">{t('networkInspector.all')}</option><option value="http">{t('networkInspector.httpOnly')}</option>
        <option value="tunnels">{t('networkInspector.tunnelsOnly')}</option><option value="errors">{t('networkInspector.errorsOnly')}</option>
      </select>
    </div>
    <div ref={workspace} className="traffic-workspace" data-wide={wide} data-detail-open={detailOpen && Boolean(shownSelected)} style={{ '--traffic-split': split + '%' } as CSSProperties}>
      <div ref={listRef} className="traffic-navigation">
        <TrafficList key={sessionId} entries={entries} mode={mode} selectedId={shownSelected?.id ?? null}
          onSelect={selectEntry} onOrderChange={updateOrder} searching={Boolean(query.trim()) || filter !== 'all'}
          empty={<div className="traffic-empty"><Icon name="wifi" size={24}/><p>{t(emptyKey)}</p>
            {(query || filter !== 'all') && <button type="button" className="traffic-control" onClick={resetFilters}>{t('networkInspector.resetFilters')}</button>}</div>}/>
      </div>
      <div className="traffic-divider" role="separator" tabIndex={0} aria-orientation={wide ? 'vertical' : 'horizontal'} aria-label={t('networkInspector.resize')}
        aria-valuemin={25} aria-valuemax={75} aria-valuenow={split} aria-valuetext={t('networkInspector.splitValue', { p0: split })}
        onKeyDown={resizeKey} onDoubleClick={() => setSplit(58)}
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
      <TrafficDetails entry={shownSelected} detached={detached} filtered={selectedFiltered} onOptions={showOptions} onBack={!wide ? backToList : undefined}
        onExport={canExport ? entry => exportRows([entry], true) : undefined}
        onPrevious={previousId !== undefined ? () => selectEntry(previousId) : undefined}
        onNext={nextId !== undefined ? () => selectEntry(nextId) : undefined}/>
    </div>
    <footer className="traffic-footer">
      <span>{t('networkInspector.shown', { p0: entries.length, p1: allEntries.length })}</span>
      {Boolean(view?.evicted) && <span className="traffic-warning">{t('networkInspector.evicted', { p0: view!.evicted })}</span>}
      {frozen && <span className="traffic-paused"><Icon name="pause" size={12}/>{t(!sameCapture ? 'networkInspector.oldSnapshot' : 'networkInspector.frozenNew', { p0: added })}</span>}
      <span className="traffic-footer-scope" title={t('networkInspector.visibleScope')}><Icon name="shield" size={12}/>{t('networkInspector.scopeShort')}</span>
      {state?.pcapRequested && <span title={t(pcapKeys[state.pcapState ?? 'none'])}>{t('debug.pcap')}{Boolean(state.pcapBytes) && <> · {trafficSize(state.pcapBytes!)}</>}</span>}
    </footer>
  </section>;
}
