import { getLanguage, isInterfaceMessage, localizeText, t } from './i18n';
import { useInterfaceLanguage } from './LanguageControl';
import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { AppToast } from './AppToast';
import './notifications.css';

export type NotificationInput = {
  kind: 'success' | 'info' | 'error';
  /** Keep explicit operation feedback visible until its result replaces it. */
  pending?: boolean;
  title: string;
  message?: string;
  /** Localized separately so persisted server text survives a language change. */
  messagePrefix?: string;
  details?: string;
  action?: { href: string; label: string };
  key?: string;
  /** Feedback for an explicit action in the currently open dialog. */
  allowInModal?: boolean;
};
export type AppNotification = NotificationInput & { id: string; revision: number; count: number };
type NotificationContext = {
  notify: (notification: NotificationInput) => void;
  notifyError: (title: string, error: unknown) => void;
  dismiss: (id: string) => void;
};
const NotificationsContext = createContext<NotificationContext | null>(null);
const MAX_NOTIFICATIONS = 5;
const MAX_DETAILS = 12_000;
const FOCUSABLE = 'button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex]:not([tabindex="-1"])';
const clip = (text: string, max: number) => text.length > max ? text.slice(0, max) + '…' : text;

/** Show an actionable explanation; keep command output and traces in the disclosure. */
export function describeNotificationError(error: unknown): { message: string; details?: string } {
  const raw = (typeof error === 'string' ? error : error instanceof Error ? error.message
    : error && typeof error === 'object' && 'message' in error ? String(error.message) : '').trim();
  const diagnostic = error && typeof error === 'object' && 'rawMessage' in error ? String(error.rawMessage || raw) : raw;
  const status = error && typeof error === 'object' && 'status' in error ? Number(error.status) : null;
  let message: string;
  if (/unknown package|package[^\n]*(?:not found|does not exist|is not installed)|no such package/i.test(diagnostic)) {
    message = t('ui.f55d00bb7fe2');
  } else if (/failed to fetch|networkerror|network request failed|load failed|fetch failed/i.test(diagnostic)) {
    message = t('ui.a1e91af3d477');
  } else if (status === 401) {
    message = t('ui.926ed929a495');
  } else if (status === 403) {
    message = t('ui.7a9c4e34a808');
  } else if (/device offline|device not found|no devices|agent_offline/i.test(diagnostic)) {
    message = t('ui.1f2763c487c3');
  } else if (/timed? ?out|timeout/i.test(diagnostic)) {
    message = t('ui.dd1d4d996d42');
  } else if ((error && typeof error === 'object' && 'rawMessage' in error) || isInterfaceMessage(raw)) {
    message = localizeText(raw);
  } else {
    message = t('ui.931a1703c76c');
  }
  if (!raw) return { message: t('ui.3b45c5594b30') };
  const technical = message === diagnostic ? undefined : error instanceof Error ? ('rawMessage' in error ? String(error.rawMessage || error.stack || raw) : error.stack || raw) : raw;
  return { message, ...(technical ? { details: clip(technical, MAX_DETAILS) } : {}) };
}

/** Keep a bounded stack without silently discarding older errors. */
function limitNotifications(items: AppNotification[]): AppNotification[] {
  if (items.length <= MAX_NOTIFICATIONS) return items;
  let removable = -1;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (items[index].kind !== 'error') { removable = index; break; }
  }
  if (removable >= 0) return limitNotifications(items.filter((_, index) => index !== removable));
  const overflow = items.slice(MAX_NOTIFICATIONS - 1);
  const count = overflow.reduce((sum, item) => sum + item.count, 0);
  const details = overflow.map(item => [item.title, item.messagePrefix, item.message, item.details].filter(Boolean).join('\n')).join('\n\n');
  return [...items.slice(0, MAX_NOTIFICATIONS - 1), {
    id: 'earlier-errors', key: 'earlier-errors', kind: 'error', revision: Date.now(), count,
    title: t('ui.3adab56a5b60'), message: t('ui.58798678ddc8', { p0: count }), details: clip(details, MAX_DETAILS),
  }];
}

export function NotificationsProvider({ children }: { children: ReactNode }) {
  useInterfaceLanguage();
  const [items, setItems] = useState<AppNotification[]>([]);
  const [modalTarget, setModalTarget] = useState<Element | null>(null);
  const [blocked, setBlocked] = useState(false);
  const nextId = useRef(0);
  const returnFocus = useRef<HTMLElement | null>(null);
  const restoreAfterDismiss = useRef(false);
  const dismiss = useCallback((id: string) => {
    const focusedToast = document.activeElement?.closest('[data-notification-id]');
    const restoreFocus = focusedToast?.getAttribute('data-notification-id') === id;
    restoreAfterDismiss.current = Boolean(restoreFocus);
    setItems(current => current.filter(item => item.id !== id));
  }, []);
  useLayoutEffect(() => {
    if (!restoreAfterDismiss.current) return;
    restoreAfterDismiss.current = false;
    // Restore focus in the same commit that removes the focused toast.
    const next = document.querySelector<HTMLElement>('.notification-stack .notification-close');
    const previous = returnFocus.current;
    const dialog = Array.from(document.querySelectorAll<HTMLElement>('[aria-modal="true"], dialog[open]'))
      .filter(element => element.getClientRects().length > 0).at(-1);
    if (next) next.focus();
    else if (previous?.isConnected && (!dialog || dialog.contains(previous))) previous.focus();
    else Array.from(dialog?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])
      .find(element => element.getClientRects().length > 0)?.focus();
  }, [items]);
  const notify = useCallback((input: NotificationInput) => {
    if (!input.title.trim()) return;
    if (document.activeElement instanceof HTMLElement && !document.activeElement.closest('.notification-stack')) returnFocus.current = document.activeElement;
    const key = input.key || [input.kind, input.title, input.messagePrefix ?? '', input.message ?? '', clip(input.details ?? '', 2000)].join('|');
    const normalized = { ...input, title: clip(input.title.trim(), 160), message: input.message && clip(input.message, 500), messagePrefix: input.messagePrefix && clip(input.messagePrefix, 160), details: input.details && clip(input.details, MAX_DETAILS), key };
    const id = `notification-${++nextId.current}`;
    setItems(current => {
      const existing = current.find(item => item.key === key);
      const item = { ...normalized, id: existing?.id ?? id, revision: (existing?.revision ?? 0) + 1, count: 1 };
      const next = [item, ...current.filter(value => value.key !== key)];
      // Errors remain visible ahead of background completion notices.
      return limitNotifications([...next.filter(value => value.kind === 'error'), ...next.filter(value => value.kind !== 'error')]);
    });
  }, []);
  const notifyError = useCallback((title: string, error: unknown) => notify({ kind: 'error', title, ...describeNotificationError(error) }), [notify]);

  useLayoutEffect(() => {
    const sync = () => {
      const dialogs = document.querySelectorAll('[aria-modal="true"], dialog[open]');
      const active = Array.from(dialogs).filter(element => element.getClientRects().length > 0).at(-1) ?? null;
      setModalTarget(current => current === active ? current : active);
      setBlocked(Boolean(active || document.querySelector('.modal-backdrop')));
    };
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-modal', 'open'] });
    return () => observer.disconnect();
  }, []);
  const context = useMemo(() => ({ notify, notifyError, dismiss }), [notify, notifyError, dismiss, getLanguage()]);
  const visible = items.filter(item => item.kind === 'error' || item.allowInModal || !blocked);
  return <NotificationsContext.Provider value={context}>
    {children}
    {visible.length > 0 && createPortal(<section className={"notification-stack" + (modalTarget ? " notification-stack-in-modal" : "")} aria-label={t('ui.d4baf8f6b173')} onKeyDown={event => {
      // Portal events do not reach a dialog's React key handler through the DOM.
      if (!modalTarget || event.key !== 'Tab' || event.defaultPrevented) return;
      const controls = Array.from(modalTarget.querySelectorAll<HTMLElement>(`${FOCUSABLE},summary`))
        .filter(element => element.tabIndex >= 0 && element.getClientRects().length > 0);
      const first = controls[0], last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }}>
      {visible.map(item => <AppToast key={item.id} notification={item} onClose={() => dismiss(item.id)} />)}
    </section>, modalTarget?.querySelector('[data-dialog-notifications]') ?? modalTarget ?? document.body)}
  </NotificationsContext.Provider>;
}

export function useNotifications(): NotificationContext {
  const context = useContext(NotificationsContext);
  if (!context) throw new Error('useNotifications requires NotificationsProvider');
  return context;
}
