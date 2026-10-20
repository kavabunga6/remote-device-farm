import type { Express } from 'express';
import type { ServerContext } from '../server-context.js';
import { ApiError, route } from '../http-common.js';
import { uiMessage } from '../messages.js';
import { assertPermission } from '../permissions.js';

export function parseUiSelector(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const item = value as Record<string, unknown>;
  if (Object.keys(item).some(k => !['text', 'resourceId', 'description', 'exact', 'index'].includes(k))) throw invalid();
  const keys = ['text', 'resourceId', 'description'].filter(k => item[k] !== undefined);
  if (!keys.length || keys.some(k => typeof item[k] !== 'string' || !(item[k] as string).length || (item[k] as string).length > 512 || /[\x00-\x1f\x7f]/.test(item[k] as string)) ||
      (item.exact !== undefined && typeof item.exact !== 'boolean') ||
      (item.index !== undefined && (typeof item.index !== 'number' || !Number.isInteger(item.index) || item.index < 0 || item.index > 1999))) throw invalid();
  return item;
}
const invalid = () => new ApiError(400, 'invalid_ui_selector', uiMessage('deviceUi.selector'));

export function registerUiRoutes(app: Express, context: ServerContext): void {
  const { requireAuth, ownedSession, current, activity, hub } = context;
  app.get('/api/sessions/:id/ui', requireAuth, route(async (req, res) => {
    assertPermission(current(res).user, 'sessions.view');
    const session = await ownedSession(req.params.id!, current(res), true);
    activity.touch(session.id);
    res.setHeader('Cache-Control', 'no-store');
    res.json(await hub.command(session.hostId, session.id, 'ui-tree', {}, 20_000));
  }));
  app.post('/api/sessions/:id/ui/tap', requireAuth, route(async (req, res) => {
    assertPermission(current(res).user, 'sessions.control');
    const session = await ownedSession(req.params.id!, current(res), true);
    const selector = parseUiSelector(req.body?.selector);
    activity.touch(session.id);
    res.json(await hub.command(session.hostId, session.id, 'ui-tap', { selector }, 20_000));
  }));
}
