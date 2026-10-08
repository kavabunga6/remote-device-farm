import { t } from './i18n';
import { apiRequest, jsonBody, type SessionLaunchOptions } from './api';

// Server error codes people can act on.


export type NotificationKind = 'session.ready' | 'session.failed' | 'session.expiring' | 'session.released' | 'queue.assigned' | 'device.quarantined';

export interface QueueEntry {
  id: string;
  profileId: string;
  profileName: string;
  gpuMode?: 'software' | 'nvidia' | null;
  hostId: string | null;
  hostName: string | null;
  label: string | null;
  createdAt: string;
  expiresAt: string;
  position: number;
}

export interface AppNotification {
  id: string;
  kind: NotificationKind;
  title: string;
  body: string;
  sessionId: string | null;
  createdAt: string;
}

export interface Webhook {
  id: string;
  url: string;
  events: NotificationKind[];
  enabled: boolean;
  lastStatus: string | null;
  lastAttemptAt: string | null;
  createdAt: string;
}

export const EVENT_LABELS: Record<NotificationKind, string> = {
  get 'session.ready'() { return t('ui.ad0b444760b8'); },
  get 'session.failed'() { return t('ui.a4e7f666c264'); },
  get 'session.expiring'() { return t('ui.925c51d7aa64'); },
  get 'session.released'() { return t('ui.9e0fc6a80c8f'); },
  get 'queue.assigned'() { return t('ui.bc915d25ff15'); },
  get 'device.quarantined'() { return t('ui.055811141340'); },
};

export const queueApi = {
  list: (signal?: AbortSignal) => apiRequest<{ entries: QueueEntry[]; maxEntries: number }>('/queue', { signal }),
  join: (input: { profileId: string; hostId?: string | null; label?: string; gpuMode?: 'software' | 'nvidia'; diskGb?: number; sdcardGb?: number; adbKeyId?: string | null; launchOptions?: SessionLaunchOptions }) =>
    apiRequest<{ id: string; expiresAt: string }>('/queue', { method: 'POST', body: jsonBody(input) }),
  leave: (id: string) => apiRequest<void>(`/queue/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  notifications: (signal?: AbortSignal) => apiRequest<{ notifications: AppNotification[] }>('/me/notifications', { signal }),
  markRead: (ids?: string[], signal?: AbortSignal) => apiRequest<{ marked: number }>('/me/notifications/read', { method: 'POST', signal, body: jsonBody(ids ? { ids } : {}) }),
  webhooks: () => apiRequest<{ webhooks: Webhook[]; events: NotificationKind[] }>('/me/webhooks'),
  createWebhook: (input: { url: string; secret?: string; events: NotificationKind[] }) =>
    apiRequest<Webhook & { secret: string }>('/me/webhooks', { method: 'POST', body: jsonBody(input) }),
  updateWebhook: (id: string, patch: { enabled?: boolean; events?: NotificationKind[] }) =>
    apiRequest<Webhook>(`/me/webhooks/${encodeURIComponent(id)}`, { method: 'PATCH', body: jsonBody(patch) }),
  deleteWebhook: (id: string) => apiRequest<void>(`/me/webhooks/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  testWebhook: (id: string) =>
    apiRequest<{ ok: boolean; status: number | null; error: string | null }>(`/me/webhooks/${encodeURIComponent(id)}/test`, { method: 'POST' }),
};

export const QUEUE_CHANGED_EVENT = 'rdf:queue-changed';
export const notifyQueueChanged = (): void => { window.dispatchEvent(new Event(QUEUE_CHANGED_EVENT)); };

// "через 12 мин" until an entry expires; empty once it is over.
export function expiresIn(expiresAt: string, now = Date.now()): string {
  const minutes = Math.ceil((new Date(expiresAt).getTime() - now) / 60_000);
  return minutes > 0 ? t('ui.1febafe019db', { p0: minutes }) : '';
}

// Only recent notifications become toasts; older unread ones are just marked as read.
export function freshNotifications(items: AppNotification[], seen: Set<string>, now = Date.now(), maxAgeMs = 10 * 60_000): AppNotification[] {
  return items.filter(item => !seen.has(item.id) && now - new Date(item.createdAt).getTime() <= maxAgeMs)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function toastText(items: AppNotification[]): string {
  if (!items.length) return '';
  const last = items[items.length - 1]!;
  const text = last.body ? `${last.title}. ${last.body}` : last.title;
  return items.length > 1 ? t('ui.cbd8e0b968e0', { p0: text, p1: items.length - 1 }) : text;
}

const BROWSER_KEY = 'rdf.browserNotifications';
export function browserNotificationsEnabled(): boolean {
  try { return localStorage.getItem(BROWSER_KEY) === '1' && typeof Notification !== 'undefined' && Notification.permission === 'granted'; }
  catch { return false; }
}
export function setBrowserNotifications(enabled: boolean): void {
  try { localStorage.setItem(BROWSER_KEY, enabled ? '1' : '0'); } catch { /* ignore */ }
}
