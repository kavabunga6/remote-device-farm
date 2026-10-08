import { localizeText, t } from './i18n';
import { useEffect, useRef, useState } from 'react';
import { Icon } from './icons';
import { ActivityIndicator } from './ActivityIndicator';
import type { AppNotification } from './notifications';

export function AppToast({ notification, onClose }: { notification: AppNotification; onClose: () => void }) {
  const { id, kind, title, message, messagePrefix, details, action, revision, pending } = notification;
  const [expanded, setExpanded] = useState(false);
  const [paused, setPaused] = useState(false);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    if (kind === 'error' || pending || paused || expanded) return;
    const timer = window.setTimeout(() => close.current(), 6000);
    return () => window.clearTimeout(timer);
  }, [kind, revision, pending, paused, expanded]);
  return <article className={`toast notification-toast notification-${kind}`} data-notification-id={id}
    onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)}
    onFocusCapture={() => setPaused(true)} onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget)) setPaused(false); }}>
    {pending ? <ActivityIndicator /> : <Icon name={kind === 'error' ? 'alert' : kind === 'success' ? 'check' : 'info'} size={19} />}
    <div className="notification-content">
      <div role={kind === 'error' ? 'alert' : 'status'} aria-atomic="true">
        <strong className="notification-title">{localizeText(title)}</strong>
        {(messagePrefix || message) && <p className="notification-message">{messagePrefix && localizeText(messagePrefix)}{messagePrefix && message ? '. ' : ''}{message && localizeText(message)}</p>}
      </div>
      {action && <a className="notification-details-toggle" href={action.href}>{localizeText(action.label)}</a>}
      {details && <><button type="button" className="notification-details-toggle" aria-expanded={expanded} aria-controls={`${id}-details`} onClick={() => setExpanded(value => !value)}>{expanded ? t('ui.d9672d2eb836') : t('ui.0fefbd67d833')}</button>
        {expanded && <pre id={`${id}-details`} className="notification-details" tabIndex={0} aria-label={t('ui.85dcf639a545')}>{details}</pre>}</>}
    </div>
    <button type="button" className="notification-close" aria-label={t('ui.9c3076d2e159', { p0: localizeText(title) })} onClick={onClose}><Icon name="close" size={17} /></button>
  </article>;
}
