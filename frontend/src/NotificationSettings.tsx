import { useAccess } from './permissions';
import { createPollingTask } from './polling-task';
import { localizeText, t } from './i18n';
import { Icon } from './icons';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  EVENT_LABELS, browserNotificationsEnabled, freshNotifications, queueApi, setBrowserNotifications,
  type NotificationKind, type Webhook, type AppNotification,
} from './queue-api';
import './Queue.css';

const ALL_EVENTS = Object.keys(EVENT_LABELS) as NotificationKind[];

// Polls unread notifications every 10 s, shows a toast and, when enabled, a browser notification.
export function useNotificationPoller(ownerId: string | undefined, onToast: (notification: AppNotification) => void): void {
  const toast = useRef(onToast);
  toast.current = onToast;
  useEffect(() => {
    if (!ownerId) return;
    const seen = new Set<string>();
    const task = createPollingTask(signal => queueApi.notifications(signal), async ({ notifications }, signal) => {
      if (!notifications.length) return;
      const fresh = freshNotifications(notifications, seen);
      for (const item of notifications) {
        seen.add(item.id);
        if (seen.size > 5000) seen.delete(seen.values().next().value!);
      }
      for (const item of fresh) toast.current(item);
      if (browserNotificationsEnabled()) {
        for (const item of fresh) {
          try { new Notification(localizeText(item.title), { body: localizeText(item.body), tag: item.id }); } catch { /* unsupported context */ }
        }
      }
      await queueApi.markRead(notifications.map(item => item.id), signal);
    });
    void task.run();
    const timer = window.setInterval(() => void task.run(), 10_000);
    return () => { task.dispose(); window.clearInterval(timer); seen.clear(); };
  }, [ownerId]);
}

function statusLabel(hook: Webhook): { text: string; tone: string } {
  if (!hook.lastStatus) return { text: t('ui.073a55b21ee2'), tone: '' };
  return hook.lastStatus === 'ok' ? { text: t('ui.6461f9e02d4f'), tone: 'good' } : { text: t('ui.169ff80192a8'), tone: 'bad' };
}

function EventPicker({ value, onChange, disabled }: { value: NotificationKind[]; onChange: (next: NotificationKind[]) => void; disabled?: boolean }) {
  return <>{ALL_EVENTS.map(kind => <label key={kind}>
    <input type="checkbox" checked={value.includes(kind)} disabled={disabled}
      onChange={event => onChange(event.target.checked ? [...value, kind] : value.filter(item => item !== kind))} />
    {EVENT_LABELS[kind]}
  </label>)}</>;
}

// Per-user notification settings: browser notifications and webhooks.
export function NotificationSettings() {
  const can = useAccess();
  const webhooksAllowed = can('tokens.personal');
  const supported = typeof Notification !== 'undefined';
  const [browserOn, setBrowserOn] = useState(browserNotificationsEnabled);
  const [permission, setPermission] = useState<string>(supported ? Notification.permission : 'denied');
  const [hooks, setHooks] = useState<Webhook[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [url, setUrl] = useState('');
  const [secret, setSecret] = useState('');
  const [events, setEvents] = useState<NotificationKind[]>(ALL_EVENTS);
  const [created, setCreated] = useState<string | null>(null);
  const [busy, setBusy] = useState('');

  const load = useCallback(async () => {
    if (!webhooksAllowed) { setLoading(false); return; }
    try { setHooks((await queueApi.webhooks()).webhooks); setError(''); }
    catch (cause) { setError(cause instanceof Error ? cause.message : t('ui.427a57ee5f6f')); }
    finally { setLoading(false); }
  }, [webhooksAllowed]);
  useEffect(() => { void load(); }, [load]);

  const toggleBrowser = async () => {
    if (browserOn) { setBrowserNotifications(false); setBrowserOn(false); return; }
    let result: string = supported ? Notification.permission : 'denied';
    if (supported && result === 'default') result = await Notification.requestPermission();
    setPermission(result);
    if (result === 'granted') { setBrowserNotifications(true); setBrowserOn(true); }
  };

  const run = async (key: string, action: () => Promise<void>) => {
    setBusy(key); setError(''); setNotice('');
    try { await action(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : t('ui.fe9e2bd0ddfa')); }
    finally { setBusy(''); }
  };

  const add = (event: React.FormEvent) => {
    event.preventDefault();
    void run('add', async () => {
      const hook = await queueApi.createWebhook({ url: url.trim(), secret: secret.trim() || undefined, events });
      setCreated(hook.secret); setUrl(''); setSecret(''); await load();
    });
  };

  return <section className="settings-card notify-card" aria-labelledby="notify-heading" style={{ marginTop: 15 }}>
    <div className="settings-card-title"><h2 id="notify-heading">{t('ui.d4baf8f6b173')}</h2><p>{t('ui.0dfd8592ad56')}</p></div>
    <div className="notify-row">
      <p>{!supported ? t('ui.94a79512535f') : permission === 'denied' ? t('ui.b97039aab343') : t('ui.fbf1f9e36f0d')}</p>
      <button type="button" className="button outline" onClick={() => void toggleBrowser()} disabled={!supported || permission === 'denied'}>{browserOn ? t('ui.eda262ba056c') : t('ui.8a121361c64c')}</button>
    </div>

    {webhooksAllowed && <>
    <h3 className="notify-sub">{t('ui.03e2d261f8e8')}</h3>
    <p className="settings-hint">{t('ui.4223956e411e')}</p>
    {error && <div className="banner-error queue-error" role="alert"><span>{localizeText(error)}</span></div>}
    {notice && <p className="settings-hint" role="status">{localizeText(notice)}</p>}
    {created && <div className="webhook-secret" role="status"><strong>{t('ui.0b24603cf4ed')}</strong><code>{created}</code><small>{t('ui.0e8adde76a4e')}</small>
      <button type="button" className="button outline" onClick={() => setCreated(null)}>{t('ui.c6939986babd')}</button></div>}
    {loading ? <p className="settings-hint">{t('ui.22a5d9112486')}</p> : <ul className="webhook-list">
      {hooks.map(hook => {
        const status = statusLabel(hook);
        return <li className="webhook-item" key={hook.id}>
          <div className="webhook-item-top">
            <span className="webhook-url" title={hook.url}>{hook.url}</span>
            <span className={`webhook-status ${status.tone}`}>{hook.enabled ? status.text : t('ui.5a577d905660')}</span>
          </div>
          <div className="webhook-events"><EventPicker value={hook.events} disabled={busy === hook.id}
            onChange={next => { if (next.length) void run(hook.id, async () => { await queueApi.updateWebhook(hook.id, { events: next }); await load(); }); }} /></div>
          <div className="row-actions">
            <button type="button" className="button outline" disabled={busy === hook.id} onClick={() => void run(hook.id, async () => {
              const result = await queueApi.testWebhook(hook.id);
              setNotice(result.ok ? t('ui.9f9a43d66b03') : t('ui.a1203fae6d19', { p0: result.error ?? (result.status ? t('copy.NotificationSettings.d0a5178d', { p0: result.status }) : t('ui.6947861c68c9')) }));
              await load();
            })}>{t('ui.e4424a6df6f6')}</button>
            <button type="button" className="button outline" disabled={busy === hook.id} onClick={() => void run(hook.id, async () => { await queueApi.updateWebhook(hook.id, { enabled: !hook.enabled }); await load(); })}>{hook.enabled ? t('ui.eda262ba056c') : t('ui.a54eaf37858d')}</button>
            <button type="button" className="icon-button danger-icon" aria-label={t('ui.dd4a6f09a207')} title={t('ui.be99b1361201')} disabled={busy === hook.id} onClick={() => void run(hook.id, async () => { await queueApi.deleteWebhook(hook.id); await load(); })}><Icon name="trash" size={17} /></button>
          </div>
        </li>;
      })}
    </ul>}
    <form className="settings-form webhook-form" onSubmit={add}>
      <label>{t('ui.cada9d6cb885')}<input type="url" value={url} onChange={event => setUrl(event.target.value)} placeholder={t('ui.3c56c98688a3')} required maxLength={2000} /></label>
      <label>{t('ui.fbdceef1949c')}<input type="text" value={secret} onChange={event => setSecret(event.target.value)} placeholder={t('ui.a83f0a9edc85')} minLength={8} maxLength={200} autoComplete="off" /></label>
      <fieldset><legend>{t('ui.210d9860bdff')}</legend><EventPicker value={events} onChange={setEvents} /></fieldset>
      <button type="submit" className="button primary" disabled={busy === 'add' || !url.trim() || !events.length}>{busy === 'add' ? t('ui.5637cb987056') : t('ui.27cfc4c16e32')}</button>
    </form></>}
  </section>;
}
