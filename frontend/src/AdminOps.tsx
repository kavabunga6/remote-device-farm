import { getLocale, localizeText, t } from './i18n';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { Icon } from './icons';
import { opsApi, type OpsSeries, type OpsSummary } from './ops-api';
import './Ops.css';

type Range = '24h' | '14d';

const HOUR = 3_600_000;
const SERIES_COLORS = ['--ops-s1', '--ops-s2', '--ops-s3', '--ops-s4', '--ops-s5', '--ops-s6'];
const DASHES = ['', '6 3', '2 3', '8 3 2 3', '', '6 3'];
const seriesColor = (index: number) => 'var(' + SERIES_COLORS[index % SERIES_COLORS.length] + ')';
const numberLabel = (value: number) => value.toLocaleString(getLocale(), { maximumFractionDigits: 2 });

function formatDuration(seconds: number | null): string {
  if (seconds === null) return '—';
  const minutes = Math.round(seconds / 60);
  if (minutes < 1) return t('ui.ace0bbca5462');
  if (minutes < 60) return t('ui.1febafe019db', { p0: numberLabel(minutes) });
  return t('ui.c463a3b13dca', {
    p0: numberLabel(Math.floor(minutes / 60)),
    p1: (minutes % 60).toLocaleString(getLocale(), { minimumIntegerDigits: 2 }),
  });
}

function useChartSize() {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 640, rem: 16 });
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const update = () => {
      const width = element.clientWidth;
      const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
      if (!width) return;
      setSize(previous => previous.width === width && previous.rem === rem ? previous : { width, rem });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return { ref, ...size };
}

function navigateChart(event: React.KeyboardEvent<SVGSVGElement>, current: number, last: number, select: (index: number) => void) {
  const index = event.key === 'Home' ? 0 : event.key === 'End' ? last
    : event.key === 'ArrowLeft' ? current - 1 : event.key === 'ArrowRight' ? current + 1 : null;
  if (index === null) return;
  event.preventDefault();
  select(Math.max(0, Math.min(last, index)));
}

// A missing bucket must leave a gap. Zero is a real measurement.
function runs(series: OpsSeries, bucketMs: number): Array<Array<[number, number]>> {
  const result: Array<Array<[number, number]>> = [];
  let last = -Infinity;
  for (const point of series.points) {
    const time = Date.parse(point.at);
    if (time - last > bucketMs) result.push([]);
    result[result.length - 1]!.push([time, point.used]);
    last = time;
  }
  return result;
}

function UtilizationChart({ series, range, bucketMinutes, now }: { series: OpsSeries[]; range: Range; bucketMinutes: number; now: number }) {
  const { ref, width, rem } = useChartSize();
  const [selected, setSelected] = useState<number | null>(null);
  const hintId = useId();
  const bucketMs = bucketMinutes * 60_000;
  const start = Math.floor((now - (range === '24h' ? 24 : 14 * 24) * HOUR) / bucketMs) * bucketMs;
  const span = now - start;
  const lastIndex = Math.floor(span / bucketMs);
  const latestTime = Math.max(...series.map(item => Date.parse(item.points.at(-1)!.at)));
  const current = selected ?? Math.round((latestTime - start) / bucketMs);
  const currentTime = start + current * bucketMs;
  const rows = series.map(item => item.points.find(point => Date.parse(point.at) === currentTime));
  const timeFormat = new Intl.DateTimeFormat(getLocale(), { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const dateFormat = new Intl.DateTimeFormat(getLocale(), { day: '2-digit', month: '2-digit' });
  const intervalFormat = new Intl.DateTimeFormat(getLocale(), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

  const height = 220;
  const left = rem * 2.5, right = width - rem * .75;
  const top = rem * 1.5, bottom = height - rem * 1.55;
  const plotWidth = Math.max(1, right - left);
  const x = (time: number) => left + (time - start) / span * plotWidth;
  const maximum = series.reduce((max, item) => item.points.reduce((peak, point) => Math.max(peak, point.used), max), 1);
  const step = Math.max(1, Math.ceil(maximum / 4));
  const ceiling = Math.ceil(maximum / step) * step;
  const y = (value: number) => bottom - value / ceiling * (bottom - top);
  const narrow = width < rem * 24;
  const tickInterval = HOUR * (range === '24h' ? (narrow ? 8 : 4) : (narrow ? 96 : 48));
  const localOffset = new Date(start).getTimezoneOffset() * 60_000;
  const firstTick = Math.ceil((start - localOffset) / tickInterval) * tickInterval + localOffset;
  const ticks = Array.from({ length: Math.floor((now - firstTick) / tickInterval) + 1 }, (_, index) => firstTick + index * tickInterval);
  const onPointer = (event: React.PointerEvent<SVGSVGElement>) => {
    const position = (event.clientX - event.currentTarget.getBoundingClientRect().left - left) / plotWidth;
    setSelected(Math.max(0, Math.min(lastIndex, Math.round(position * span / bucketMs))));
  };

  return <div className="ops-chart" ref={ref}>
    <svg width={width} height={height} role="img" tabIndex={0} aria-label={t('ui.bcf4746929de')} aria-describedby={hintId}
      onPointerMove={onPointer} onPointerDown={onPointer}
      onKeyDown={event => navigateChart(event, current, lastIndex, setSelected)}>
      <desc id={hintId}>{t('ops.chartKeys')}</desc>
      {Array.from({ length: ceiling / step + 1 }, (_, index) => index * step).map(tick => <g key={tick}>
        <line className={tick === 0 ? 'ops-axis' : 'ops-grid'} x1={left} x2={right} y1={y(tick)} y2={y(tick)} />
        <text className="ops-tick" x={left - 7} y={y(tick) + 4} textAnchor="end">{numberLabel(tick)}</text>
      </g>)}
      {ticks.map((tick, index) =>
        <text key={tick} className="ops-tick" x={x(tick)} y={height - 8}
          textAnchor={index === 0 ? 'start' : index === ticks.length - 1 ? 'end' : 'middle'}>
          {(range === '24h' ? timeFormat : dateFormat).format(tick)}
        </text>)}
      {series.map((item, index) => <g key={item.hostId} fill="none" stroke={seriesColor(index)} strokeWidth="2"
        strokeLinejoin="round" strokeLinecap="round" strokeDasharray={DASHES[index % DASHES.length]}>
        {runs(item, bucketMs).map(run => run.length === 1
          ? <circle key={run[0]![0]} cx={x(run[0]![0])} cy={y(run[0]![1])} r="2.5" fill={seriesColor(index)} stroke="none" />
          : <polyline key={run[0]![0]} points={run.map(([time, value]) => x(time).toFixed(1) + ',' + y(value).toFixed(1)).join(' ')} />)}
      </g>)}
      <g pointerEvents="none">
        <line className="ops-cross" x1={x(currentTime)} x2={x(currentTime)} y1={top} y2={bottom} />
        {rows.map((point, index) => point && <circle key={series[index]!.hostId} className="ops-dot" cx={x(currentTime)}
          cy={y(point.used)} r="4" fill={seriesColor(index)} />)}
      </g>
    </svg>
    <div className="ops-readout" role="status">
      <span className="ops-readout-period"><bdi>{intervalFormat.formatRange(currentTime, Math.min(now, currentTime + bucketMs))}</bdi></span>
      <ul className="ops-readout-series" aria-label={t('ui.f3a46c2f2b5c')}>
        {series.map((item, index) => {
          const point = rows[index];
          return <li key={item.hostId}>
            <svg width="22" height="10" aria-hidden="true"><line x1="1" x2="21" y1="5" y2="5" stroke={seriesColor(index)} strokeWidth="2" strokeDasharray={DASHES[index % DASHES.length]} /></svg>
            <bdi>{item.hostName}</bdi>
            <strong>{point ? t('copy.AdminOps.7667c197', { p0: numberLabel(point.used), p1: numberLabel(point.total) }) : t('ops.noSample')}</strong>
          </li>;
        })}
      </ul>
    </div>
  </div>;
}

function DayBars({ days }: { days: OpsSummary['sessionsPerDay'] }) {
  const { ref, width, rem } = useChartSize();
  const [selected, setSelected] = useState(days.length - 1);
  const hintId = useId();
  const height = 220;
  const left = rem * 2.5, right = width - rem * .75;
  const top = rem * 1.5, bottom = height - rem * 1.55;
  const max = Math.max(...days.map(day => day.count), 1);
  const step = Math.max(1, Math.ceil(max / 4));
  const ceiling = Math.ceil(max / step) * step;
  const slot = Math.max(1, right - left) / days.length;
  const bar = Math.max(2, Math.min(rem * 1.75, slot - 4));
  const y = (value: number) => bottom - value / ceiling * (bottom - top);
  const label = new Intl.DateTimeFormat(getLocale(), { day: '2-digit', month: '2-digit', timeZone: 'UTC' });
  const readoutDate = new Intl.DateTimeFormat(getLocale(), { day: 'numeric', month: 'long', timeZone: 'UTC' });
  const every = Math.ceil(rem * 3.5 / slot);
  const current = days[selected]!;

  return <div className="ops-chart" ref={ref}>
    <svg width={width} height={height} role="img" tabIndex={0} aria-label={t('ui.582385e8b1cb')} aria-describedby={hintId}
      onKeyDown={event => navigateChart(event, selected, days.length - 1, setSelected)}>
      <desc id={hintId}>{t('ops.chartKeys')}</desc>
      {Array.from({ length: ceiling / step + 1 }, (_, index) => index * step).map(tick => <g key={tick}>
        <line className={tick === 0 ? 'ops-axis' : 'ops-grid'} x1={left} x2={right} y1={y(tick)} y2={y(tick)} />
        <text className="ops-tick" x={left - 7} y={y(tick) + 4} textAnchor="end">{numberLabel(tick)}</text>
      </g>)}
      {days.map((day, index) => {
        const cx = left + slot * (index + .5);
        const barTop = y(day.count);
        const barHeight = Math.max(day.count ? 0 : 2, bottom - barTop);
        return <g key={day.day} onPointerEnter={() => setSelected(index)} onPointerDown={() => setSelected(index)}>
          {selected === index && <rect className="ops-bar-selection" x={left + slot * index} y={top} width={slot} height={bottom - top} rx="3" />}
          <rect x={left + slot * index} y={0} width={slot} height={height} fill="transparent" />
          <rect x={cx - bar / 2} y={bottom - barHeight} width={bar} height={barHeight} rx={Math.min(3, barHeight / 2)}
            className={day.count ? 'ops-bar' : 'ops-bar-empty'} />
          {day.count > 0 && slot >= rem * 1.6 && <text className="ops-bar-value" x={cx} y={barTop - 6} textAnchor="middle">{numberLabel(day.count)}</text>}
          {index % every === (days.length - 1) % every && <text className="ops-tick" x={cx} y={height - 8} textAnchor="middle">{label.format(new Date(day.day))}</text>}
        </g>;
      })}
    </svg>
    <div className="ops-readout" role="status">
      <time className="ops-readout-period" dateTime={current.day}>{readoutDate.format(new Date(current.day))}</time>
      <strong>{t('ops.dayCount', { p0: numberLabel(current.count) })}</strong>
    </div>
  </div>;
}

export function AdminOps() {
  const [data, setData] = useState<OpsSummary | null>(null);
  const [error, setError] = useState('');
  const [range, setRange] = useState<Range>('24h');

  const load = async () => {
    setError('');
    try { setData(await opsApi.summary()); }
    catch (cause) { setError(cause instanceof Error ? cause.message : t('ui.255d42a275f5')); }
  };
  useEffect(() => { void load(); }, []);

  const active = data?.[range === '24h' ? 'utilization24h' : 'utilization14d'];
  const usedSeries = active?.series.filter(item => item.points.some(point => point.used > 0)) ?? [];
  const hasSamples = active?.series.some(item => item.points.length);
  const total = data?.sessionsPerDay.reduce((sum, day) => sum + day.count, 0) ?? 0;

  return <section id="adm-ops" className="admin-ops" aria-labelledby="admin-ops-heading">
    <div className="section-heading">
      <div><h2 id="admin-ops-heading">{t('ui.9641cd43bf2d')}</h2><p>{t('ui.fabbaaa3283b')}</p></div>
    </div>
    {error && <div className="banner-error" role="alert"><Icon name="alert" size={18} /><span>{localizeText(error)}</span><button type="button" onClick={() => void load()}>{t('ui.5189135a6110')}</button></div>}
    {!data && !error && <div className="loading-box">{t('ui.162340de56f8')}</div>}
    {data && <>
      <div className="ops-cards">
        <div className="ops-card"><span>{t('ui.140b78c4bf38')}</span><strong>{numberLabel(total)}</strong></div>
        <div className="ops-card"><span>{t('ops.avgDuration')}</span><strong>{formatDuration(data.duration.avgSeconds)}</strong></div>
        <div className={'ops-card' + (data.failures.last14d ? ' bad' : '')}><span>{t('ui.22b700067e3d')}</span><strong>{numberLabel(data.failures.last14d)}</strong></div>
      </div>

      <div className="ops-panels">
        <section className="ops-panel" aria-labelledby="ops-slot-heading">
          <div className="ops-panel-head">
            <h3 id="ops-slot-heading">{t('ui.80384178a7df')}</h3>
            <div className="ops-switch" role="group" aria-label={t('ui.e97ca72e2ca5')}>
              <button type="button" className={range === '24h' ? 'selected' : ''} aria-pressed={range === '24h'} onClick={() => setRange('24h')}>{t('ui.7941488fa3af')}</button>
              <button type="button" className={range === '14d' ? 'selected' : ''} aria-pressed={range === '14d'} onClick={() => setRange('14d')}>{t('ui.7e08a2ca839e')}</button>
            </div>
          </div>
          <p className="ops-chart-note">{active?.bucketMinutes === 120 ? t('ui.46ba3b9fbd21') : t('ui.6abc26ec5b23', { p0: numberLabel(active?.bucketMinutes ?? 15) })}</p>
          {active && usedSeries.length > 0
            ? <UtilizationChart key={range} series={usedSeries} range={range} bucketMinutes={active.bucketMinutes} now={Date.parse(data.generatedAt)} />
            : <div className="ops-empty">{t(hasSamples ? 'ops.slotsIdle' : 'ops.noSamples')}</div>}
        </section>

        <section className="ops-panel" aria-labelledby="ops-daily-heading">
          <div className="ops-panel-head"><h3 id="ops-daily-heading">{t('ui.03073cee43b5')}</h3></div>
          <p className="ops-chart-note">{t('ops.dailyNote')}</p>
          {total > 0 ? <DayBars key={data.generatedAt} days={data.sessionsPerDay} /> : <div className="ops-empty">{t('ui.df1559e1dabe')}</div>}
        </section>
      </div>

      {data.topUsers.length > 0 && <section className="ops-panel ops-activity" aria-labelledby="ops-activity-heading">
        <div className="ops-panel-head"><h3 id="ops-activity-heading">{t('ui.8ee0e0006443')}</h3><span className="ops-note">{t('ops.activityNote')}</span></div>
        <ol className="ops-users">
          {data.topUsers.map((user, index) => <li key={index}>
            <bdi>{user.username}</bdi>
            <span>{t('ops.dayCount', { p0: numberLabel(user.sessions) })}</span>
            <span>{formatDuration(user.minutes * 60)}</span>
          </li>)}
        </ol>
      </section>}
    </>}
  </section>;
}
