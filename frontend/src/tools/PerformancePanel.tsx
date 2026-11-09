import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { apiRequest } from '../api';
import { downloadFile } from '../browser-files';
import { getLocale, localizeText, t } from '../i18n';
import { Icon } from '../icons';
import { useAdminDialog } from '../useAdminDialog';
import { AndroidProcessMonitor, PROCESS_INTERVALS, type ProcessInterval, type ProcessSnapshot } from './AndroidProcessMonitor';
import { bytes, formatTime, number, percent } from './performance-format';
import { usePerformancePolling, usePerformanceVisibility } from './usePerformancePolling';
import './PerformancePanel.css';

type Sample = {
  sampledAt: string;
  cpuCores: number | null;
  throttlePercent: number | null;
  memoryBytes: number | null;
  memoryWorkingSetBytes?: number | null;
  memoryLimitBytes: number | null;
  readBytesPerSecond: number | null;
  writeBytesPerSecond: number | null;
};
type Crash = {
  reason: 'oom' | 'exit' | 'lost' | 'startup';
  occurredAt: string | null;
  exitCode: number | null;
  oomKilled: boolean | null;
  lastSample: Sample | null;
  logs: string[];
};

function SampleValues({ sample }: { sample: Sample }) {
  return <dl className="performance-values">
    <div><dt>{t('performance.cpuCores')}</dt><dd><bdi>{number(sample.cpuCores)}</bdi></dd></div>
    <div><dt>{t('performance.throttle')}</dt><dd><bdi>{percent(sample.throttlePercent)}</bdi></dd></div>
    <div><dt>{t(sample.memoryWorkingSetBytes == null ? 'ui.397211640533' : 'performance.memoryWorkingSet')}</dt>
      <dd><bdi>{bytes(sample.memoryWorkingSetBytes ?? sample.memoryBytes)} / {bytes(sample.memoryLimitBytes)}</bdi></dd></div>
    <div><dt>{t('performance.disk')}</dt><dd><bdi>{bytes(sample.readBytesPerSecond, true)} / {bytes(sample.writeBytesPerSecond, true)}</bdi></dd></div>
  </dl>;
}

const crashReason = { oom: 'performance.oom', exit: 'performance.exited', lost: 'performance.lost', startup: 'performance.startupFailed' } as const;
const PROCESS_INTERVAL_KEY = 'rdf.process-update-interval';

function readProcessInterval(): ProcessInterval {
  try {
    const saved = Number(localStorage.getItem(PROCESS_INTERVAL_KEY));
    return PROCESS_INTERVALS.find(seconds => seconds === saved) ?? 6;
  } catch {
    return 6;
  }
}

function describeError(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

export function PerformancePanel({ sessionId, active, running, ended }: {
  sessionId: string; active: boolean; running: boolean; ended: boolean;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const manual = useRef<AbortController | null>(null);
  const [trace, setTrace] = useState<Blob | null>(null);
  const [recording, setRecording] = useState(false);
  const [captureError, setCaptureError] = useState('');
  const [paused, setPaused] = useState(false);
  const [interval, setInterval] = useState(readProcessInterval);
  const base = '/sessions/' + encodeURIComponent(sessionId) + '/performance';
  const visible = usePerformanceVisibility(panel, active && running);
  const loadContainer = useCallback((signal: AbortSignal) =>
    apiRequest<{ sample: Sample }>(base, { signal, timeoutMs: 7500 }), [base]);
  const loadProcesses = useCallback((signal: AbortSignal) =>
    apiRequest<ProcessSnapshot>(base + '/processes', { method: 'POST', signal, timeoutMs: 7500 }), [base]);
  const container = usePerformancePolling(loadContainer, visible);
  const sampling = visible && !paused && !recording;
  const processes = usePerformancePolling(loadProcesses, sampling, interval * 1000);
  const sample = container.data?.sample;

  useEffect(() => () => manual.current?.abort(), []);

  function changeInterval(value: ProcessInterval) {
    setInterval(value);
    try { localStorage.setItem(PROCESS_INTERVAL_KEY, String(value)); } catch { /* Optional preference. */ }
  }

  async function captureTrace() {
    if (manual.current || !running) return;
    const controller = new AbortController();
    manual.current = controller;
    setRecording(true);
    setCaptureError('');
    try {
      await processes.settle();
      controller.signal.throwIfAborted();
      const result = await apiRequest<Blob>(base + '/trace', { method: 'POST', signal: controller.signal, timeoutMs: 60_000, responseType: 'blob' });
      if (!controller.signal.aborted) setTrace(result);
    } catch (error) {
      if (!controller.signal.aborted) setCaptureError(describeError(error, t('performance.traceUnavailable')));
    } finally {
      manual.current = null;
      if (!controller.signal.aborted) setRecording(false);
    }
  }

  return <div ref={panel} id="tool-panel-performance" className="tool-content performance-panel" role="tabpanel"
    aria-labelledby="tool-tab-performance" style={active ? undefined : { display: 'none' }}>
    <section className="performance-section" aria-labelledby="performance-container">
      <header className="performance-section-header"><h3 id="performance-container">{t('performance.container')}</h3>
        {sample && <time dateTime={sample.sampledAt}>{formatTime(sample.sampledAt)}</time>}
      </header>
      {sample ? <SampleValues sample={sample} /> : <p>{running && !container.error ? t('ui.162340de56f8') : t('ui.76848548e29c')}</p>}
      {container.error != null && running && <p className="performance-error" role="alert">
        {localizeText(describeError(container.error, t('performance.containerUnavailable')))}
      </p>}
    </section>
    <AndroidProcessMonitor snapshot={processes.data} error={processes.error} running={running} paused={paused}
      sampling={sampling} interval={interval} onIntervalChange={changeInterval} onToggle={() => setPaused(value => !value)} />
    <section className="performance-section" aria-labelledby="performance-trace">
      <header className="performance-section-header"><h3 id="performance-trace">{t('performance.trace')}</h3>
        <button type="button" className="button subtle" disabled={!running || recording} onClick={() => void captureTrace()}>
          {t('performance.recordTrace', { p0: number(10) })}
        </button>
      </header>
      <p>{t('performance.traceHint')}</p>
      {recording && <p role="status">{t('performance.recording')}</p>}
      {captureError && <p className="performance-error" role="alert">{localizeText(captureError)}</p>}
      {trace && <button type="button" className="button subtle" onClick={() => downloadFile('android.perfetto-trace', trace)}>
        <Icon name="download" size={16} />{t('ui.535119bf3cc5')} <bdi>{bytes(trace.size)}</bdi>
      </button>}
    </section>
    <PerformanceCrash sessionId={sessionId} active={active && ended} ended={ended} />
  </div>;
}

function PerformanceCrash({ sessionId, active, ended, inDialog = false }: {
  sessionId: string; active: boolean; ended: boolean; inDialog?: boolean;
}) {
  const titleId = useId();
  const [crash, setCrash] = useState<Crash | null>(null);
  const [crashError, setCrashError] = useState('');
  const [crashLoading, setCrashLoading] = useState(active);
  const [crashRefresh, setCrashRefresh] = useState(0);
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    setCrashLoading(true);
    setCrashError('');
    void apiRequest<{ crash: Crash | null }>('/sessions/' + encodeURIComponent(sessionId) + '/performance/crash',
      { signal: controller.signal, timeoutMs: 7500 })
      .then(result => { if (!controller.signal.aborted) setCrash(result.crash); })
      .catch(error => { if (!controller.signal.aborted) setCrashError(describeError(error, t('performance.crashUnavailable'))); })
      .finally(() => { if (!controller.signal.aborted) setCrashLoading(false); });
    return () => controller.abort();
  }, [active, sessionId, crashRefresh]);
  const refreshButton = ended && <button type="button" className="button subtle" disabled={crashLoading} onClick={() => setCrashRefresh(value => value + 1)}>
    <Icon name="refresh" size={16} />{t('ui.603e460bf59c')}
  </button>;
  return <section className="performance-section" aria-labelledby={inDialog ? undefined : titleId}>
      {!inDialog && <header className="performance-section-header"><h3 id={titleId}>{t('performance.crash')}</h3>{refreshButton}</header>}
      {crashError && <p className="performance-error" role="alert">{localizeText(crashError)}</p>}
      {crash ? <>
        <p className="performance-error"><strong>{t(crashReason[crash.reason])}</strong></p>
        {crash.occurredAt && <time dateTime={crash.occurredAt}>
          {new Date(crash.occurredAt).toLocaleString(getLocale(), { dateStyle: 'medium', timeStyle: 'short' })}
        </time>}
        {crash.exitCode !== null && <p>{t('performance.exitCode', { p0: number(crash.exitCode) })}</p>}
        {crash.lastSample && <>
          <p>{t('performance.lastSample', { p0: formatTime(crash.lastSample.sampledAt) })}</p>
          <SampleValues sample={crash.lastSample} />
        </>}
        {crash.logs.length > 0 && <details><summary>{t('ui.102c44d966fa')}</summary><pre dir="ltr">{crash.logs.join('\n')}</pre></details>}
      </> : !crashError && <p>{crashLoading ? t('ui.ee945d237207') : t(ended ? 'performance.noCrash' : 'performance.crashHint')}</p>}
      {inDialog && refreshButton}
    </section>;
}

export function CrashSnapshotDialog({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
  const dialog = useAdminDialog(true, false, onClose);
  const titleId = useId();
  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="modal performance-crash-dialog" ref={dialog} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
      <header className="performance-section-header">
        <h2 id={titleId}>{t('performance.crash')}</h2>
        <button className="icon-button" type="button" aria-label={t('ui.b9cba570060f')} onClick={onClose}><Icon name="close" size={20} /></button>
      </header>
      <PerformanceCrash sessionId={sessionId} active ended inDialog />
    </div>
  </div>;
}
