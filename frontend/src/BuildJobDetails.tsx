import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { getLocale, t } from './i18n';
import { imagesApi, type BuildJob } from './images-api';
import { Icon } from './icons';

export const activeBuild = (job: BuildJob) => ['queued', 'building', 'validating', 'pushing', 'cancelling'].includes(job.state);
const elapsed = (now: number, at?: string | null) => at && Number.isFinite(Date.parse(at)) ? Math.max(0, now - Date.parse(at)) : null;
const duration = (ms: number) => {
  const seconds = Math.floor(ms / 1000);
  return (seconds >= 3600 ? Math.floor(seconds / 3600) + ':' : '') + String(Math.floor(seconds / 60) % 60).padStart(2, '0') + ':' + String(seconds % 60).padStart(2, '0');
};
function relative(now: number, at: string) {
  const seconds = Math.floor((elapsed(now, at) ?? 0) / 1000);
  const unit = seconds >= 3600 ? 'hour' : seconds >= 60 ? 'minute' : 'second';
  return new Intl.RelativeTimeFormat(getLocale(), { numeric: 'auto' }).format(-Math.floor(seconds / (unit === 'hour' ? 3600 : unit === 'minute' ? 60 : 1)), unit);
}

export function BuildJobDetails({ job, builderId, now, unconfirmed, expanded, onExpanded, queuePosition }: {
  job: BuildJob; builderId: string; now: number; unconfirmed: boolean; expanded: boolean; onExpanded: (open: boolean) => void; queuePosition: number;
}) {
  const active = activeBuild(job), finish = job.finishedAt ? Date.parse(job.finishedAt) : NaN, end = Number.isFinite(finish) ? finish : now;
  const runningFor = elapsed(end, job.startedAt ?? job.createdAt);
  const quiet = active && job.state !== 'queued' && !unconfirmed && (elapsed(now, job.lastLogAt ?? job.startedAt) ?? 0) >= 120_000;
  const lastLine = job.log?.at(-1);
  return <div className="catalog-build-detail" data-quiet={quiet || undefined}>
    <div className="catalog-build-metrics" aria-live="off">
      {job.state === 'queued' && queuePosition > 0 ? <span>{t('build.queuePosition', { position: queuePosition })}</span>
        : runningFor !== null && <span>{t('catalog.elapsed', { p0: duration(runningFor) })}</span>}
      {job.lastLogAt && <span>{t('build.lastOutput', { time: relative(active ? now : end, job.lastLogAt) })}</span>}
      {job.state === 'building' && job.stage === 'building' && job.checkedAt && <span>{t('build.processChecked', { time: relative(now, job.checkedAt) })}</span>}
      {job.progress?.steps && job.stage === 'building' ? <span>{t('build.step', { step: job.progress.step, total: job.progress.steps })}</span> : null}
    </div>
    {quiet && <p className="catalog-build-warning"><Icon name="alert" size={16}/><span>{t('build.quiet')}</span></p>}
    {!expanded && lastLine && <p className="catalog-build-last-line" dir="ltr" title={lastLine}>{lastLine}</p>}
    <details className="catalog-build-log" open={expanded} onToggle={event => {
      const open = event.currentTarget.open; if (open !== expanded) onExpanded(open);
    }}>
      <summary><Icon name="terminal" size={16}/><span>{t('build.log')}</span><Icon name="arrowDown" size={14}/></summary>
      {expanded && <BuildLog job={job} builderId={builderId}/>}
    </details>
  </div>;
}

function BuildLog({ job, builderId }: { job: BuildJob; builderId: string }) {
  const [snapshot, setSnapshot] = useState(job), [failed, setFailed] = useState(false), [retry, setRetry] = useState(0);
  const pre = useRef<HTMLPreElement>(null), follow = useRef(true);
  const active = activeBuild(job);
  useEffect(() => {
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await imagesApi.buildJob(job.id, builderId, controller.signal);
        if (controller.signal.aborted) return;
        const found = next.jobs.find(item => item.id === job.id);
        if (!found) throw Error('invalid_build_snapshot');
        setSnapshot(found); setFailed(false);
      } catch { if (!controller.signal.aborted) setFailed(true); }
      if (!controller.signal.aborted && active) timer = setTimeout(() => void poll(), 4000);
    };
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [job.id, builderId, active, retry]);
  const text = snapshot.log?.join('\n') ?? '';
  useLayoutEffect(() => { if (follow.current && pre.current) pre.current.scrollTop = pre.current.scrollHeight; }, [text]);
  return <div className="catalog-build-log-body">
    <div className="catalog-build-log-meta">
      <span>{t('build.logTail', { count: snapshot.log?.length ?? 0 })}</span>
      {job.startedAt && Number.isFinite(Date.parse(job.startedAt)) && <span>{t('networkInspector.started')}: <time dateTime={job.startedAt}>{new Intl.DateTimeFormat(getLocale(), { dateStyle: 'short', timeStyle: 'medium' }).format(new Date(job.startedAt))}</time></span>}
    </div>
    {failed && <div className="catalog-build-log-failure" role="alert"><span>{t('build.logUnavailable')}</span><button type="button" className="button outline small" onClick={() => setRetry(value => value + 1)}><Icon name="refresh" size={15}/>{t('ui.5189135a6110')}</button></div>}
    {text ? <pre ref={pre} tabIndex={0} dir="ltr" aria-label={t('build.log')} onScroll={event => {
      const element = event.currentTarget; follow.current = element.scrollHeight - element.scrollTop - element.clientHeight < 32;
    }}>{text}</pre> : <p className="catalog-build-empty-log">{t('build.emptyLog')}</p>}
  </div>;
}
