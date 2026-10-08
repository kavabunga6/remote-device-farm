import { uiMessage } from '../messages.js';
import type { Express } from 'express';
import type { ServerContext } from '../server-context.js';
import { ApiError, boundedString, route } from '../http-common.js';
import { recordAuditEvent } from '../audit.js';

export function registerAuthRoutes(app: Express, context: ServerContext): () => Promise<void> {
  const { pool, config, auth, oidc } = context;
  app.get('/health', route(async (_req, res) => {
    await pool.query('SELECT 1');
    res.json({ ok: true });
  }));
  app.get('/api/config', (_req, res) => {
    res.json({
      authMode: config.authMode, authRequired: config.authMode !== 'none', oidcEnabled: config.authMode === 'oidc',
      limits: { maxSessionsPerUser: config.maxSessionsPerUser, idleTimeoutMinutes: config.idleTimeoutMinutes, maxSessionHours: config.maxSessionHours },
    });
  });
  app.get('/api/me', route(async (req, res) => {
    const context = await auth.authenticate(req, res, config.authMode === 'none');
    res.json({ user: context?.user || null });
  }));

  const loginAttempts = new Map<string, { count: number; until: number }>();
  // Failures per address across all usernames, so one host cannot spray many accounts.
  const addressFailures = new Map<string, { count: number; until: number }>();
  let activePasswordChecks = 0;
  let cleanup: Promise<void> | null = null;
  const cleanupTimer = setInterval(() => {
    if (cleanup) return;
    for (const [key, attempt] of loginAttempts) if (attempt.until <= Date.now()) loginAttempts.delete(key);
    for (const [key, attempt] of addressFailures) if (attempt.until <= Date.now()) addressFailures.delete(key);
    cleanup = Promise.allSettled([
      pool.query('DELETE FROM browser_sessions WHERE expires_at<=now()'),
      pool.query('DELETE FROM oidc_flows WHERE expires_at<=now()'),
      pool.query('DELETE FROM adb_access_tokens WHERE expires_at<=now()'),
    ]).then(() => {}).finally(() => { cleanup = null; });
  }, 60 * 60_000);
  cleanupTimer.unref();
  app.post('/api/login', route(async (req, res) => {
    if (config.authMode === 'none') {
      const context = await auth.authenticate(req, res, true);
      if (context) await recordAuditEvent(pool, {
        action: 'auth.login', actor: context.user, targetType: 'user', targetId: context.user.id,
      });
      res.json({ user: context?.user || null }); return;
    }
    if (config.authMode === 'oidc') {
      res.json({ redirectUrl: await oidc!.start(res) }); return;
    }
    const username = boundedString(req.body?.username, 150);
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    if (!username || !password || password.length > 2048) throw new ApiError(400, 'invalid_credentials', uiMessage('ui.1fdc4cd2b7ff', {}, 'en'));
    const key = `${req.ip}:${username}`;
    const attempt = loginAttempts.get(key);
    if (attempt && attempt.until > Date.now() && attempt.count >= 10) throw new ApiError(429, 'too_many_attempts', uiMessage('ui.4f76f0146d79', {}, 'en'));
    // Without TRUST_PROXY every request appears to come from the proxy, so a per-address limit would lock everyone out.
    const address = config.trustProxy === undefined ? undefined : addressFailures.get(req.ip || '');
    if (address && address.until > Date.now() && address.count >= 30) throw new ApiError(429, 'too_many_attempts', uiMessage('ui.4f76f0146d79', {}, 'en'));
    if (activePasswordChecks >= 4) throw new ApiError(429, 'login_busy', uiMessage('ui.dff29a759eeb', {}, 'en'));
    activePasswordChecks++;
    let user;
    try {
      user = config.authMode === 'local' ? await auth.loginLocal(username, password) : await auth.loginLdap(username, password);
    } finally {
      activePasswordChecks--;
    }
    if (!user) {
      const count = attempt && attempt.until > Date.now() ? attempt.count + 1 : 1;
      loginAttempts.set(key, { count, until: Date.now() + 15 * 60_000 });
      if (loginAttempts.size > 10_000) loginAttempts.delete(loginAttempts.keys().next().value!);
      const failed = addressFailures.get(req.ip || '');
      if (config.trustProxy !== undefined) addressFailures.set(req.ip || '', { count: failed && failed.until > Date.now() ? failed.count + 1 : 1, until: Date.now() + 15 * 60_000 });
      if (addressFailures.size > 10_000) addressFailures.delete(addressFailures.keys().next().value!);
      throw new ApiError(401, 'invalid_credentials', uiMessage('ui.87703d685945', {}, 'en'));
    }
    loginAttempts.delete(key);
    const loggedIn = await auth.createSession(user.id, res);
    await recordAuditEvent(pool, {
      action: 'auth.login', actor: loggedIn, targetType: 'user', targetId: loggedIn.id,
    });
    res.json({ user: loggedIn });
  }));
  app.get('/api/oidc/start', route(async (_req, res) => {
    if (!oidc) throw new ApiError(404, 'not_found', uiMessage('ui.32e1d34e9f82', {}, 'en'));
    res.redirect(await oidc.start(res));
  }));
  app.get('/api/oidc/callback', route(async (req, res) => {
    if (!oidc) throw new ApiError(404, 'not_found', uiMessage('ui.32e1d34e9f82', {}, 'en'));
    const identity = await oidc.complete(req, res);
    const user = await auth.upsertExternalUser('oidc', identity.subject, identity.username, identity.displayName, identity);
    await auth.createSession(user.id, res);
    await recordAuditEvent(pool, {
      action: 'auth.login', actor: user, targetType: 'user', targetId: user.id,
    });
    res.redirect('/');
  }));
  app.post('/api/logout', route(async (req, res) => {
    const context = await auth.authenticate(req, res);
    await auth.logout(req, res);
    if (context) await recordAuditEvent(pool, {
      action: 'auth.logout', actor: context.user, targetType: 'user', targetId: context.user.id,
    });
    res.json({ ok: true });
  }));
  return () => { clearInterval(cleanupTimer); return cleanup ?? Promise.resolve(); };
}
