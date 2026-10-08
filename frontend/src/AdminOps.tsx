import { getLanguage, getLocale, localizeText, t } from './i18n';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Icon } from './icons';
import { opsApi, type OpsSeries, type OpsSummary } from './ops-api';
import './Ops.css';

type Range = '24h' | '14d';

const HOUR = 3_600_000;
const SERIES_VARS = ['--ops-s1', '--ops-s2', '--ops-s3', '--ops-s4', '--ops-s5', '--ops-s6'];
const DASHES = ['', '6 3', '2 3', '8 3 2 3', '', '6 3'];
const seriesColor = (index: number) => `var(${SERIES_VARS[index % SERIES_VARS.length]})`;
const formatSlotCount = (value: number) => value.toLocaleString(getLocale(), { maximumFractionDigits: 2 });

export function formatDuration(seconds: number | null): string {
  if (seconds === null) return '—';
  const minutes = Math.round(seconds / 60);
  if (minutes < 1) return t('ui.ace0bbca5462');
  if (minutes < 60) return t('ui.1febafe019db', { p0: minutes });
  const hours = Math.floor(minutes / 60);
  return t('ui.c463a3b13dca', { p0: hours, p1: String(minutes % 60).padStart(2, '0') });
}

export function localPeakHour(utcHour: number | null, offsetMinutes = -new Date().getTimezoneOffset()): number | null {
  if (utcHour === null) return null;
  return (((utcHour + Math.round(offsetMinutes / 60)) % 24) + 24) % 24;
}

const pad = (value: number) => String(value).padStart(2, '0');
const timeLabel = (ms: number) => { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const dayLabel = (ms: number) => new Date(ms).toLocaleDateString(getLocale(), { day: '2-digit', month: '2-digit' });

function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(640);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const update = () => setWidth(Math.max(260, Math.floor(element.clientWidth)));
    update();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

// Splits a series into runs so that missing samples leave a visible gap instead of a straight line.
function runs(series: OpsSeries, gapMs: number): Array<Array<[number, number]>> {
  const result: Array<Array<[number, number]>> = [];
  let last = -Infinity;
  for (const point of series.points) {
    const t = new Date(point.at).getTime();
    const value = point.used;
    if (t - last > gapMs || !result.length) result.push([]);
    result[result.length - 1]!.push([t, value]);
    last = t;
  }
  return result;
}

function UtilizationChart({ series, range, bucketMinutes, now }: { series: OpsSeries[]; range: Range; bucketMinutes: number; now: number }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const [showTable, setShowTable] = useState(false);
  const height = 250;
  const m = { top: 12, right: 14, bottom: 28, left: 40 };
  const span = range === '24h' ? 24 * HOUR : 14 * 24 * HOUR;
  const start = now - span;
  const w = width - m.left - m.right;
  const h = height - m.top - m.bottom;
  const x = (t: number) => m.left + ((t - start) / span) * w;
  const yTicks = useMemo(() => {
    const maximum = Math.max(1, ...series.flatMap(item => item.points.map(point => point.used)));
    const rawStep = maximum / 4;
    const magnitude = 10 ** Math.floor(Math.log10(rawStep));
    const step = Math.max(1, [1, 2, 5, 10].find(value => value * magnitude >= rawStep)! * magnitude);
    return Array.from({ length: Math.ceil(maximum / step) + 1 }, (_, index) => index * step);
  }, [series, getLanguage()]);
  const top = yTicks[yTicks.length - 1]!;
  const y = (v: number) => m.top + h - (v / top) * h;
  const averagingLabel = bucketMinutes === 120 ? t('ui.46ba3b9fbd21') : t('ui.6abc26ec5b23', { p0: bucketMinutes });
  const xTicks = useMemo(() => {
    const count = width < 420 ? 4 : 6;
    return Array.from({ length: count + 1 }, (_, i) => start + (span * i) / count);
  }, [start, span, width, getLanguage()]);
  const gap = bucketMinutes * 60_000 * 3;
  const times = useMemo(() => [...new Set(series.flatMap(item => item.points.map(point => new Date(point.at).getTime())))].sort((a, b) => a - b), [series, getLanguage()]);
  const tableRows = useMemo(() => showTable ? series.flatMap(item => item.points.map(point => ({
    at: new Date(point.at).getTime(), hostName: item.hostName, used: point.used, total: point.total,
  }))).sort((a, b) => a.at - b.at || a.hostName.localeCompare(b.hostName)) : [], [series, showTable, getLanguage()]);

  const onMove = (event: React.PointerEvent<SVGSVGElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    const t = start + ((event.clientX - box.left - m.left) / w) * span;
    let best: number | null = null;
    for (const candidate of times) if (best === null || Math.abs(candidate - t) < Math.abs(best - t)) best = candidate;
    setHover(best);
  };
  const hoverRows = hover === null ? [] : series.map((item, index) => {
    const point = item.points.find(p => new Date(p.at).getTime() === hover);
    return point ? { item, index, point } : null;
  }).filter((row): row is NonNullable<typeof row> => row !== null);
  const tipLeft = hover === null ? 0 : Math.min(Math.max(x(hover) + 10, 4), Math.max(4, width - 190));

  return <div className="ops-chart" ref={ref}>
    <p className="ops-chart-note">{averagingLabel}</p>
    <svg width={width} height={height} role="img" aria-label={t('ui.bcf4746929de')} onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
      {yTicks.map(tick => <g key={tick}>
        <line className="ops-grid" x1={m.left} x2={width - m.right} y1={y(tick)} y2={y(tick)} />
        <text className="ops-tick" x={m.left - 7} y={y(tick) + 4} textAnchor="end">{formatSlotCount(tick)}</text>
      </g>)}
      {xTicks.map((tick, index) => <text key={tick} className="ops-tick" x={x(tick)} y={height - 8}
        textAnchor={index === 0 ? 'start' : index === xTicks.length - 1 ? 'end' : 'middle'}>{range === '24h' ? timeLabel(tick) : dayLabel(tick)}</text>)}
      <line className="ops-axis" x1={m.left} x2={width - m.right} y1={y(0)} y2={y(0)} />
      {series.map((item, index) => <g key={item.hostId} fill="none" stroke={seriesColor(index)} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" strokeDasharray={DASHES[index % DASHES.length]}>
        {runs(item, gap).map((run, i) => run.length === 1
          ? <circle key={i} cx={x(run[0]![0])} cy={y(run[0]![1])} r="2.5" fill={seriesColor(index)} stroke="none" />
          : <polyline key={i} points={run.map(([t, v]) => `${x(t).toFixed(1)},${y(v).toFixed(1)}`).join(' ')} />)}
      </g>)}
      {hover !== null && <g pointerEvents="none">
        <line className="ops-cross" x1={x(hover)} x2={x(hover)} y1={m.top} y2={y(0)} />
        {hoverRows.map(({ item, index, point }) => <circle key={item.hostId} className="ops-dot" cx={x(hover)} cy={y(point.used)} r="4" fill={seriesColor(index)} />)}
      </g>}
    </svg>
    {hover !== null && <div className="ops-tooltip" style={{ left: tipLeft, top: 8 }} role="status">
      <strong>{range === '24h' ? timeLabel(hover) : `${dayLabel(hover)} ${timeLabel(hover)}`}</strong>
      {hoverRows.map(({ item, index, point }) => <div key={item.hostId}><i style={{ background: seriesColor(index) }} />{item.hostName}<b>{formatSlotCount(point.used)} {t('ui.e029cc4b39ce')}{formatSlotCount(point.total)}</b></div>)}
    </div>}
    <details className="ops-data" onToggle={event => setShowTable(event.currentTarget.open)}>
      <summary>{t('ui.940b752f5e1c')}</summary>
      {showTable && <div className="table-wrap"><table className="sessions-table ops-table">
        <caption>{t('ui.2367addf6e46')}{range === '24h' ? t('ui.7941488fa3af') : t('ui.7e08a2ca839e')} · {averagingLabel.toLocaleLowerCase(getLocale())}</caption>
        <thead><tr><th>{t('ui.6711f073ab8b')}</th><th>{t('ui.e77a383ee52d')}</th><th className="num">{t('ui.609968f00d5d')}</th><th className="num">{t('ui.b2daabc8bfe9')}</th></tr></thead>
        <tbody>{tableRows.map((row, index) => <tr key={row.hostName + ':' + row.at + ':' + index}>
          <td>{new Intl.DateTimeFormat(getLocale(), { dateStyle: 'short', timeStyle: 'short' }).format(row.at)}</td>
          <td>{row.hostName}</td><td className="num">{formatSlotCount(row.used)}</td>
          <td className="num">{formatSlotCount(row.total)}</td>
        </tr>)}</tbody>
      </table></div>}
    </details>
  </div>;
}

function niceMax(value: number): number {
  if (value <= 4) return 4;
  const pow = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 2, 4, 5, 10]) if (step * pow >= value) return step * pow;
  return 10 * pow;
}

function DayBars({ days }: { days: Array<{ day: string; count: number }> }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const height = 200;
  const m = { top: 12, right: 10, bottom: 28, left: 34 };
  const top = niceMax(Math.max(...days.map(d => d.count), 0));
  const w = width - m.left - m.right;
  const h = height - m.top - m.bottom;
  const slot = w / days.length;
  const bar = Math.max(4, Math.min(28, slot - 4));
  const y = (v: number) => m.top + h - (v / top) * h;
  const label = (day: string) => `${day.slice(8, 10)}.${day.slice(5, 7)}`;
  const every = slot < 26 ? 3 : slot < 46 ? 2 : 1;
  return <div className="ops-chart" ref={ref}>
    <svg width={width} height={height} role="img" aria-label={t('ui.582385e8b1cb')} onPointerLeave={() => setHover(null)}>
      {[0, 0.5, 1].map(f => <g key={f}>
        <line className="ops-grid" x1={m.left} x2={width - m.right} y1={y(top * f)} y2={y(top * f)} />
        <text className="ops-tick" x={m.left - 7} y={y(top * f) + 4} textAnchor="end">{Math.round(top * f)}</text>
      </g>)}
      {days.map((d, i) => {
        const cx = m.left + slot * i + slot / 2;
        const bh = (d.count / top) * h;
        const r = Math.min(4, bh / 2, bar / 2);
        const x0 = cx - bar / 2;
        const path = bh > 0 ? `M${x0},${y(0)} V${y(d.count) + r} Q${x0},${y(d.count)} ${x0 + r},${y(d.count)} H${x0 + bar - r} Q${x0 + bar},${y(d.count)} ${x0 + bar},${y(d.count) + r} V${y(0)} Z` : '';
        return <g key={d.day} onPointerEnter={() => setHover(i)}>
          <rect x={m.left + slot * i} y={m.top} width={slot} height={h} fill="transparent" />
          {path && <path d={path} className={`ops-bar ${hover === i ? 'hot' : ''}`} />}
          {i % every === (days.length - 1) % every && <text className="ops-tick" x={cx} y={height - 8} textAnchor="middle">{label(d.day)}</text>}
        </g>;
      })}
      <line className="ops-axis" x1={m.left} x2={width - m.right} y1={y(0)} y2={y(0)} />
    </svg>
    <div className="ops-readout" aria-live="polite">{hover === null ? t('ui.87454cdae15f') : `${label(days[hover]!.day)}: ${days[hover]!.count}`}</div>
    <details className="ops-data"><summary>{t('ui.3397e8fcdd64')}</summary>
      <div className="table-wrap"><table className="sessions-table ops-table">
        <caption>{t('ui.d8e2472752af')}</caption>
        <thead><tr><th>{t('ui.232a0ead182b')}</th><th className="num">{t('ui.943055d17bec')}</th></tr></thead>
        <tbody>{days.map(day => <tr key={day.day}><td>{label(day.day)}</td><td className="num">{day.count}</td></tr>)}</tbody>
      </table></div>
    </details>
  </div>;
}

export function AdminOps() {
  const [data, setData] = useState<OpsSummary | null>(null);
  const [error, setError] = useState('');
  const [, setBusy] = useState(false);
  const [range, setRange] = useState<Range>('24h');

  const load = async () => {
    setBusy(true); setError('');
    try { setData(await opsApi.summary()); }
    catch (cause) { setError(cause instanceof Error ? cause.message : t('ui.255d42a275f5')); }
    finally { setBusy(false); }
  };
  useEffect(() => { void load(); }, []);

  const active = data ? (range === '24h' ? data.utilization24h : data.utilization14d) : null;
  const total14 = data ? data.sessionsPerDay.reduce((sum, d) => sum + d.count, 0) : 0;
  const peak = data ? localPeakHour(data.peakHourUtc) : null;
  const now = data ? new Date(data.generatedAt).getTime() : Date.now();

  return <section id="adm-ops" className="admin-ops" aria-labelledby="admin-ops-heading">
    <div className="section-heading">
      <div><h2 id="admin-ops-heading">{t('ui.9641cd43bf2d')}</h2><p>{t('ui.fabbaaa3283b')}</p></div>
    </div>
    {error && <div className="banner-error" role="alert"><Icon name="alert" size={18} /><span>{localizeText(error)}</span><button type="button" onClick={() => void load()}>{t('ui.5189135a6110')}</button></div>}
    {!data && !error && <div className="loading-box">{t('ui.162340de56f8')}</div>}
    {data && <>
      <div className="ops-cards">
        <div className="ops-card"><span>{t('ui.140b78c4bf38')}</span><strong>{total14}</strong></div>
        <div className="ops-card"><span>{t('ui.fe7905f64bee')}</span><strong>{formatDuration(data.duration.avgSeconds)}</strong><small>{t('ui.d5373b67bbfc')}{formatDuration(data.duration.p90Seconds)}</small></div>
        <div className="ops-card"><span>{t('ui.21765716bc2d')}</span><strong>{peak === null ? '—' : `${pad(peak)}:00`}</strong><small>{t('ui.ddf3f81a4867')}</small></div>
        <div className={`ops-card ${data.failures.last14d ? 'bad' : ''}`}><span>{t('ui.22b700067e3d')}</span><strong>{data.failures.last14d}</strong><small>{t('ui.fe32982fff7c')}{data.failures.last24h}</small></div>
      </div>

      <div className="ops-panels"><div className="ops-panel">
        <div className="ops-panel-head">
          <h3>{t('ui.80384178a7df')}</h3>
          <div className="ops-switch" role="group" aria-label={t('ui.e97ca72e2ca5')}>
            <button type="button" className={range === '24h' ? 'selected' : ''} aria-pressed={range === '24h'} onClick={() => setRange('24h')}>{t('ui.7941488fa3af')}</button>
            <button type="button" className={range === '14d' ? 'selected' : ''} aria-pressed={range === '14d'} onClick={() => setRange('14d')}>{t('ui.7e08a2ca839e')}</button>
          </div>
        </div>
        {active && active.series.length ? <>
          <ul className="ops-legend" aria-label={t('ui.f3a46c2f2b5c')}>{active.series.map((item, index) => <li key={item.hostId}><svg width="22" height="10" aria-hidden="true"><line x1="1" x2="21" y1="5" y2="5" stroke={seriesColor(index)} strokeWidth="2" strokeLinecap="round" strokeDasharray={DASHES[index % DASHES.length]} /></svg>{item.hostName}</li>)}</ul>
          <UtilizationChart series={active.series} range={range} bucketMinutes={active.bucketMinutes} now={now} />
        </> : <div className="ops-empty">{t('ui.19eecdbd5084')}</div>}
      </div>

      <div className="ops-panel">
        <div className="ops-panel-head"><h3>{t('ui.03073cee43b5')}</h3></div>
        {total14 ? <DayBars days={data.sessionsPerDay} /> : <div className="ops-empty">{t('ui.df1559e1dabe')}</div>}
      </div>

      <div className="ops-panel">
        <div className="ops-panel-head"><h3>{t('ui.8ee0e0006443')}</h3><span className="ops-note">{t('ui.5d4c7bd2d5c5')}</span></div>
        {data.topUsers.length ? <div className="table-wrap"><table className="sessions-table ops-table"><thead><tr><th>{t('ui.2a5c42af7c00')}</th><th className="num">{t('ui.943055d17bec')}</th><th className="num">{t('ui.6711f073ab8b')}</th></tr></thead>
          <tbody>{data.topUsers.map(user => <tr key={user.username}><td>{user.username}</td><td className="num">{user.sessions}</td><td className="num">{formatDuration(user.minutes * 60)}</td></tr>)}</tbody></table></div>
          : <div className="ops-empty">{t('ui.53e09cc50d71')}</div>}
      </div>
      </div>
    </>}
  </section>;
}
