import { uiMessage } from '../messages.js';
import type { Express } from 'express';
import type { ServerContext } from '../server-context.js';
import { ApiError, route, statusMessage } from '../http-common.js';

const OPS = new Set(['proxy', 'network', 'geo', 'dark_mode', 'font_scale', 'display_size', 'display_density', 'animations',
  'show_touches', 'pointer_location', 'battery', 'timezone', 'deeplink', 'app_clear', 'app_stop', 'app_grant',
  'app_revoke']);

// Shallow bounds check; the agent validates every value strictly and builds the adb argv.
export function envParams(value: unknown): Record<string, string | number | boolean> {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw new ApiError(400, 'invalid_env', uiMessage('ui.e20204115ca9', {}, 'en'));
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 6) throw new ApiError(400, 'invalid_env', uiMessage('ui.dd745057e105', {}, 'en'));
  const out: Record<string, string | number | boolean> = {};
  for (const [key, item] of entries) {
    if (!/^[a-z][A-Za-z]{0,19}$/.test(key)) throw new ApiError(400, 'invalid_env', uiMessage('ui.3ab467ab601a', {}, 'en'));
    if (typeof item === 'string' && item.length <= 2000) out[key] = item;
    else if (typeof item === 'number' && Number.isFinite(item)) out[key] = item;
    else if (typeof item === 'boolean') out[key] = item;
    else throw new ApiError(400, 'invalid_env', 'Invalid value for ' + key);
  }
  return out;
}

// Device environment tools. Structured operations only; no shell passthrough.
export function registerEnvRoutes(app: Express, context: ServerContext): void {
  const { pool, hub, requireAuth, current, ownedSession, activity } = context;

  async function agentCall(session: { hostId: string; id: string }, params: Record<string, unknown>, timeoutMs: number) {
    try { return await hub.command(session.hostId, session.id, 'env', params, timeoutMs); }
    catch (error) {
      const message = statusMessage(error);
      if (message === 'agent offline') throw new ApiError(503, 'agent_offline', uiMessage('ui.75aecf4c8ac3', {}, 'en'));
      throw new ApiError(422, 'env_failed', message.slice(0, 300));
    }
  }

  app.get('/api/sessions/:id/env', requireAuth, route(async (req, res) => {
    const session = await ownedSession(req.params.id!, current(res), true);
    activity.touch(session.id);
    res.json({ env: await agentCall(session, { op: 'read' }, 45_000) });
  }));

  app.post('/api/sessions/:id/env', requireAuth, route(async (req, res) => {
    const session = await ownedSession(req.params.id!, current(res), true);
    const op = req.body?.op;
    if (typeof op !== 'string' || !OPS.has(op)) throw new ApiError(400, 'invalid_env', uiMessage('ui.ee42296c3220', {}, 'en'));
    const params = envParams(req.body?.params);
    activity.touch(session.id);
    const result = await agentCall(session, { op, params }, 45_000);
    const user = current(res).user;
    await pool.query(
      'INSERT INTO audit_events(actor_user_id,actor_username,subject_user_id,action,target_type,target_id,detail) ' +
      "VALUES($1,$2,$3,'session.env_changed','session',$4,$5)",
      [user.id, user.username, session.ownerId, session.id, op]);
    res.json({ result });
  }));
}
