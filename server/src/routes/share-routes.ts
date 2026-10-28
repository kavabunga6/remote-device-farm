import { diagnostic } from '../diagnostics.js';
import { uiMessage } from '../messages.js';
import { randomUUID } from 'node:crypto';
import type { Express } from 'express';
import { newToken, tokenHash } from '../auth.js';
import { recordAuditEvent } from '../audit.js';
import { transaction } from '../db.js';
import type { ServerContext } from '../server-context.js';
import { ApiError, isUuid, route } from '../http-common.js';
import { assertUserActive } from '../user-removal.js';
import { closeGrantSockets, connectedGrantIds } from '../session-access.js';

export const MAX_ACTIVE_SHARES = 5;
const TOKEN_PREFIX = 'rdfs_';
const TOKEN_PATTERN = /^rdfs_[A-Za-z0-9_-]{43}$/;
const REDEEM_LIMIT = 10;
const REDEEM_WINDOW_MS = 60_000;

export function parseShareRequest(body: unknown): { mode: 'view' | 'control'; ttlMinutes: number; maxRecipients: number } {
  const input = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const ttl = input.ttlMinutes === undefined ? 60 : input.ttlMinutes;
  const maxRecipients = input.maxRecipients === undefined ? 1 : input.maxRecipients;
  if ((input.mode !== 'view' && input.mode !== 'control') ||
      typeof ttl !== 'number' || !Number.isInteger(ttl) || ttl < 1 || ttl > 480 ||
      typeof maxRecipients !== 'number' || !Number.isInteger(maxRecipients) || maxRecipients < 1 || maxRecipients > 10) {
    throw new ApiError(400, 'invalid_share', uiMessage('ui.5495a6e3a70c', {}, 'en'));
  }
  return { mode: input.mode, ttlMinutes: ttl, maxRecipients };
}

// Share management and redemption. Grants are checked by session-access.ts, never here.
export function registerShareRoutes(app: Express, context: ServerContext): void {
  const { pool, hub, requireAuth, current, ownedSession } = context;
  const redeemAttempts = new Map<string, number[]>();
  const audit = (event: Parameters<typeof recordAuditEvent>[1]) =>
    void recordAuditEvent(pool, event).catch(() => console.error(diagnostic('share-routes.57acf9a777')));

  async function ownSession(id: string, res: Parameters<typeof current>[0], active = false) {
    // ownedSession answers 404 to strangers and grant holders; admins who are not owners get 403 below.
    const session = await ownedSession(id, current(res), active);
    if (session.ownerId !== current(res).user.id) throw new ApiError(403, 'forbidden', uiMessage('ui.0fdc4dcd7de7', {}, 'en'));
    return session;
  }

  const revokeRows = async (sessionId: string, shareId: string | null, grantId: string | null) => {
    const ids = await transaction(pool, async client => {
      if (!grantId) {
        // Serialize a full revoke with redemptions of the same link.
        await client.query('SELECT id FROM session_shares WHERE id=$1 AND session_id=$2 FOR UPDATE', [shareId, sessionId]);
        await client.query(
          'UPDATE session_shares SET revoked_at=now() WHERE id=$1 AND session_id=$2 AND revoked_at IS NULL',
          [shareId, sessionId],
        );
      }
      const grants = grantId
        ? await client.query(
          'UPDATE session_share_grants SET revoked_at=now() WHERE id=$1 AND session_id=$2 AND revoked_at IS NULL RETURNING id',
          [grantId, sessionId])
        : await client.query(
          'UPDATE session_share_grants SET revoked_at=now() WHERE share_id=$1 AND session_id=$2 AND revoked_at IS NULL RETURNING id',
          [shareId, sessionId]);
      return new Set(grants.rows.map(row => String(row.id)));
    });
    closeGrantSockets(sessionId, ids);
  };

  app.post('/api/sessions/:id/shares', requireAuth, route(async (req, res) => {
    const session = await ownSession(req.params.id!, res, true);
    const { mode, ttlMinutes, maxRecipients } = parseShareRequest(req.body);
    const token = TOKEN_PREFIX + newToken();
    const id = randomUUID();
    const expiresAt = new Date(Date.now() + ttlMinutes * 60_000);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await assertUserActive(client, current(res).user.id);
      const active = await client.query("SELECT id FROM sessions WHERE id=$1 AND state IN ('starting','running') FOR UPDATE", [session.id]);
      if (!active.rowCount) throw new ApiError(404, 'not_found', uiMessage('ui.0969eab86273', {}, 'en'));
      const count = await client.query(
        'SELECT count(*)::int AS n FROM session_shares WHERE session_id=$1 AND revoked_at IS NULL AND expires_at>now()', [session.id]);
      if (Number(count.rows[0]?.n) >= MAX_ACTIVE_SHARES) {
        await client.query('ROLLBACK');
        throw new ApiError(409, 'share_limit', uiMessage('ui.7d35d6e941a0', { p0: MAX_ACTIVE_SHARES }, 'en'));
      }
      await client.query(
        'INSERT INTO session_shares(id,session_id,created_by,token_hash,mode,max_recipients,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7)',
        [id, session.id, current(res).user.id, tokenHash(token), mode, maxRecipients, expiresAt]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally { client.release(); }
    audit({ action: 'share.created', actor: current(res).user, targetType: 'session', targetId: session.id });
    res.status(201).json({ share: { id, mode, expiresAt: expiresAt.toISOString(), maxRecipients, recipientsUsed: 0 }, token });
  }));

  app.get('/api/sessions/:id/shares', requireAuth, route(async (req, res) => {
    const session = await ownSession(req.params.id!, res);
    const shares = await pool.query(
      `SELECT id,mode,max_recipients,created_at,expires_at FROM session_shares
       WHERE session_id=$1 AND revoked_at IS NULL AND expires_at>now() ORDER BY created_at DESC`, [session.id]);
    const grants = await pool.query(
      `SELECT g.id,g.user_id,g.share_id,g.mode,g.created_at,g.expires_at,u.display_name,u.username
       FROM session_share_grants g JOIN users u ON u.id=g.user_id
       WHERE g.session_id=$1 AND g.revoked_at IS NULL AND g.expires_at>now() ORDER BY g.created_at`, [session.id]);
    const counts = await pool.query(
      'SELECT share_id,count(*)::integer AS used FROM session_share_grants WHERE session_id=$1 GROUP BY share_id', [session.id]);
    const connected = connectedGrantIds(session.id);
    res.json({
      shares: shares.rows.map(share => ({
        id: String(share.id), mode: String(share.mode),
        maxRecipients: Number(share.max_recipients), recipientsUsed: Number(counts.rows.find(row => row.share_id === share.id)?.used || 0),
        createdAt: new Date(String(share.created_at)).toISOString(), expiresAt: new Date(String(share.expires_at)).toISOString(),
        redeemers: grants.rows.filter(grant => grant.share_id === share.id).map(grant => ({
          grantId: String(grant.id), userId: String(grant.user_id), name: String(grant.display_name || grant.username), username: String(grant.username),
          mode: String(grant.mode), redeemedAt: new Date(String(grant.created_at)).toISOString(),
          expiresAt: new Date(String(grant.expires_at)).toISOString(), connected: connected.has(String(grant.id)),
        })),
      })),
    });
  }));

  app.delete('/api/sessions/:id/shares/:shareId', requireAuth, route(async (req, res) => {
    const session = await ownSession(req.params.id!, res);
    if (!isUuid(req.params.shareId!)) throw new ApiError(404, 'not_found', uiMessage('ui.6ca1b618a9b9', {}, 'en'));
    const found = await pool.query('SELECT id FROM session_shares WHERE id=$1 AND session_id=$2 AND revoked_at IS NULL', [req.params.shareId, session.id]);
    if (!found.rows[0]) throw new ApiError(404, 'not_found', uiMessage('ui.6ca1b618a9b9', {}, 'en'));
    await revokeRows(session.id, req.params.shareId!, null);
    audit({ action: 'share.revoked', actor: current(res).user, targetType: 'session', targetId: session.id });
    res.json({ ok: true });
  }));

  // Remove one redeemer without ending the link for the others.
  app.delete('/api/sessions/:id/shares/:shareId/grants/:grantId', requireAuth, route(async (req, res) => {
    const session = await ownSession(req.params.id!, res);
    if (!isUuid(req.params.shareId!) || !isUuid(req.params.grantId!)) throw new ApiError(404, 'not_found', uiMessage('ui.6ca1b618a9b9', {}, 'en'));
    const found = await pool.query(
      'SELECT id FROM session_share_grants WHERE id=$1 AND share_id=$2 AND session_id=$3 AND revoked_at IS NULL',
      [req.params.grantId, req.params.shareId, session.id]);
    if (!found.rows[0]) throw new ApiError(404, 'not_found', uiMessage('ui.6ca1b618a9b9', {}, 'en'));
    await revokeRows(session.id, null, req.params.grantId!);
    audit({ action: 'share.revoked', actor: current(res).user, targetType: 'session', targetId: session.id });
    res.json({ ok: true });
  }));

  // Sessions other people shared with the caller. Owner name and profile name only: no host, key or container data.
  app.get('/api/shares/mine', requireAuth, route(async (_req, res) => {
    const { rows } = await pool.query(
      `SELECT g.id,g.session_id,g.mode,g.created_at,LEAST(g.expires_at,sh.expires_at) AS expires_at,
              s.label,p.name AS profile_name,u.display_name,u.username
       FROM session_share_grants g
       JOIN session_shares sh ON sh.id=g.share_id
       JOIN sessions s ON s.id=g.session_id
       JOIN profiles p ON p.id=s.profile_id
       JOIN users u ON u.id=s.owner_user_id
       WHERE g.user_id=$1 AND g.revoked_at IS NULL AND g.expires_at>now()
         AND sh.revoked_at IS NULL AND sh.expires_at>now() AND s.state IN ('starting','running')
       ORDER BY g.created_at DESC LIMIT 100`, [current(res).user.id]);
    res.json({ shares: rows.map(row => ({
      sessionId: String(row.session_id), ownerName: String(row.display_name || row.username), profileName: String(row.profile_name),
      label: row.label == null ? null : String(row.label), mode: String(row.mode),
      expiresAt: new Date(String(row.expires_at)).toISOString(),
    })) });
  }));

  app.post('/api/shares/redeem', requireAuth, route(async (req, res) => {
    const user = current(res).user;
    const now = Date.now();
    if (!redeemAttempts.has(user.id) && redeemAttempts.size >= 5_000) {
      for (const [key, list] of redeemAttempts) if (!list.some(at => now - at < REDEEM_WINDOW_MS)) redeemAttempts.delete(key);
      if (redeemAttempts.size >= 5_000) throw new ApiError(429, 'rate_limited', uiMessage('ui.4f76f0146d79', {}, 'en'));
    }
    const recent = (redeemAttempts.get(user.id) ?? []).filter(at => now - at < REDEEM_WINDOW_MS);
    if (recent.length >= REDEEM_LIMIT) throw new ApiError(429, 'too_many_attempts', uiMessage('ui.59b89d486554', {}, 'en'));
    recent.push(now);
    redeemAttempts.set(user.id, recent);
    if (redeemAttempts.size > 5_000) for (const [key, list] of redeemAttempts) if (!list.some(at => now - at < REDEEM_WINDOW_MS)) redeemAttempts.delete(key);

    const invalid = () => new ApiError(404, 'share_invalid', uiMessage('ui.4c5b85b5398e', {}, 'en'));
    const token = (req.body as { token?: unknown } | undefined)?.token;
    if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) throw invalid();
    const redeemed = await transaction(pool, async client => {
      await assertUserActive(client, user.id);
      // Lock the link, so concurrent accounts cannot both take the last recipient place.
      const found = await client.query(
        `SELECT sh.id,sh.session_id,sh.mode,sh.expires_at,sh.max_recipients,s.owner_user_id
         FROM session_shares sh JOIN sessions s ON s.id=sh.session_id
         WHERE sh.token_hash=$1 AND sh.revoked_at IS NULL AND sh.expires_at>now()
           AND s.state IN ('starting','running') FOR UPDATE OF sh`,
        [tokenHash(token)]);
      const share = found.rows[0] as {
        id: string; session_id: string; mode: 'view' | 'control';
        expires_at: string; max_recipients: number; owner_user_id: string;
      } | undefined;
      if (!share) throw invalid();
      const sessionId = String(share.session_id);
      if (share.owner_user_id === user.id) return { sessionId, access: 'owner', inserted: false };
      // Reopening by the same account does not consume another place or extend the expiry.
      const existing = await client.query(
        'SELECT mode FROM session_share_grants WHERE share_id=$1 AND user_id=$2 AND revoked_at IS NULL AND expires_at>now()',
        [share.id, user.id]);
      if (existing.rows[0]) return { sessionId, access: String(existing.rows[0].mode), inserted: false };
      const count = await client.query('SELECT count(*)::integer AS used FROM session_share_grants WHERE share_id=$1', [share.id]);
      if (Number(count.rows[0]?.used || 0) >= Number(share.max_recipients)) throw invalid();
      const inserted = await client.query(
        `INSERT INTO session_share_grants(id,share_id,session_id,user_id,mode,expires_at) VALUES($1,$2,$3,$4,$5,$6)
         ON CONFLICT (share_id,user_id) DO NOTHING RETURNING id`,
        [randomUUID(), share.id, sessionId, user.id, share.mode, new Date(String(share.expires_at))]);
      if (!inserted.rows[0]) throw invalid(); // revoked accounts cannot reclaim their former place
      return { sessionId, access: share.mode, inserted: true };
    });
    if (redeemed.inserted) audit({ action: 'share.redeemed', actor: user, targetType: 'session', targetId: redeemed.sessionId });
    res.json({ sessionId: redeemed.sessionId, access: redeemed.access });
  }));

  if (typeof hub.onSessionClosed === 'function') {
    hub.onSessionClosed(sessionId => {
      closeGrantSockets(sessionId);
      void pool.query('DELETE FROM session_shares WHERE session_id=$1', [sessionId]).catch(() => {});
    });
  }
}
