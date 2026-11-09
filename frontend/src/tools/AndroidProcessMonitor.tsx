import { useId, useState } from 'react';
import { Icon } from '../icons';
import { localizeText, t } from '../i18n';
import { bytes, formatTime, number, percent } from './performance-format';
import './AndroidProcessMonitor.css';

type AndroidProcess = { pid: number; name: string; cpuPercent: number; residentBytes: number };
export type ProcessSnapshot = { sampledAt: string; processes: AndroidProcess[] };
export const PROCESS_INTERVALS = [2, 4, 6, 8, 10, 15, 30] as const;
export type ProcessInterval = typeof PROCESS_INTERVALS[number];
type Metric = 'cpuPercent' | 'residentBytes';

export function AndroidProcessMonitor({ snapshot, error, running, paused, sampling, interval, onIntervalChange, onToggle }: {
  snapshot: ProcessSnapshot | null;
  error: unknown;
  running: boolean;
  paused: boolean;
  sampling: boolean;
  interval: ProcessInterval;
  onIntervalChange: (interval: ProcessInterval) => void;
  onToggle: () => void;
}) {
  const intervalId = useId();
  const [metric, setMetric] = useState<Metric>('cpuPercent');
  const rows = [...(snapshot?.processes ?? [])].sort((a, b) => b[metric] - a[metric] || a.pid - b.pid);
  const memoryScale = Math.max(1, ...rows.map(row => row.residentBytes));
  const live = sampling && !error && !!snapshot;
  const status = !running ? t('ui.39e74d43c11a')
    : !sampling ? t('performance.processPaused')
    : error ? t('performance.processRetry')
    : snapshot ? t('performance.processLive') : t('ui.162340de56f8');

  function sortColumn(value: Metric, label: string, shortLabel?: string) {
    const selected = metric === value;
    return <th scope="col" aria-sort={selected ? 'descending' : 'none'}>
      <button type="button" aria-label={label} title={label} onClick={() => setMetric(value)}>
        {shortLabel ? <>
          <span className="process-column-long">{label}</span>
          <span className="process-column-short">{shortLabel}</span>
        </> : label}
        <span className="process-sort-icon" aria-hidden="true">{selected && <Icon name="arrowDown" size={14} />}</span>
      </button>
    </th>;
  }

  return <section className="performance-section process-monitor" aria-labelledby="performance-processes">
    <header className="performance-section-header">
      <h3 id="performance-processes">{t('performance.processes')}</h3>
      <div className="process-actions">
        <label htmlFor={intervalId}>{t('performance.processInterval')}</label>
        <select id={intervalId} value={interval} disabled={!running} onChange={event => {
          const value = PROCESS_INTERVALS.find(seconds => seconds === Number(event.target.value));
          if (value !== undefined) onIntervalChange(value);
        }}>
          {PROCESS_INTERVALS.map(seconds => <option key={seconds} value={seconds}>
            {number(seconds, { style: 'unit', unit: 'second' })}
          </option>)}
        </select>
        <button type="button" className="button subtle process-toggle" disabled={!running} onClick={onToggle}>
          <Icon name={paused ? 'play' : 'pause'} size={16} />
          {t(paused ? 'ui.a42aee58d60a' : 'ui.65530fd463ea')}
        </button>
      </div>
    </header>
    <div className="process-summary">
      <span className="process-status" data-live={live} role="status">{status}</span>
      {snapshot && <time dateTime={snapshot.sampledAt}>
        {t('performance.processSampled', { p0: formatTime(snapshot.sampledAt) })}
      </time>}
    </div>
    {error != null && running && <p className="performance-error">
      {error instanceof Error ? localizeText(error.message) : t('performance.processUnavailable')}
    </p>}
    <p className="process-hint">{t('performance.processHint', { p0: percent(100) })}</p>
    {rows.length > 0 && <>
      <div className="process-table-wrap" role="region" aria-labelledby="performance-processes" tabIndex={0}>
        <table className="process-table" aria-labelledby="performance-processes">
          <thead><tr>
            <th scope="col">{t('performance.process')}</th>
            {sortColumn('cpuPercent', t('ui.db9a4c7d4c19'))}
            {sortColumn('residentBytes', t('performance.rss'), t('performance.rssShort'))}
          </tr></thead>
          <tbody>{rows.map(row => <tr key={row.pid}>
            <th scope="row"><bdi>{row.name}</bdi><small><bdi>#{number(row.pid, { useGrouping: false })}</bdi></small></th>
            <td><UsageBar value={percent(row.cpuPercent)} ratio={row.cpuPercent / 100} /></td>
            <td><UsageBar value={bytes(row.residentBytes)} ratio={row.residentBytes / memoryScale} memory /></td>
          </tr>)}</tbody>
        </table>
      </div>
      <p className="process-hint">{t('performance.processMemoryScale', { p0: bytes(memoryScale) })}</p>
    </>}
    {snapshot && rows.length === 0 && <p>{t('ui.76848548e29c')}</p>}
  </section>;
}

function UsageBar({ value, ratio, memory = false }: { value: string; ratio: number; memory?: boolean }) {
  return <div className="process-usage" data-memory={memory}>
    <bdi>{value}</bdi>
    <span className="process-usage-track" aria-hidden="true">
      <span style={{ inlineSize: Math.min(ratio, 1) * 100 + '%' }} />
    </span>
  </div>;
}
