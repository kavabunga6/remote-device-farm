import { hasPermission } from '../permissions.js';
import { uiMessage } from '../messages.js';
import type { Express, Response } from 'express';
import { ApplicationLog, type ApplicationLogRecord } from '../application-log.js';
import type { ServerContext } from '../server-context.js';
import { ApiError, route } from '../http-common.js';

export function registerApplicationLogRoutes(app: Express, context: ServerContext, logs: ApplicationLog,
  revalidateMs = 15_000): () => void {
  const { requireAuth, requireAdmin, auth, config, current } = context;
  const clients = new Map<Response, { userId: string; close: () => void }>();
  app.get('/api/admin/application-log/stream', requireAuth, requireAdmin, route(async (req, res) => {
    const userId = current(res).user.id;
    if (clients.size >= 16 || [...clients.values()].filter(client => client.userId === userId).length >= 4) {
      throw new ApiError(429, 'log_stream_limit', uiMessage('ui.a84f10754ace', {}, 'en'));
    }
    const cursor = req.headers['last-event-id'] || req.query.after;
    if (cursor !== undefined && (typeof cursor !== 'string' || !/^[a-f0-9-]{36}:\d{1,16}$/i.test(cursor))) {
      throw new ApiError(400, 'invalid_cursor', uiMessage('ui.fce6a5650d41', {}, 'en'));
    }
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    let closed = false;
    let blocked = false;
    let checking = false;
    const pending: string[] = [];
    let unsubscribe = () => {};
    let timer: NodeJS.Timeout | undefined;
    const close = () => {
      if (closed) return;
      closed = true;
      if (timer) clearInterval(timer);
      unsubscribe(); pending.length = 0; clients.delete(res);
      res.off('drain', drain); res.end();
    };
    clients.set(res, { userId, close });
    const drain = () => {
      blocked = false;
      while (!closed && !blocked && pending.length) blocked = !res.write(pending.shift()!);
    };
    const send = (frame: string) => {
      if (closed || res.destroyed || res.writableEnded) { close(); return; }
      if (pending.length >= logs.capacity + 8) { close(); return; }
      pending.push(frame);
      if (!blocked) drain();
    };
    res.on('drain', drain);
    res.once('close', close);
    const entry = (record: ApplicationLogRecord) => send('id: ' + record.id + '\nevent: entry\ndata: ' + JSON.stringify(record) + '\n\n');
    const snapshot = logs.tail(cursor);
    send('retry: 2000\nevent: ready\ndata: ' + JSON.stringify({ reset: snapshot.reset, gap: snapshot.gap, capacity: logs.capacity }) + '\n\n');
    for (const record of snapshot.records) entry(record);
    unsubscribe = logs.subscribe(entry);
    timer = setInterval(() => {
      if (checking || closed) return;
      checking = true;
      void auth.authenticate(req, undefined, config.authMode === 'none').then(refreshed => {
        if (closed) return;
        if (!refreshed || refreshed.user.id !== userId || !hasPermission(refreshed.user, 'logs.view')) {
          send('event: unauthorized\ndata: {}\n\n'); close();
        } else send(': keepalive\n\n');
      }).catch(close).finally(() => { checking = false; });
    }, revalidateMs);
    timer.unref();
  }));
  return () => { for (const client of clients.values()) client.close(); };
}
