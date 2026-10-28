import { diagnostic } from './diagnostics.js';
import { uiMessage } from './messages.js';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { deliverWebhook, type DeliveryOptions, type WebhookPolicy } from './webhooks.js';

export const NOTIFICATION_KINDS = ['session.ready', 'session.expiring', 'session.released', 'session.failed', 'queue.assigned', 'device.quarantined'] as const;
export type NotificationKind = typeof NOTIFICATION_KINDS[number];

type Db = Pick<Pool, 'query'>;

// Set once at startup from the config; delivery code in other modules does not carry the config around.
let webhookPolicy: WebhookPolicy = { allowHttp: false, allowPrivate: false };
export function configureNotifications(config: { webhookAllowHttp: boolean; webhookAllowPrivate: boolean }): void {
  webhookPolicy = { allowHttp: config.webhookAllowHttp, allowPrivate: config.webhookAllowPrivate };
}
export const currentWebhookPolicy = (): WebhookPolicy => webhookPolicy;

export type NewNotification = { kind: NotificationKind; title: string; body?: string; sessionId?: string | null };

export type NotificationRow = {
  id: string; kind: NotificationKind; title: string; body: string; sessionId: string | null; createdAt: string;
};

export type NotifyOptions = { delivery?: Partial<DeliveryOptions>; awaitWebhooks?: boolean };

// Stores the notification and fires matching webhooks in the background. Never throws.
export async function notifyUser(db: Db, userId: string, item: NewNotification, options: NotifyOptions = {}): Promise<void> {
  const id = item.kind === 'session.ready' && item.sessionId ? item.sessionId : randomUUID();
  try {
    const inserted = await db.query(
      'INSERT INTO notifications(id,user_id,kind,title,body,session_id) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING id',
      [id, userId, item.kind, item.title.slice(0, 200), (item.body ?? '').slice(0, 500), item.sessionId ?? null],
    );
    if (!inserted.rowCount) return;
  } catch { console.error(diagnostic('notifications.b7a6775c79')); return; }
  const delivery = dispatchWebhooks(db, userId, id, item, options.delivery).catch(() => console.error(diagnostic('notifications.0c27068c6c')));
  if (options.awaitWebhooks) await delivery;
}

/** Called on every confirmed starting -> running path; the periodic pass repairs missed writes. */
export async function notifySessionReady(db: Db, sessionId: string): Promise<void> {
  try {
    const result = await db.query(
      `SELECT s.owner_user_id,COALESCE(s.label,p.name,$2) AS name FROM sessions s
       LEFT JOIN profiles p ON p.id=s.profile_id WHERE s.id=$1 AND s.state='running'`, [sessionId, uiMessage('ui.dba20ab53801')],
    );
    const row = result.rows[0];
    if (row) await notifyUser(db, String(row.owner_user_id), {
      kind: 'session.ready', title: uiMessage('ui.ad0b444760b8'), body: String(row.name), sessionId,
    });
  } catch { console.error(diagnostic('notifications.e55bbb9082')); }
}

async function dispatchWebhooks(db: Db, userId: string, id: string, item: NewNotification, overrides?: Partial<DeliveryOptions>): Promise<void> {
  const hooks = await db.query(
    'SELECT id,url,secret FROM webhooks WHERE user_id=$1 AND enabled=true AND $2 = ANY(events)', [userId, item.kind],
  );
  await Promise.all(hooks.rows.map(async hook => {
    const result = await deliverWebhook(
      { id: String(hook.id), url: String(hook.url), secret: String(hook.secret) },
      {
        id, event: item.kind, createdAt: new Date().toISOString(),
        text: item.body ? `${item.title}. ${item.body}` : item.title,
        data: { sessionId: item.sessionId ?? null },
      },
      { policy: webhookPolicy, ...overrides },
    );
    await db.query('UPDATE webhooks SET last_status=$2,last_attempt_at=now() WHERE id=$1',
      [hook.id, result.ok ? 'ok' : result.status ? `http_${result.status}` : 'error']).catch(() => {});
  }));
}

// Tells every administrator (in-app + their webhooks subscribed to the kind). Never throws.
export async function notifyAdmins(db: Db, item: NewNotification): Promise<number> {
  const admins = await db.query("SELECT id FROM users WHERE role='admin'").catch(() => null);
  for (const row of admins?.rows ?? []) await notifyUser(db, String(row.id), item, { awaitWebhooks: true });
  return admins?.rowCount ?? 0;
}

export async function unreadNotifications(db: Db, userId: string): Promise<NotificationRow[]> {
  const { rows } = await db.query(
    'SELECT id,kind,title,body,session_id,created_at FROM notifications WHERE user_id=$1 AND read_at IS NULL ORDER BY created_at DESC LIMIT 50',
    [userId],
  );
  return rows.map(row => ({
    id: String(row.id), kind: row.kind as NotificationKind, title: String(row.title), body: String(row.body),
    sessionId: row.session_id ? String(row.session_id) : null, createdAt: new Date(String(row.created_at)).toISOString(),
  }));
}

// ids omitted: mark everything as read.
export async function markNotificationsRead(db: Db, userId: string, ids?: string[]): Promise<number> {
  const result = ids
    ? await db.query('UPDATE notifications SET read_at=now() WHERE user_id=$1 AND read_at IS NULL AND id = ANY($2::uuid[])', [userId, ids])
    : await db.query('UPDATE notifications SET read_at=now() WHERE user_id=$1 AND read_at IS NULL', [userId]);
  return result.rowCount ?? 0;
}

// Old rows are not useful; keeps the table small.
export async function pruneNotifications(db: Db): Promise<void> {
  await db.query("DELETE FROM notifications WHERE created_at < now() - interval '14 days'");
  await db.query("DELETE FROM queue_entries WHERE state <> 'waiting' AND resolved_at < now() - interval '7 days'");
}
