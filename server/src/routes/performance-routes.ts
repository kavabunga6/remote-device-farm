import type { Express, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { ApiError, isUuid, route } from '../http-common.js';
import { hasPermission } from '../permissions.js';
import { uiMessage } from '../messages.js';
import type { ServerContext } from '../server-context.js';
import { containerSample, isEmulatorRental, processSnapshot, sessionCrash } from '../session-performance.js';

const MAX_TRACE_BYTES = 5 * 1024 * 1024;
const MAX_TRACE_CHUNK_BYTES = 48 * 1024;
type Action = 'container' | 'processes' | 'trace';
const unavailableMessage = {
  container: 'performance.containerUnavailable',
  processes: 'performance.processUnavailable',
  trace: 'performance.traceUnavailable',
} as const;

export function registerPerformanceRoutes(app: Express, { pool, hub, requireAuth, current, ownedSession }: ServerContext) {
  async function sessionFor(req: Request, res: Response) {
    const session = await ownedSession(req.params.id!, current(res));
    if (session.deviceKind !== 'emulator') {
      throw new ApiError(409, 'performance_unsupported', uiMessage('performance.unsupported'));
    }
    res.setHeader('Cache-Control', 'private, no-store');
    return session;
  }
  function unavailable(action: Action) {
    return new ApiError(503, 'performance_unavailable', uiMessage(unavailableMessage[action]));
  }
  async function runningSession(req: Request, res: Response) {
    const session = await sessionFor(req, res);
    if (session.state !== 'running') throw new ApiError(409, 'session_inactive', uiMessage('ui.9fa6e8e66b25'));
    return session;
  }
  async function collect(req: Request, res: Response, action: Exclude<Action, 'trace'>, timeout: number) {
    const session = await runningSession(req, res);
    try { return await hub.command(session.hostId, session.id, 'performance-' + action, {}, timeout); }
    catch (error) {
      if (error instanceof ApiError) throw error;
      throw unavailable(action);
    }
  }

  app.get('/api/sessions/:id/performance', requireAuth, route(async (req, res) => {
    const sample = containerSample(await collect(req, res, 'container', 6000));
    if (!sample) throw unavailable('container');
    res.json({ sample });
  }));
  app.post('/api/sessions/:id/performance/processes', requireAuth, route(async (req, res) => {
    const snapshot = processSnapshot(await collect(req, res, 'processes', 6000));
    if (!snapshot) throw unavailable('processes');
    res.json(snapshot);
  }));
  app.post('/api/sessions/:id/performance/trace', requireAuth, route(async (req, res) => {
    const cancelled = new AbortController();
    const close = () => cancelled.abort();
    res.once('close', close);
    const signal = AbortSignal.any([cancelled.signal, AbortSignal.timeout(55_000)]);
    try {
      const session = await runningSession(req, res);
      if (res.destroyed) return;
      const traceId = randomUUID();
      const command = (action: string, params: Record<string, unknown>, timeout: number, requestSignal?: AbortSignal) =>
        hub.command(session.hostId, session.id, 'performance-trace-' + action, { traceId, ...params }, timeout, undefined, requestSignal);
      let trace: Buffer;
      try {
        const { size } = await command('open', {}, 22_000, signal);
        if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 1 || size > MAX_TRACE_BYTES) throw unavailable('trace');
        trace = Buffer.alloc(size);
        for (let offset = 0; offset < size;) {
          const { chunk } = await command('read', { offset }, 5000, signal);
          const bytes = Math.min(size - offset, MAX_TRACE_CHUNK_BYTES);
          if (typeof chunk !== 'string' || chunk.length !== Math.ceil(bytes / 3) * 4) throw unavailable('trace');
          const decoded = Buffer.from(chunk, 'base64');
          if (decoded.length !== bytes) throw unavailable('trace');
          decoded.copy(trace, offset);
          offset += bytes;
        }
        if (trace[0] !== 0x0a) throw unavailable('trace');
      } catch (error) {
        if (res.destroyed) return;
        if (error instanceof ApiError) throw error;
        throw unavailable('trace');
      } finally {
        void command('release', {}, 5000).catch(() => {});
      }
      await runningSession(req, res);
      if (!res.destroyed) res.attachment('android.perfetto-trace').type('application/octet-stream').send(trace);
    } finally {
      res.off('close', close);
    }
  }));
  app.get('/api/sessions/:id/performance/crash', requireAuth, route(async (req, res) => {
    const id = req.params.id!;
    const user = current(res).user;
    const includeLogs = hasPermission(user, 'logs.view');
    const session = await sessionFor(req, res).catch(error => {
      if (error instanceof ApiError && error.status === 404 && isUuid(id)) return null;
      throw error;
    });
    if (session) {
      const crash = ['stopped', 'failed', 'stopping'].includes(session.state)
        ? await sessionCrash(pool, id, session.state === 'failed', includeLogs) : null;
      res.json({ crash });
      return;
    }
    // Releasing a slot deletes the live session. The usage ledger still identifies its owner.
    const { rows: [rental] } = await pool.query<{ final_state: string; profile_id: string }>(
      `SELECT final_state, profile_id FROM rental_history
       WHERE session_id=$1 AND ended_at IS NOT NULL AND (owner_user_id=$2 OR $3::boolean)`,
      [id, user.id, hasPermission(user, 'sessions.manageAll')]);
    if (!rental || !isEmulatorRental(rental.profile_id)) {
      throw new ApiError(404, 'not_found', uiMessage('ui.0969eab86273'));
    }
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ crash: await sessionCrash(pool, id, rental.final_state === 'failed', includeLogs) });
  }));
}
