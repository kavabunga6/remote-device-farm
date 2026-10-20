import { useState, type KeyboardEvent } from 'react';
import { getLocale, t } from '../i18n';
import { Icon } from '../icons';
import { useNotifications } from '../notifications';
import type { TrafficEntry } from './debug-api';
import { trafficAddress, trafficPhase } from './traffic-entries';

export function trafficSize(bytes: number) {
  return new Intl.NumberFormat(getLocale(), { style: 'unit', unitDisplay: 'narrow', unit: bytes >= 1000 ? 'kilobyte' : 'byte', maximumFractionDigits: 1 })
    .format(bytes >= 1000 ? bytes / 1000 : bytes);
}
export function trafficTime(ms: number | null | undefined) {
  if (ms == null) return '—';
  return t(ms >= 1000 ? 'networkInspector.secondsValue' : 'networkInspector.durationValue',
    { p0: new Intl.NumberFormat(getLocale(), { maximumFractionDigits: ms >= 1000 ? 1 : 0 }).format(ms >= 1000 ? ms / 1000 : ms) });
}
export function trafficStarted(seconds: number) {
  return new Date(seconds * 1000).toLocaleTimeString(getLocale(), { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3 });
}
const phaseKeys = {
  error: 'networkInspector.transportError', httpError: 'networkInspector.httpError', pending: 'networkInspector.pending',
  connecting: 'networkInspector.connecting', sending: 'networkInspector.sending', waiting: 'networkInspector.waiting',
  receiving: 'networkInspector.receiving', open: 'networkInspector.connectionOpen', complete: 'networkInspector.complete',
  stopped: 'networkInspector.captureStoppedEntry', unknown: 'networkInspector.unknownOutcome',
} as const;
const errorKeys = {
  dns: 'networkInspector.errorDns', timeout: 'networkInspector.errorTimeout', refused: 'networkInspector.errorRefused',
  incomplete: 'networkInspector.errorIncomplete', reset: 'networkInspector.errorReset', protocol: 'networkInspector.errorProtocol', io: 'networkInspector.errorIo',
} as const;
const stageKeys = { connect: 'networkInspector.connecting', send: 'networkInspector.sending', wait: 'networkInspector.waiting', receive: 'networkInspector.receiving', tunnel: 'networkInspector.connectionOpen' } as const;

export function TrafficStatus({ entry }: { entry: TrafficEntry }) {
  const phase = trafficPhase(entry);
  const pending = ['pending', 'connecting', 'sending', 'waiting', 'receiving'].includes(phase);
  const failed = phase === 'error' || phase === 'httpError';
  const label = entry.method === 'CONNECT' && phase === 'complete' ? t('networkInspector.connectionClosed') : t(phaseKeys[phase]);
  return <span className="traffic-status" data-phase={failed ? 'error' : phase} title={label}>
    {pending && <span className="mini-spinner"/>}
    {failed && <Icon name="alert" size={13}/>}
    {phase === 'open' && <Icon name="wifi" size={13}/>}
    {entry.method === 'CONNECT' ? <span className={pending ? 'traffic-sr-only' : undefined}>{phase === 'error' || phase === 'httpError' ? t('networkInspector.error') : phase === 'stopped' ? t('networkInspector.snapshotShort') : phase === 'unknown' ? '—' : label}</span> : <span>{entry.status ?? <span className="traffic-sr-only">{label}</span>}
      {entry.statusSource === 'proxy' && <small>{t('networkInspector.proxyShort')}</small>}</span>}
  </span>;
}

type DetailTab = 'overview' | 'request' | 'response';
const tabs: DetailTab[] = ['overview', 'request', 'response'];
const tabKeys = { overview: 'networkInspector.overview', request: 'networkInspector.request', response: 'networkInspector.response' } as const;

export function TrafficDetails({ entry, detached, filtered, onOptions, onExport }: {
  entry?: TrafficEntry; detached: boolean; filtered: boolean; onOptions: () => void; onExport?: (entry: TrafficEntry) => void;
}) {
  const [tab, setTab] = useState<DetailTab>('overview');
  const { notify, notifyError } = useNotifications();
  const address = entry ? trafficAddress(entry) : null;
  const tunnel = entry?.method === 'CONNECT';
  const headers = entry ? tab === 'request' ? entry.requestHeaders : entry.responseHeaders : [];
  const body = entry ? tab === 'request' ? entry.requestBody : entry.responseBody : undefined;
  const navigateTabs = (event: KeyboardEvent<HTMLDivElement>) => {
    let next = tabs.indexOf(tab);
    if (event.key === 'ArrowRight') next = (next + 1) % tabs.length;
    else if (event.key === 'ArrowLeft') next = (next + tabs.length - 1) % tabs.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = tabs.length - 1;
    else return;
    event.preventDefault(); setTab(tabs[next]!);
    (event.currentTarget.querySelectorAll<HTMLButtonElement>('[role=tab]')[next])?.focus();
  };
  const copyUrl = async () => {
    if (!entry) return;
    try {
      await navigator.clipboard.writeText(entry.url);
      notify({ kind: 'success', title: t('networkInspector.copied') });
    } catch (cause) { notifyError(t('networkInspector.copyFailed'), cause); }
  };
  return <section className="traffic-detail" aria-label={t('networkInspector.details')}>
    <div className="traffic-detail-tabs" role="tablist" aria-label={t('networkInspector.details')} onKeyDown={navigateTabs}>
      {tabs.map(id => <button key={id} type="button" role="tab" id={'traffic-detail-tab-' + id} aria-controls={'traffic-detail-' + id}
        tabIndex={id === tab ? 0 : -1} aria-selected={id === tab} onClick={() => setTab(id)}>{t(tabKeys[id])}</button>)}
    </div>
    <div className="traffic-detail-body" role="tabpanel" id={'traffic-detail-' + tab} aria-labelledby={'traffic-detail-tab-' + tab} tabIndex={0}>
      {!entry ? <div className="traffic-empty"><Icon name="list" size={24}/><p>{t('networkInspector.selectRequest')}</p></div> : <>
        {(detached || filtered) && <p className="traffic-note traffic-retained">{t(detached ? 'networkInspector.retained' : 'networkInspector.filteredSelection')}</p>}
        <div className="traffic-selected-title">
          <strong>{entry.method}</strong><span title={address!.host}>{address!.host}</span>
          <div className="traffic-detail-actions">
            {onExport && <button className="traffic-control traffic-icon" type="button" onClick={() => onExport(entry)} aria-label={t('networkInspector.exportSelected')} title={t('networkInspector.exportSelected')}><Icon name="download" size={15}/></button>}
            <button className="traffic-control traffic-icon" type="button" onClick={() => void copyUrl()} aria-label={t('networkInspector.copyUrl')} title={t('networkInspector.copyUrl')}><Icon name="copy" size={15}/></button>
          </div>
        </div>
        <div className="traffic-full-url">{entry.url}</div>
        {entry.outcome === 'error' && <p className="traffic-note traffic-error"><Icon name="alert" size={16}/>{t(errorKeys[entry.errorKind ?? 'io'])}</p>}
        {tunnel && <p className="traffic-note"><Icon name="shield" size={16}/>{t('networkInspector.encrypted')}</p>}
        {tab === 'overview' ? <>
          <dl className="traffic-properties">
            <div><dt>{t(entry.statusSource === 'proxy' ? 'networkInspector.proxyStatus' : 'networkInspector.upstreamStatus')}</dt><dd>{entry.status ?? '—'}</dd></div>
            <div><dt>{t('networkInspector.state')}</dt><dd>{t(phaseKeys[trafficPhase(entry)])}</dd></div>
            {entry.errorPhase && <div><dt>{t('networkInspector.errorPhase')}</dt><dd>{t(stageKeys[entry.errorPhase as keyof typeof stageKeys] ?? 'networkInspector.unknownOutcome')}</dd></div>}
            <div><dt>{t('networkInspector.kind')}</dt><dd>{t(tunnel ? 'networkInspector.tunnel' : 'networkInspector.httpRequest')}</dd></div>
            <div><dt>{t('networkInspector.started')}</dt><dd>{new Date(entry.startedAt * 1000).toLocaleString(getLocale(), { hour12: false })}</dd></div>
            <div><dt>{t(entry.durationMs === null ? 'networkInspector.elapsed' : 'networkInspector.duration')}</dt><dd>{trafficTime(entry.durationMs ?? entry.elapsedMs)}</dd></div>
            <div><dt>{t(tunnel ? 'networkInspector.fromDevice' : 'networkInspector.requestBytes')}</dt><dd>{entry.bytesSent == null ? '—' : trafficSize(entry.bytesSent)}</dd></div>
            <div><dt>{t(tunnel ? 'networkInspector.toDevice' : 'networkInspector.responseBytes')}</dt><dd>{entry.bytesReceived == null ? '—' : trafficSize(entry.bytesReceived)}</dd></div>
          </dl>
          {!tunnel && <p className="traffic-note">{t('networkInspector.payloadBytes')}</p>}
          {entry.timings && <><h3>{t('networkInspector.timings')}</h3><dl className="traffic-properties">
            <div><dt>{t('networkInspector.connectTiming')}</dt><dd>{trafficTime(entry.timings.connect)}</dd></div>
            {!tunnel && (['send', 'wait', 'receive'] as const).map(stage => <div key={stage}><dt>{t(stageKeys[stage])}</dt><dd>{trafficTime(entry.timings![stage])}</dd></div>)}
          </dl></>}
        </> : tunnel ? null : <>
          <h3>{t(tab === 'request' ? 'networkInspector.requestHeaders' : 'networkInspector.responseHeaders')}</h3>
          {headers.length ? <dl className="traffic-properties traffic-headers">{headers.map((header, index) =>
            <div key={index}><dt>{header.name}</dt><dd>{header.value}</dd></div>)}</dl>
            : <p className="traffic-muted">{t('networkInspector.noRecordedHeaders')}</p>}
          <p className="traffic-note">{t('networkInspector.headerLimits')}</p>
          <h3>{t('networkInspector.bodyPreview')}</h3>
          {typeof body?.text === 'string' ? <>
            {body.truncated && <p className="traffic-note">{t('networkInspector.bodyTruncated', { p0: body.limit })}</p>}
            {body.text ? <pre className="traffic-body-preview">{body.text}</pre> : <p className="traffic-muted">{t('networkInspector.bodyEmpty')}</p>}
          </> : <>
            <p className="traffic-muted">{t(!body ? 'networkInspector.bodyUnavailable' : body.reason === 'binary' ? 'networkInspector.bodyBinary' : body?.reason === 'encoded' ? 'networkInspector.bodyEncoded' : 'networkInspector.bodyDisabled')}</p>
            {(!body || body.reason === 'disabled') && <button className="traffic-control" type="button" onClick={onOptions}>{t('networkInspector.nextCaptureOptions')}</button>}
          </>}
        </>}
      </>}
    </div>
  </section>;
}
