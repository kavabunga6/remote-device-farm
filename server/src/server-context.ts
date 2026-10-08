import { assertPermission, hasPermission } from './permissions.js';
import { requestPermission } from './request-permissions.js';
import { uiMessage } from './messages.js';
import type { Pool } from 'pg';
import type { RequestHandler, Response } from 'express';
import { AuthService, type AuthContext } from './auth.js';
import { AgentHub } from './agent.js';
import type { Config } from './config.js';
import { OidcService } from './oidc.js';
import { ApiError, isUuid, sessionJson, type Session } from './http-common.js';
import { recordAuditEvent } from './audit.js';
import { ActivityTracker, lifecyclePolicy, withDeadlines, type LifecyclePolicy } from './session-lifecycle.js';

// An administrator opening someone else's session leaves one audit event per ten minutes.
const ADMIN_ACCESS_WINDOW_MS = 10 * 60_000;
const adminAccessSeen = new Map<string, number>();

export function shouldRecordAdminAccess(adminId: string, sessionId: string, now = Date.now(), seen = adminAccessSeen): boolean {
  const key = `${adminId}:${sessionId}`;
  const last = seen.get(key);
  if (last !== undefined && now - last < ADMIN_ACCESS_WINDOW_MS) return false;
  if (seen.size > 5_000) for (const [stale, at] of seen) if (now - at >= ADMIN_ACCESS_WINDOW_MS) seen.delete(stale);
  seen.set(key, now);
  return true;
}

export type ServerContext = {
  pool: Pool;
  config: Config;
  auth: AuthService;
  oidc?: OidcService;
  hub: AgentHub;
  requireAuth: RequestHandler;
  requireAdmin: RequestHandler;
  current: (res: Response) => AuthContext;
  sessionQuery: string;
  ownedSession: (id: string, context: AuthContext, active?: boolean) => Promise<Session>;
  activity: ActivityTracker;
  policy: LifecyclePolicy;
};

export function createServerContext(pool: Pool, config: Config, auth: AuthService,
                                    oidc: OidcService | undefined, hub: AgentHub): ServerContext {
  const requireAuth: RequestHandler = (req, res, next) => {
    void auth.authenticate(req, res, config.authMode === 'none').then(context => {
      if (!context) throw new ApiError(401, 'unauthorized', uiMessage('ui.89858f87f6ca', {}, 'en'));
      res.locals.auth = context;
      const permission = requestPermission(req.method, req.path);
      if (permission) assertPermission(context.user, permission);
      next();
    }).catch(next);
  };
  const current = (res: Response): AuthContext => res.locals.auth as AuthContext;
  const requireAdmin: RequestHandler = (req, res, next) => {
    const permission = requestPermission(req.method, req.path);
    if (permission ? !hasPermission(current(res).user, permission) : current(res).user.role !== 'admin') next(new ApiError(403, 'forbidden', uiMessage('ui.031cc7a3ec82', {}, 'en')));
    else next();
  };

  const activity = new ActivityTracker(pool);
  const policy = lifecyclePolicy(config);
  const sessionQuery = `SELECT s.*,p.name AS profile_name,COALESCE(h.display_name,h.name) AS host_name,u.display_name AS owner_name FROM sessions s
    JOIN profiles p ON p.id=s.profile_id JOIN hosts h ON h.id=s.host_id JOIN users u ON u.id=s.owner_user_id`;
  async function ownedSession(id: string, context: AuthContext, active = false): Promise<Session> {
    if (!isUuid(id)) throw new ApiError(404, 'not_found', uiMessage('ui.0969eab86273', {}, 'en'));
    const values: unknown[] = [id];
    let sql = `${sessionQuery} WHERE s.id=$1`;
    if (!hasPermission(context.user, 'sessions.manageAll')) { sql += ' AND s.owner_user_id=$2'; values.push(context.user.id); }
    const result = await pool.query(sql, values);
    const row = result.rows[0];
    if (!row) throw new ApiError(404, 'not_found', uiMessage('ui.0969eab86273', {}, 'en'));
    if (active && !['starting', 'running'].includes(row.state)) throw new ApiError(409, 'session_inactive', uiMessage('ui.9fa6e8e66b25', {}, 'en'));
    const session = withDeadlines(sessionJson(row), policy);
    if (hasPermission(context.user, 'sessions.manageAll') && session.ownerId !== context.user.id &&
        shouldRecordAdminAccess(context.user.id, session.id)) {
      void recordAuditEvent(pool, {
        action: 'session.admin_access', actor: context.user, targetType: 'session', targetId: session.id,
      }).catch(() => console.error('Audit event persistence failed'));
    }
    return session;
  }
  return { pool, config, auth, oidc, hub, requireAuth, requireAdmin, current, sessionQuery, ownedSession, activity, policy };
}
