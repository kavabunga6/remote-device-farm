import type { Express, Request } from 'express';
import type { Pool } from 'pg';
import type { User } from './auth.js';

type AuditTarget = { action: string; targetType?: string; targetId?: string };

function safeTarget(value: string | undefined): string | undefined {
  return value && /^[A-Za-z0-9._-]{1,100}$/.test(value) ? value : undefined;
}

function actionFor(req: Request): AuditTarget | null {
  const { method, path } = req;
  const normalized = path.toLowerCase().replace(/\/+$/, '');
  if (normalized === '/api/admin/registration-settings' && method === 'PATCH')
    return { action: 'auth.registration_settings_updated', targetType: 'role', targetId: typeof req.body?.roleId === 'string' ? safeTarget(req.body.roleId) : undefined };
  const accessRole = /^\/api\/admin\/roles(?:\/([a-f0-9-]{36}))?$/.exec(normalized);
  if (accessRole && ['POST','PATCH','DELETE'].includes(method)) return { action: method === 'POST' ? 'role.created' : method === 'PATCH' ? 'role.updated' : 'role.deleted', targetType:'role', targetId: accessRole[1] };
  const assignment = /^\/api\/admin\/users\/([a-f0-9-]{36})\/role$/.exec(normalized);
  if (assignment && method === 'PUT') return { action:'user.role_changed',targetType:'user',targetId:assignment[1] };
  const automation = /^\/api\/sessions\/([a-f0-9-]{36})\/(camera\/(?:image|reset|show)|ui\/tap|appium\/session(?:\/[A-Za-z0-9-]+)?)$/.exec(path);
  if (automation && ['POST', 'DELETE'].includes(method)) {
    const op = automation[2]!;
    const action = op.startsWith('camera/') ? 'session.camera_changed' : op === 'ui/tap' ? 'session.semantic_input' :
      method === 'DELETE' ? 'session.automation_stopped' : 'session.automation_started';
    return { action, targetType: 'session', targetId: automation[1] };
  }
  const session = /^\/api\/sessions\/([a-f0-9-]{36})(?:\/([a-z-]+))?$/i.exec(path);
  if (session) {
    const targetId = session[1]!.toLowerCase();
    const operation = session[2] || '';
    const actions: Record<string, string> = {
      'DELETE:': 'session.release_requested',
      'POST:kill': 'session.force_release_requested',
      'POST:audio': 'session.audio_changed',
      'POST:network': 'session.network_changed',
      'POST:rotate': 'session.orientation_changed',
      'POST:files': 'session.file_uploaded',
      'POST:adb': 'session.adb_command',
      'POST:adb-port-access': 'session.adb_port_opened',
      'DELETE:adb-port-access': 'session.adb_port_revoked',
    };
    const action = actions[method + ':' + operation];
    return action ? { action, targetType: 'session', targetId } : null;
  }
  if (path === '/api/admin/launch-settings' && method === 'PATCH') return { action: 'admin.launch_settings_updated', targetType: 'farm' };
  if (path === '/api/me/profile' && method === 'PATCH') return { action: 'account.profile_updated', targetType: 'user' };
  if (path === '/api/me/preferences' && method === 'PATCH') return { action: 'account.preferences_updated', targetType: 'user' };
  if (path === '/api/me/password' && method === 'POST') return { action: 'account.password_changed', targetType: 'user' };
  if (path === '/api/me/adb-key' && method === 'POST') return { action: 'account.adb_key_created', targetType: 'user' };
  if (path === '/api/me/adb-key/rotate' && method === 'POST') return { action: 'account.adb_key_rotated', targetType: 'user' };
  if (path === '/api/me/adb-public-keys' && method === 'POST') return { action: 'account.adb_public_key_added', targetType: 'user' };
  const renamedAdbKey = /^\/api\/me\/adb-public-keys\/([a-f0-9-]{36})$/i.exec(path);
  if (renamedAdbKey && method === 'PATCH') return { action: 'account.adb_public_key_renamed', targetType: 'adb_key', targetId: renamedAdbKey[1]!.toLowerCase() };
  if (/^\/api\/me\/adb-public-keys\/[a-f0-9-]{36}$/i.test(path) && method === 'DELETE') {
    return { action: 'account.adb_public_key_deleted', targetType: 'user' };
  }
  if (path === '/api/tokens' && method === 'POST') return { action: 'account.token_created', targetType: 'user' };
  if (/^\/api\/tokens\/[a-f0-9-]{36}$/i.test(path) && method === 'DELETE') {
    return { action: 'account.token_revoked', targetType: 'user' };
  }
  const node = /^\/api\/admin\/hosts\/([^/]+)$/.exec(path);
  if (node && method === 'DELETE') return {
    action: 'admin.node_removed', targetType: 'host', targetId: safeTarget(node[1]),
  };
  const host = /^\/api\/admin\/hosts\/([^/]+)\/settings$/.exec(path);
  if (host && method === 'PATCH') return {
    action: 'admin.host_settings_updated', targetType: 'host', targetId: safeTarget(host[1]),
  };
  const removedProfile = /^\/api\/admin\/profiles\/([^/]+)\/permanent$/.exec(path);
  if (removedProfile && method === 'DELETE') return {
    action: 'admin.profile_deleted', targetType: 'profile', targetId: safeTarget(removedProfile[1]),
  };
  const profile = /^\/api\/admin\/profiles(?:\/([^/]+))?$/.exec(path);
  if (profile && ['POST', 'PATCH', 'DELETE'].includes(method)) return {
    action: method === 'POST' ? 'admin.profile_created' : method === 'PATCH' ? 'admin.profile_updated' : 'admin.profile_disabled',
    targetType: 'profile', targetId: safeTarget(profile[1]),
  };
  const passwordReset = /^\/api\/admin\/users\/([a-f0-9-]{36})\/password$/i.exec(path);
  if (passwordReset && method === 'POST') return {
    action: 'admin.user_password_reset', targetType: 'user', targetId: passwordReset[1]!.toLowerCase(),
  };
  const user = /^\/api\/admin\/users\/([a-f0-9-]{36})$/i.exec(path);
  if (user && method === 'DELETE') return { action: 'admin.user_removed', targetType: 'user', targetId: user[1]!.toLowerCase() };
  if (user && method === 'PATCH') return { action: 'admin.user_updated', targetType: 'user', targetId: user[1]!.toLowerCase() };
  if (path === '/api/admin/users' && method === 'POST') return { action: 'admin.user_created', targetType: 'user' };
  if (path.startsWith('/api/admin/tokens') && ['POST', 'DELETE'].includes(method)) return {
    action: method === 'POST' ? 'admin.system_token_created' : 'admin.system_token_revoked', targetType: 'token',
  };
  if (path.startsWith('/api/admin/agents') && ['POST', 'DELETE'].includes(method)) return {
    action: method === 'POST' ? 'admin.agent_credential_created' : 'admin.agent_credential_revoked',
    targetType: 'host', targetId: method === 'POST'
      ? safeTarget(typeof req.body?.hostId === 'string' ? req.body.hostId : undefined)
      : safeTarget(path.slice('/api/admin/agents/'.length)),
  };
  if (path.startsWith('/api/admin/') && ['POST', 'PATCH', 'DELETE'].includes(method)) {
    return { action: 'admin.mutation' };
  }
  return null;
}

export async function recordAuditEvent(pool: Pick<Pool, 'query'>, event: {
  action: string;
  actor?: Pick<User, 'id' | 'username'> | null;
  targetType?: string;
  targetId?: string;
  outcome?: 'success' | 'failed' | 'denied';
}): Promise<void> {
  const targetId = safeTarget(event.targetId);
  const subject = event.targetType === 'session' && targetId
    ? await pool.query('SELECT owner_user_id FROM rental_history WHERE session_id=$1', [targetId])
    : null;
  await pool.query(
    'INSERT INTO audit_events(actor_user_id,actor_username,subject_user_id,action,outcome,target_type,target_id) ' +
    'VALUES($1,$2,$3,$4,$5,$6,$7)',
    [event.actor?.id || null, event.actor?.username || null,
      subject?.rows[0]?.owner_user_id || null,
      event.action, event.outcome || 'success', event.targetType || null, targetId || null],
  );
}

export function installAuditTrail(app: Express, pool: Pool): void {
  app.use((req, res, next) => {
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
      const target = actionFor(req);
      if (target) res.once('finish', () => {
        const actor = (res.locals.auth as { user?: User } | undefined)?.user;
        if (!actor) return;
        const outcome = res.statusCode === 401 || res.statusCode === 403
          ? 'denied' : res.statusCode >= 400 ? 'failed' : 'success';
        void recordAuditEvent(pool, { ...target,
          targetId: res.locals.auditTargetId ?? (target.targetType === 'user' && !target.targetId ? actor.id : target.targetId),
          actor, outcome }).catch(() => console.error('Audit event persistence failed'));
      });
    }
    next();
  });
}
