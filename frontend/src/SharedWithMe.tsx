import { t } from './i18n';
import { useCallback, useEffect, useState } from 'react';
import { shareApi, type SharedWithMeEntry, type ShareMode } from './share-api';

import './SharedWithMe.css';

const MODE_LABEL: Record<ShareMode, string> = { get view() { return t('ui.f1163738deb5'); }, get control() { return t('ui.a4bba03c40fd'); } };

export function remainingLabel(expiresAt: string, now = Date.now()): string {
  const minutes = Math.ceil((new Date(expiresAt).getTime() - now) / 60_000);
  if (minutes <= 0) return t('ui.60de6aaf9933');
  if (minutes < 60) return t('ui.58c080201404', { p0: minutes });
  return t('ui.faa0e58ad32b', { p0: Math.floor(minutes / 60), p1: minutes % 60 });
}

// Sessions colleagues shared with the user. Hidden when there are none.
export function SharedWithMe() {
  const [entries, setEntries] = useState<SharedWithMeEntry[]>([]);
  const load = useCallback(async () => {
    try { setEntries(await shareApi.mine()); } catch { /* Keep the last list. */ }
  }, []);
  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 30_000);
    return () => window.clearInterval(timer);
  }, [load]);

  if (!entries.length) return null;
  return <section className="shared-with-me" aria-label={t('ui.339537295211')}>
    <div className="shared-with-me-head"><h2>{t('ui.339537295211')}</h2><small>{t('ui.d5d752d74fe7')}</small></div>
    <ul className="shared-with-me-list">
      {entries.map(entry => {
        const canOpen = new Date(entry.expiresAt).getTime() > Date.now();
        const name = entry.profileName + (entry.label ? ` · ${entry.label}` : '');
        return <li key={entry.sessionId + entry.expiresAt}><article className={'shared-with-me-item' + (canOpen ? ' interactive-card' : '')}>
          <div className="shared-with-me-info">
            <strong>{canOpen ? <a className="card-primary-action" href={`#/session/${encodeURIComponent(entry.sessionId)}`} aria-label={t('ui.52cfccb2699c', { p0: name, p1: entry.ownerName })}>{name}</a> : name}</strong>
            <small>{entry.ownerName} · {MODE_LABEL[entry.mode]} · {remainingLabel(entry.expiresAt)}</small>
          </div>

        </article></li>;
      })}
    </ul>
  </section>;
}
