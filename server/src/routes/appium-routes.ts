import type { Express } from 'express';
import type { ServerContext } from '../server-context.js';
import { ApiError, route } from '../http-common.js';
import { assertPermission } from '../permissions.js';
import { uiMessage } from '../messages.js';

export function appiumCommandError(error:unknown):ApiError {
  for(const [key,code,status]of [['agent.appium.unavailable','appium_not_installed',503],['agent.appium.busy','appium_busy',409]]as const)
    if(error instanceof Error && (['ru','en']as const).some(language=>error.message===uiMessage(key,{},language)))return new ApiError(status,code,uiMessage(key));
  return new ApiError(502,'appium_unavailable',uiMessage('appium.failed'));
}

export function registerAppiumRoutes(app: Express, context: ServerContext): void {
  const { requireAuth, current, ownedSession, hub, activity } = context;
  const handle = route(async (req, res) => {
    const user = current(res).user;
    // Appium can inspect and modify application data, not just the visible screen.
    for (const permission of ['sessions.control', 'sessions.files', 'sessions.console']) assertPermission(user, permission);
    const session = await ownedSession(req.params.id!, current(res), true);
    const resource = '/' + req.params[0];
    if (!['GET', 'POST', 'DELETE'].includes(req.method) || req.originalUrl.includes('?') ||
        !/^\/(?:status|session(?:\/[A-Za-z0-9_/-]+)?)$/.test(resource) ||
        resource.length > 512 || JSON.stringify(req.body ?? {}).length > 256 * 1024) {
      throw new ApiError(400, 'invalid_appium_command', uiMessage('appium.invalid'));
    }
    activity.touch(session.id);
    let result:Record<string,unknown>;
    try { result = await hub.command(session.hostId, session.id, 'appium',
      { method: req.method, path: resource, ...(req.method === 'POST' ? { body: req.body } : {}) }, 190_000); }
    catch(error) { throw appiumCommandError(error); }
    const status = Number(result.status);
    if (!Number.isInteger(status) || status < 200 || status > 599 || !result.body || typeof result.body !== 'object') {
      throw new ApiError(502, 'appium_unavailable', uiMessage('appium.failed'));
    }
    res.setHeader('Cache-Control', 'no-store');
    res.status(status).json(result.body);
  });
  app.get('/api/sessions/:id/appium/*', requireAuth, handle);
  app.post('/api/sessions/:id/appium/*', requireAuth, handle);
  app.delete('/api/sessions/:id/appium/*', requireAuth, handle);
}
