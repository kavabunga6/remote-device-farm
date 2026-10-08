import { getLocale, localizeText, t } from './i18n';
import { useEffect, useRef, useState } from 'react';
import { settingsApi, type JournalFilters, type ServiceLogRecord } from './settings-api';

export function SessionDiagnosticLog({ filters }: { filters: JournalFilters }) {
  const [events, setEvents] = useState<ServiceLogRecord[]>([]);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const refresh = useRef<() => void>(() => {});
  useEffect(() => {
    let cancelled = false, inFlight = false, cursor: string | null = null;
    setEvents([]); setError(''); setBusy(true);
    const load = async () => {
      if (cancelled || inFlight) return;
      inFlight = true; setBusy(true);
      try {
        // Drain retained history in chronological pages; launch attempts are visible first.
        // Later polls request only new records instead of downloading container output again.
        for (let page = 0; page < 20 && !cancelled; page++) {
          const result = await settingsApi.sessionDiagnostics(cursor, filters);
          if (cancelled) return;
          cursor = result.nextCursor;
          if (result.events.length) setEvents(previous => [...previous, ...result.events]);
          setError('');
          if (!result.hasMore) break;
        }
      } catch (cause) { if (!cancelled) setError(cause instanceof Error ? cause.message : t('ui.8a335768c1c7')); }
      finally { inFlight = false; if (!cancelled) setBusy(false); }
    };
    refresh.current = () => void load();
    void load();
    const timer = window.setInterval(() => { if (!document.hidden) void load(); }, 5000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [filters]);
  return <section className="session-diagnostic" aria-labelledby="session-diagnostic-title">
    <div className="session-diagnostic-heading"><div><h3 id="session-diagnostic-title" title={filters.session}>{t('ui.9cebbf095972')}{filters.session?.slice(0, 8)}</h3><p>{t('ui.c3f1a3149855')}</p></div>
      <button type="button" className="button outline" onClick={() => refresh.current()} disabled={busy}>{t('ui.603e460bf59c')}</button></div>
    {error && <p className="inline-error" role="alert">{localizeText(error)}</p>}
    <div className="session-diagnostic-output" role="log" aria-label={t('ui.e21885ffe11f')} aria-live="off" aria-busy={busy}>
      {events.length ? events.map(item => <pre key={item.id} data-severity={item.severity}><time dateTime={item.occurredAt}>{new Date(item.occurredAt).toLocaleString(getLocale())}</time>{' [' + item.service + '/' + item.severity + '] ' + item.code + '\n' + (item.message || item.code)}</pre>) : <p>{busy ? t('ui.51b67feee945') : t('ui.5ce18685e4d0')}</p>}
    </div>
  </section>;
}
