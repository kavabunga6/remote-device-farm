import { createPollingTask } from './polling-task';
import { localizeText, t } from './i18n';
import { useEffect, useState } from 'react';
import { QUEUE_CHANGED_EVENT, expiresIn, notifyQueueChanged, queueApi, type QueueEntry } from './queue-api';
import './Queue.css';

// Waiting list for a free slot, shown on the overview page. Hidden when the user waits for nothing.
export function QueueWidget() {
  const [entries, setEntries] = useState<QueueEntry[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');

  useEffect(() => {
    const task = createPollingTask(signal => queueApi.list(signal), result => setEntries(result.entries));
    const changed = () => { void task.refresh(); };
    void task.run();
    const timer = window.setInterval(() => void task.run(), 5000);
    window.addEventListener(QUEUE_CHANGED_EVENT, changed);
    return () => { task.dispose(); window.clearInterval(timer); window.removeEventListener(QUEUE_CHANGED_EVENT, changed); };
  }, []);

  const cancel = async (id: string) => {
    setBusy(id); setError('');
    try { await queueApi.leave(id); setEntries(current => current.filter(entry => entry.id !== id)); notifyQueueChanged(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : t('ui.58c1736eb34e')); }
    finally { setBusy(''); }
  };

  if (!entries.length) return null;
  return <section className="queue-widget" aria-label={t('ui.b3fbd787797b')}>
    <div className="queue-widget-head"><h2>{t('ui.e85aa58ee835')}</h2><small>{t('ui.94c70001e686')}</small></div>
    {error && <div className="banner-error queue-error" role="alert"><span>{localizeText(error)}</span></div>}
    <ul className="queue-list">
      {entries.map(entry => {
        const left = expiresIn(entry.expiresAt);
        return <li className="queue-item" key={entry.id}>
          <span className="queue-pos" title={t('ui.8215229c1aae')}>{entry.position}</span>
          <div className="queue-info">
            <strong>{entry.profileName}{entry.label ? ` · ${entry.label}` : ''}</strong>
            <small>{entry.hostName ? t('ui.66bda389f3a5', { p0: entry.hostName }) : t('ui.604edea0f97c')}{left ? t('ui.24021e128fea', { p0: left }) : ''}</small>
          </div>
          <button type="button" className="button outline" disabled={busy === entry.id} onClick={() => void cancel(entry.id)}>{busy === entry.id ? t('ui.4ba8a8d87b3e') : t('ui.7c47f7292ba4')}</button>
        </li>;
      })}
    </ul>
  </section>;
}
