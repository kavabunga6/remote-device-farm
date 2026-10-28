import { useEffect, useState } from 'react';
import { imagesApi, type CatalogStatus } from './images-api';
import { localizeText, t, type MessageKey } from './i18n';
import { ActivityIndicator } from './ActivityIndicator';
import { Icon } from './icons';

export function CatalogLoading() {
  const [status, setStatus] = useState<CatalogStatus | null>(null);
  const [connectionFailed, setConnectionFailed] = useState(false);
  const [started] = useState(Date.now), [now, setNow] = useState(Date.now), [contact, setContact] = useState<number | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await imagesApi.catalogStatus(controller.signal);
        if (controller.signal.aborted) return;
        setStatus(next); setConnectionFailed(false);
        if (!['offline', 'unconfigured'].includes(next.phase)) setContact(Date.now());
      } catch {
        if (controller.signal.aborted) return;
        setConnectionFailed(true);
      }
      if (!controller.signal.aborted) timer = setTimeout(() => void poll(), 3000);
    };
    void poll();
    const clock = setInterval(() => setNow(Date.now()), 1000);
    return () => { controller.abort(); clearTimeout(timer); clearInterval(clock); };
  }, []);
  const phase = connectionFailed ? 'connection_lost' : status?.phase ?? 'connecting';
  const elapsed = Math.max(0, Math.floor((now - started) / 1000));
  const duration = `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')}`;
  const since = (at: number) => Math.max(0, Math.floor((now - at) / 1000));
  const updated = status?.updatedAt ? Date.parse(status.updatedAt) : NaN;
  const failure = ['connection_lost', 'offline', 'failed'].includes(phase);
  return <section className="catalog-loading" data-phase={phase} aria-label={t('catalog.loading')}>
    <div className={'catalog-loading-symbol' + (failure ? ' is-warning' : '')}>{failure ? <Icon name="alert" size={26}/> : <ActivityIndicator />}</div>
    <h3 role="status" aria-live="polite">{t(('catalog.' + phase) as MessageKey)}</h3>
    <p>{t(('catalog.' + phase + 'Hint') as MessageKey)}</p>
    {phase === 'preparing_tools' && status?.progress && <div className="catalog-loading-progress">
      {status.progress.steps > 0 && <span>{t('catalog.step', { p0: status.progress.step, p1: status.progress.steps })}</span>}
      {status.progress.percent !== null && <span>{t('catalog.downloadPercent', { p0: status.progress.percent })}</span>}
    </div>}
    {phase === 'fetching' && elapsed >= 60 && <p className="catalog-loading-wait">{t('catalog.longWait')}</p>}
    <div className="catalog-loading-metrics" aria-live="off"><div><span>{t('catalog.elapsed', { p0: duration })}</span></div>
      {status?.builder && <div><span>{status.builder.name}</span></div>}
      {contact !== null && <div><span>{t('catalog.lastContact', { p0: since(contact) })}</span></div>}
      {Number.isFinite(updated) && <div><span>{t('catalog.lastProgress', { p0: since(updated) })}</span></div>}
    </div>
  </section>;
}

export function CatalogLoadFailure({ error, onRetry }: { error: string; onRetry: () => void }) {
  return <section className="catalog-loading catalog-load-failure">
    <div className="catalog-loading-symbol is-warning"><Icon name="alert" size={26}/></div>
    <h3>{t('catalog.failed')}</h3><p role="alert">{localizeText(error)}</p><p>{t('catalog.loadFailureHint')}</p>
    <button type="button" className="button outline" onClick={onRetry}><Icon name="refresh" size={16}/>{t('catalog.retry')}</button>
  </section>;
}
