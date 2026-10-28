import type { Express } from 'express';
import type { ServerContext } from '../server-context.js';
import { ApiError, route } from '../http-common.js';
import { uiMessage } from '../messages.js';
import { registerAccount, registrationCredentials, registrationSettings, RegistrationLimiter, updateRegistrationSettings } from '../registration.js';

export function registerRegistrationRoutes(app: Express, context: ServerContext): void {
  const { pool, config, auth, requireAuth, requireAdmin, current } = context;
  const available = config.authMode === 'local';
  const limiter = new RegistrationLimiter();
  app.post('/api/register', route(async (req, res) => {
    if (!available || !(await registrationSettings(pool, available)).enabled)
      throw new ApiError(403, 'registration_disabled', uiMessage('registration.disabled'));
    const leave = limiter.enter(req.ip || req.socket.remoteAddress || 'unknown');
    try {
      const id = await registerAccount(pool, registrationCredentials(req.body));
      res.status(201).json({ user: await auth.createSession(id, res) });
    } finally { leave(); }
  }));
  app.get('/api/admin/registration-settings', requireAuth, requireAdmin, route(async (_req, res) => {
    res.json({ settings: await registrationSettings(pool, available) });
  }));
  app.patch('/api/admin/registration-settings', requireAuth, requireAdmin, route(async (req, res) => {
    res.json({ settings: await updateRegistrationSettings(pool, req.body, current(res).user.id, available) });
  }));
}
