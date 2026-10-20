import { useState, type KeyboardEvent } from 'react';
import { getLocale, t } from '../i18n';
import { Icon } from '../icons';
import { useNotifications } from '../notifications';
import type { TrafficEntry } from './debug-api';
import { trafficAddress, trafficPhase } from './traffic-entries';

export function trafficSize(bytes: number) {
  return new Intl.NumberFormat(getLocale(), { style: 'unit', unitDisplay: 'narrow', unit: bytes >= 1024 ? 'kilobyte' : 'byte', maximumFractionDigits: 1 })
    .format(bytes >= 1024 ? bytes / 1000 : bytes);
}
export function trafficTime(ms: number | null) {
  return ms === null ? '—' : t('networkInspector.durationValue', { p0: new Intl.NumberFormat(getLocale(), { maximumFractionDigits: 0 }).format(ms) });
}
export function trafficStarted(seconds: number) {
  return new Date(seconds * 1000).toLocaleTimeString(getLocale(), { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3 });
}
const phaseKeys = { error: 'networkInspector.error', pending: 'networkInspector.pending', complete: 'networkInspector.complete' } as const;

export function TrafficStatus({ entry, compact = false }: { entry: TrafficEntry; compact?: boolean }) {
  const phase = trafficPhase(entry);
  return <span className="traffic-status" data-phase={phase} title={t(phaseKeys[phase])}>
    {phase === 'pending' && <span className="mini-spinner"/>}
    {phase === 'error' && <Icon name="alert" size={13}/>}
    {entry.status ?? <span className={compact ? 'traffic-sr-only' : undefined}>{t('networkInspector.pending')}</span>}
  </span>;
}

type DetailTab = 'overview' | 'request' | 'response';
const tabs: DetailTab[] = ['overview', 'request', 'response'];
const tabKeys = { overview: 'networkInspector.overview', request: 'networkInspector.request', response: 'networkInspector.response' } as const;

export function TrafficDetails({ entry, expired }: { entry?: TrafficEntry; expired: boolean }) {
  const [tab, setTab] = useState<DetailTab>('overview');
  const { notify, notifyError } = useNotifications();
  const address = entry ? trafficAddress(entry) : null;
  const tunnel = entry?.method === 'CONNECT';
  const headers = entry ? tab === 'request' ? entry.requestHeaders : entry.responseHeaders : [];
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
      {!entry ? <div className="traffic-empty"><Icon name="list" size={24}/><p>{t(expired ? 'networkInspector.expired' : 'networkInspector.selectRequest')}</p></div> : <>
        <div className="traffic-selected-title">
          <strong>{entry.method}</strong><span title={address!.host}>{address!.host}</span>
          <button className="traffic-control traffic-icon" type="button" onClick={() => void copyUrl()} aria-label={t('networkInspector.copyUrl')} title={t('networkInspector.copyUrl')}><Icon name="copy" size={15}/></button>
        </div>
        <div className="traffic-full-url">{entry.url}</div>
        {tunnel && <p className="traffic-note"><Icon name="shield" size={16}/>{t('networkInspector.encrypted')}</p>}
        {tab === 'overview' ? <dl className="traffic-properties">
          <div><dt>{t('networkInspector.status')}</dt><dd><TrafficStatus entry={entry}/></dd></div>
          <div><dt>{t('networkInspector.state')}</dt><dd>{t(phaseKeys[trafficPhase(entry)])}</dd></div>
          <div><dt>{t('networkInspector.kind')}</dt><dd>{t(tunnel ? 'networkInspector.tunnel' : 'networkInspector.httpRequest')}</dd></div>
          <div><dt>{t('networkInspector.started')}</dt><dd>{new Date(entry.startedAt * 1000).toLocaleString(getLocale(), { hour12: false })}</dd></div>
          <div><dt>{t('networkInspector.duration')}</dt><dd>{trafficTime(entry.durationMs)}</dd></div>
          <div><dt>{t('networkInspector.transferred')}</dt><dd>{trafficSize(entry.bytes)}</dd></div>
        </dl> : <>
          <h3>{t(tab === 'request' ? 'networkInspector.requestHeaders' : 'networkInspector.responseHeaders')}</h3>
          {headers.length ? <dl className="traffic-properties traffic-headers">{headers.map((header, index) =>
            <div key={index}><dt>{header.name}</dt><dd>{header.value}</dd></div>)}</dl>
            : <p className="traffic-muted">{t('networkInspector.noRecordedHeaders')}</p>}
          {!tunnel && <p className="traffic-note">{t('networkInspector.headerLimits')}</p>}
        </>}
      </>}
    </div>
  </section>;
}
