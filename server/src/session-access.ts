import { diagnostic } from './diagnostics.js';
import { assertPermission, hasPermission } from './permissions.js';
import { uiMessage } from './messages.js';
import type WebSocket from 'ws';
import type { AuthContext } from './auth.js';
import { ApiError, isUuid, sessionJson, type Session } from './http-common.js';
import { recordAuditEvent } from './audit.js';
import { withDeadlines } from './session-lifecycle.js';
import { shouldRecordAdminAccess, type ServerContext } from './server-context.js';

export type Access = 'owner' | 'admin' | 'view' | 'control';
export type AccessNeed = 'view' | 'control';

// Keep the real host ID for internal stream routing; grant holders receive only `session`.
export type AccessResult = { session: Session; hostId: string; access: Access; grantId: string | null; grantExpiresAt: number | null };

const sharedAccessSeen = new Map<string, number>();

// Grant holders must never learn owner-only details.
export function hideOwnerData(session: Session): Session {
  return { ...session, adbKeyId: null, containerId: null, error: null, hostId: '', profileId: '' };
}

export function modeAllows(access: Access, need: AccessNeed): boolean {
  return need === 'view' || access !== 'view';
}

// owner/admin sessions go through ownedSession unchanged; only when that answers 404 an active grant is checked.
export async function accessibleSession(
  server: ServerContext, id: string, auth: AuthContext, need: AccessNeed, active = false,
): Promise<AccessResult> {
  assertPermission(auth.user, need === 'view' ? 'sessions.view' : 'sessions.control');
  try {
    const session = await server.ownedSession(id, auth, active);
    return { session, hostId: session.hostId, access: session.ownerId === auth.user.id ? 'owner' : 'admin', grantId: null, grantExpiresAt: null };
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 404) throw error;
  }
  if (need === 'view' && hasPermission(auth.user, 'sessions.viewAll') && isUuid(id)) {
    const result = await server.pool.query(`${server.sessionQuery} WHERE s.id=$1${active ? " AND s.state IN ('starting','running')" : ''}`, [id]);
    if (result.rows[0]) {
      const session = withDeadlines(sessionJson(result.rows[0]), server.policy);
      if (shouldRecordAdminAccess(auth.user.id, id, Date.now(), sharedAccessSeen)) await recordAuditEvent(server.pool, { action: 'session.admin_access', actor: auth.user, targetType: 'session', targetId: id });
      return { session, hostId: session.hostId, access: 'view', grantId: null, grantExpiresAt: null };
    }
  }
  const notFound = () => new ApiError(404, 'not_found', uiMessage('ui.0969eab86273', {}, 'en'));
  if (!isUuid(id)) throw notFound();
  const grant = await server.pool.query(
    `SELECT g.id,g.mode,LEAST(g.expires_at,sh.expires_at) AS expires_at
     FROM session_share_grants g JOIN session_shares sh ON sh.id=g.share_id
     WHERE g.session_id=$1 AND g.user_id=$2 AND g.revoked_at IS NULL AND g.expires_at>now()
       AND sh.revoked_at IS NULL AND sh.expires_at>now()
     ORDER BY (g.mode='control') DESC LIMIT 1`, [id, auth.user.id]);
  const row = grant.rows[0] as { id: string; mode: string; expires_at: string } | undefined;
  if (!row || (row.mode !== 'view' && row.mode !== 'control')) throw notFound();
  const access: Access = row.mode;
  if (!modeAllows(access, need)) throw notFound();
  const result = await server.pool.query(`${server.sessionQuery} WHERE s.id=$1 AND s.state IN ('starting','running')`, [id]);
  if (!result.rows[0]) throw notFound();
  const privateSession = withDeadlines(sessionJson(result.rows[0]), server.policy);
  const session = hideOwnerData(privateSession);
  if (shouldRecordAdminAccess(auth.user.id, session.id, Date.now(), sharedAccessSeen)) {
    void recordAuditEvent(server.pool, {
      action: 'session.shared_access', actor: auth.user, targetType: 'session', targetId: session.id,
    }).catch(() => console.error(diagnostic('session-access.57acf9a777')));
  }
  return { session, hostId: privateSession.hostId, access, grantId: row.id, grantExpiresAt: new Date(String(row.expires_at)).getTime() };
}

export type StreamAction = 'keyframe' | 'input' | 'ignore' | 'reject';

// Decides what one parsed stream message may do for the given access level.
export function classifyStreamMessage(access: Access, message: Record<string, unknown>): StreamAction {
  if (message.type === 'request-keyframe') return 'keyframe';
  if (message.type !== 'input') return 'ignore';
  return modeAllows(access, 'control') ? 'input' : 'reject';
}

// Open stream sockets of grant holders, so a revoke can cut them immediately.
type GrantSocket = { ws: WebSocket; grantId: string; userId: string; name: string; mode: Access; beforeClose?: () => void };
const grantSockets = new Map<string, Set<GrantSocket>>();

export function registerGrantSocket(sessionId: string, entry: GrantSocket): void {
  let set = grantSockets.get(sessionId);
  if (!set) { set = new Set(); grantSockets.set(sessionId, set); }
  set.add(entry);
  entry.ws.once('close', () => {
    set!.delete(entry);
    if (set!.size === 0 && grantSockets.get(sessionId) === set) grantSockets.delete(sessionId);
  });
}

export function connectedGrantIds(sessionId: string): Set<string> {
  return new Set([...(grantSockets.get(sessionId) ?? [])].map(entry => entry.grantId));
}

export function closeGrantSockets(sessionId: string, grantIds?: ReadonlySet<string>): number {
  let closed = 0;
  for (const entry of [...(grantSockets.get(sessionId) ?? [])]) {
    if (grantIds && !grantIds.has(entry.grantId)) continue;
    // Stop media before waiting for an untrusted client to acknowledge close.
    entry.beforeClose?.();
    entry.ws.close(4003, 'share revoked');
    closed++;
  }
  return closed;
}

export function resetSharedAccessAudit(): void { sharedAccessSeen.clear(); }
