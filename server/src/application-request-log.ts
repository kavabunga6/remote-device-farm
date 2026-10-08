import type { RequestHandler } from 'express';
import type { ApplicationLog } from './application-log.js';

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

/** Log useful API activity without request bodies, credentials, URLs or polling noise. */
export function applicationRequestLog(logs: ApplicationLog, slowMs = 1000): RequestHandler {
  return (req, res, next) => {
    const started = performance.now();
    let reported = false;
    const report = (completed: boolean) => {
      if (reported) return;
      reported = true;
      const elapsed = Math.round(performance.now() - started);
      const status = completed ? res.statusCode : 499;
      const route = typeof req.route?.path === 'string' ? req.route.path : '[unmatched]';
      const failed = status >= 400;
      const streaming = route === '/api/admin/application-log/stream';
      const read = ['GET', 'HEAD', 'OPTIONS'].includes(req.method);
      if (!failed && (streaming || route.endsWith('/keepalive') || read && elapsed < slowMs)) return;
      const actorId = res.locals.auth?.user?.id;
      const sessionId = route.startsWith('/api/sessions/') && typeof req.params.id === 'string' && uuid.test(req.params.id) ? req.params.id : '';
      const code = res.locals.applicationError;
      const message = [
        completed ? 'http.completed' : 'http.aborted', req.method, route,
        'status=' + status, 'durationMs=' + elapsed,
        ...(typeof actorId === 'string' && uuid.test(actorId) ? ['user=' + actorId] : []),
        ...(sessionId ? ['session=' + sessionId] : []),
        ...(typeof code === 'string' && /^[a-z0-9_.-]{1,80}$/i.test(code) ? ['code=' + code] : []),
      ].join(' ');
      try { logs.append(status >= 500 ? 'error' : failed || elapsed >= slowMs ? 'warning' : 'info', message); }
      catch { /* A log subscriber must never change an HTTP response. */ }
    };
    res.once('finish', () => report(true));
    res.once('close', () => report(res.writableFinished));
    next();
  };
}
