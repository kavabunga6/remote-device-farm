import { getLocale, localizeText, t } from './i18n';
import { useState } from 'react';
import type { DeviceSession, Host } from './api';
import { Icon } from './icons';
import { journalCopyText, technicalFields, type JournalDate, type JournalDetail } from './journal-details';
import { useAdminDialog } from './useAdminDialog';

const calendarDate = new Intl.DateTimeFormat(getLocale(), { day: 'numeric', month: 'short', year: 'numeric' });
const clockTime = new Intl.DateTimeFormat(getLocale(), { hour: '2-digit', minute: '2-digit', second: '2-digit' });

function EventDate({ field }: { field: JournalDate }) {
  const date = field.value ? new Date(field.value) : null;
  return <div><dt>{field.label}</dt><dd>{date && !Number.isNaN(date.getTime())
    ? <time dateTime={field.value!}><span>{clockTime.format(date)}</span><small>{calendarDate.format(date)}</small></time>
    : <span className="journal-date-empty">{field.emptyLabel || t('ui.6d8e839d9f67')}</span>}</dd></div>;
}

export function JournalEventDetails({ detail, hosts, sessions, onClose }: { detail: JournalDetail; hosts: Host[]; sessions: DeviceSession[]; onClose: () => void }) {
  const dialog = useAdminDialog(true, false, onClose);
  const [copyState, setCopyState] = useState('');
  const host = hosts.find(item => item.id === detail.hostId);
  const liveSession = !detail.sessionEnded && sessions.find(item => item.id === detail.sessionId);
  const fields = technicalFields(detail);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(journalCopyText(detail));
      setCopyState(t('ui.3fcb319fb6ab'));
    } catch { setCopyState(t('ui.b1bde0977fc6')); }
  };
  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="modal journal-event-dialog" ref={dialog} role="dialog" aria-modal="true" aria-labelledby="journal-event-title" tabIndex={-1}>
      <header className="journal-event-heading">
        <div><p className="journal-event-category">{detail.category}</p><h2 id="journal-event-title">{detail.title}</h2></div>
        <button className="icon-button" type="button" aria-label={t('ui.b9cba570060f')} onClick={onClose}><Icon name="close" size={20} /></button>
      </header>
      <div className="journal-event-body">
        <span className={'journal-event-badge is-' + detail.badge.tone}><span aria-hidden="true" />{detail.badge.label}</span>
        <dl className="journal-event-summary">{detail.summary.filter(([, value]) => value != null && value !== '').map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
        <dl className="journal-event-dates">{detail.dates.map(field => <EventDate key={field.label} field={field} />)}</dl>
        {fields.length > 0 && <details className="journal-event-technical">
          <summary tabIndex={0}><Icon name="chevronDown" size={16} /><span>{t('ui.cb1ec12927ad')}</span></summary>
          <dl className="journal-event-fields">{fields.map(([label, value]) => <div key={label}><dt>{label}</dt><dd><code>{value}</code></dd></div>)}</dl>
        </details>}
      </div>
      <footer className="journal-event-footer">
        <div className="journal-event-actions">
          {host && <a className="button outline" href={'#/admin/nodes?host=' + encodeURIComponent(host.id)} onClick={onClose}><Icon name="server" size={16} />{t('ui.9ba4b774c962')}</a>}
          {detail.sessionId && <a className="button outline" href={'#/admin/journal?tab=logs&session=' + encodeURIComponent(detail.sessionId)} onClick={onClose}>{t('ui.102c44d966fa')}</a>}
          {liveSession && <a className="button outline" href={'#/session/' + encodeURIComponent(liveSession.id)} onClick={onClose}><Icon name="phone" size={16} />{t('ui.76e6c474e686')}</a>}
          <button className="button outline journal-event-copy" type="button" onClick={() => void copy()}><Icon name="copy" size={16} />{t('ui.5d7779547181')}</button>
        </div>
        {copyState && <p className="journal-copy-state" role="status">{localizeText(copyState)}</p>}
      </footer>
    </div>
  </div>;
}
