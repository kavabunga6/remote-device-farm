import { uiMessage } from '../messages.js';
import type { Express, Request } from 'express';
import { hashPassword, verifyPassword } from '../auth.js';
import { profileField } from '../user-profile.js';
import { transaction } from '../db.js';
import { ApiError, isUuid, route } from '../http-common.js';
import type { ServerContext } from '../server-context.js';

const PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;
const passwordAttempts = new Map<string, { count: number; until: number }>();

function pageParams(req: Request, max = MAX_PAGE_SIZE, defaultLimit = PAGE_SIZE): { limit: number; before: string | null } {
  const limit = req.query.limit === undefined ? defaultLimit : Number(req.query.limit);
  const before = req.query.before;
  if (!Number.isInteger(limit) || limit < 1 || limit > max ||
      (before !== undefined && (typeof before !== 'string' || !/^[1-9][0-9]{0,18}$/.test(before)))) {
    throw new ApiError(400, 'invalid_page', uiMessage('ui.589ecf4339a6', { p0: max }, 'en'));
  }
  return { limit, before: before as string | null || null };
}

function filterText(req: Request, name: string, max = 100): string | null {
  const value = req.query[name];
  if (value === undefined || value === '') return null;
  if (typeof value !== 'string' || value.length > max || /[\x00-\x1f\x7f]/.test(value)) {
    throw new ApiError(400, 'invalid_filter', uiMessage('ui.ae2300043eb8', {}, 'en'));
  }
  return value.trim() || null;
}

function filterDate(req: Request, name: string): string | null {
  const value = filterText(req, name, 10);
  if (!value) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) ||
      Number.isNaN(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) {
    throw new ApiError(400, 'invalid_filter', uiMessage('ui.87f8ac044c37', {}, 'en'));
  }
  return value;
}

function dateRange(req: Request): { from: string | null; to: string | null } {
  const from = filterDate(req, 'from');
  const to = filterDate(req, 'to');
  if (from && to && from > to) throw new ApiError(400, 'invalid_filter', uiMessage('ui.dd163efc35a5', {}, 'en'));
  return { from, to };
}

function profileJson(row: Record<string, unknown>) {
  return {
    id: String(row.id), username: String(row.username),
    displayName: String(row.display_name), role: String(row.role), provider: String(row.provider),
    firstName: row.first_name == null ? null : String(row.first_name),
    lastName: row.last_name == null ? null : String(row.last_name),
    jobTitle: row.job_title == null ? null : String(row.job_title),
    company: row.company == null ? null : String(row.company),
    managedByProvider: row.provider !== 'local',
  };
}

function preferencesJson(row?: Record<string, unknown>) {
  return {
    theme: row?.theme || 'system',
    fontFamily: row?.font_family || 'system',
    // 0 = automatic scale (follows the window); otherwise a fixed multiplier of the 16 px base.
    fontScale: row?.font_scale == null ? 0 : Number(row.font_scale),
    defaultAdbKeyId: row?.default_adb_key_id || null,
  };
}

function rentalJson(row: Record<string, unknown>) {
  return {
    id: String(row.id), sessionId: String(row.session_id),
    ownerUserId: String(row.owner_user_id), ownerUsername: String(row.owner_username),
    hostId: String(row.host_id), hostName: String(row.host_name),
    profileId: String(row.profile_id), profileName: String(row.profile_name),
    createdAt: new Date(String(row.created_at)).toISOString(),
    startedAt: row.started_at ? new Date(String(row.started_at)).toISOString() : null,
    endedAt: row.ended_at ? new Date(String(row.ended_at)).toISOString() : null,
    finalState: row.final_state ? String(row.final_state) : null,
  };
}

function auditJson(row: Record<string, unknown>) {
  return {
    id: String(row.id), occurredAt: new Date(String(row.occurred_at)).toISOString(),
    actorUserId: row.actor_user_id ? String(row.actor_user_id) : null,
    actorUsername: row.actor_username ? String(row.actor_username) : null,
    subjectUserId: row.subject_user_id ? String(row.subject_user_id) : null,
    action: String(row.action), outcome: String(row.outcome),
    targetType: row.target_type ? String(row.target_type) : null,
    targetId: row.target_id ? String(row.target_id) : null,
  };
}

export function registerUserSettingsRoutes(app: Express, context: ServerContext): void {
  const { pool, config, auth, requireAuth, requireAdmin, current } = context;

  app.get('/api/me/profile', requireAuth, route(async (_req, res) => {
    const { rows } = await pool.query(
      'SELECT id,username,display_name,role,provider,first_name,last_name,job_title,company FROM users WHERE id=$1',
      [current(res).user.id],
    );
    res.json({ profile: profileJson(rows[0]) });
  }));

  app.patch('/api/me/profile', requireAuth, route(async (req, res) => {
    if (current(res).user.provider !== 'local') {
      throw new ApiError(409, 'managed_profile', uiMessage('ui.6a1d2ad38ec7', {}, 'en'));
    }
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body) ||
        !Object.keys(body).length ||
        Object.keys(body).some(key => !['firstName', 'lastName', 'jobTitle', 'company'].includes(key))) {
      throw new ApiError(400, 'invalid_profile', uiMessage('ui.95c24a863bcf', {}, 'en'));
    }
    const existing = await pool.query(
      'SELECT id,username,display_name,role,provider,first_name,last_name,job_title,company FROM users WHERE id=$1',
      [current(res).user.id],
    );
    const previous = existing.rows[0];
    const firstName = body.firstName === undefined ? previous.first_name : profileField(body.firstName, 100);
    const lastName = body.lastName === undefined ? previous.last_name : profileField(body.lastName, 100);
    const jobTitle = body.jobTitle === undefined ? previous.job_title : profileField(body.jobTitle, 150);
    const company = body.company === undefined ? previous.company : profileField(body.company);
    const namesChanged = (firstName || null) !== (previous.first_name || null) ||
      (lastName || null) !== (previous.last_name || null);
    const displayName = namesChanged
      ? [firstName, lastName].filter(Boolean).join(' ') || previous.username : previous.display_name;
    const { rows } = await pool.query(
      'UPDATE users SET first_name=$2,last_name=$3,job_title=$4,display_name=$5,company=$6 WHERE id=$1 ' +
      'RETURNING id,username,display_name,role,provider,first_name,last_name,job_title,company',
      [current(res).user.id, firstName, lastName, jobTitle, displayName, company],
    );
    res.json({ profile: profileJson(rows[0]) });
  }));

  app.get('/api/me/preferences', requireAuth, route(async (_req, res) => {
    const { rows } = await pool.query('SELECT * FROM user_preferences WHERE user_id=$1', [current(res).user.id]);
    res.json({ preferences: preferencesJson(rows[0]) });
  }));

  app.patch('/api/me/preferences', requireAuth, route(async (req, res) => {
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body) ||
        !Object.keys(body).length ||
        Object.keys(body).some(key => !['theme', 'fontFamily', 'fontScale', 'defaultAdbKeyId'].includes(key))) {
      throw new ApiError(400, 'invalid_preferences', uiMessage('ui.bc6b57fe6352', {}, 'en'));
    }
    const userId = current(res).user.id;
    const result = await transaction(pool, async client => {
      const existing = await client.query('SELECT * FROM user_preferences WHERE user_id=$1 FOR UPDATE', [userId]);
      const previous = preferencesJson(existing.rows[0]);
      const theme = body.theme === undefined ? previous.theme : body.theme;
      const fontFamily = body.fontFamily === undefined ? previous.fontFamily : body.fontFamily;
      const fontScale = body.fontScale === undefined ? previous.fontScale : body.fontScale;
      const defaultAdbKeyId = body.defaultAdbKeyId === undefined ? previous.defaultAdbKeyId : body.defaultAdbKeyId;
      if (!['system', 'light', 'dark'].includes(theme) ||
          !['system', 'inter', 'mono'].includes(fontFamily) ||
          typeof fontScale !== 'number' || !Number.isFinite(fontScale) ||
          (fontScale !== 0 && (fontScale < 0.8 || fontScale > 1.5)) ||
          (defaultAdbKeyId !== null && (typeof defaultAdbKeyId !== 'string' || !isUuid(defaultAdbKeyId)))) {
        throw new ApiError(400, 'invalid_preferences', uiMessage('ui.bc6b57fe6352', {}, 'en'));
      }
      if (defaultAdbKeyId) {
        const key = await client.query(
          'SELECT id FROM user_adb_public_keys WHERE id=$1 AND owner_user_id=$2 FOR SHARE',
          [defaultAdbKeyId, userId],
        );
        if (!key.rows[0]) throw new ApiError(404, 'adb_key_not_found', uiMessage('ui.ff67904614b1', {}, 'en'));
      }
      const { rows } = await client.query(
        'INSERT INTO user_preferences(user_id,theme,font_family,font_scale,default_adb_key_id) ' +
        'VALUES($1,$2,$3,$4,$5) ON CONFLICT(user_id) DO UPDATE SET ' +
        'theme=EXCLUDED.theme,font_family=EXCLUDED.font_family,font_scale=EXCLUDED.font_scale,' +
        'default_adb_key_id=EXCLUDED.default_adb_key_id,updated_at=now() RETURNING *',
        [userId, theme, fontFamily, fontScale, defaultAdbKeyId],
      );
      return rows[0];
    });
    res.json({ preferences: preferencesJson(result) });
  }));

  app.post('/api/me/password', requireAuth, route(async (req, res) => {
    const actor = current(res);
    if (config.authMode !== 'local' || actor.user.provider !== 'local') {
      throw new ApiError(409, 'managed_password', uiMessage('ui.1b76b2da0a87', {}, 'en'));
    }
    const currentPassword = req.body?.currentPassword;
    const newPassword = req.body?.newPassword;
    if (typeof currentPassword !== 'string' || !currentPassword || currentPassword.length > 2048 ||
        typeof newPassword !== 'string' || newPassword.length < 12 || newPassword.length > 2048) {
      throw new ApiError(400, 'invalid_password', uiMessage('ui.1904894163bf', {}, 'en'));
    }
    const attempt = passwordAttempts.get(actor.user.id);
    if (attempt && attempt.until > Date.now() && attempt.count >= 10) {
      throw new ApiError(429, 'too_many_attempts', uiMessage('ui.4f76f0146d79', {}, 'en'));
    }
    await transaction(pool, async client => {
      const { rows } = await client.query(
        "SELECT password_hash FROM users WHERE id=$1 AND provider='local' FOR UPDATE",
        [actor.user.id],
      );
      if (!rows[0] || typeof rows[0].password_hash !== 'string' ||
          !await verifyPassword(currentPassword, rows[0].password_hash)) {
        const count = attempt && attempt.until > Date.now() ? attempt.count + 1 : 1;
        passwordAttempts.set(actor.user.id, { count, until: Date.now() + 15 * 60_000 });
        throw new ApiError(403, 'wrong_password', uiMessage('ui.6958aed8d429', {}, 'en'));
      }
      await client.query('UPDATE users SET password_hash=$2 WHERE id=$1',
        [actor.user.id, await hashPassword(newPassword)]);
      await client.query('DELETE FROM browser_sessions WHERE user_id=$1', [actor.user.id]);
    });
    passwordAttempts.delete(actor.user.id);
    if (actor.via === 'cookie') await auth.createSession(actor.user.id, res);
    res.json({ ok: true });
  }));

  app.get('/api/me/rentals', requireAuth, route(async (req, res) => {
    const { limit, before } = pageParams(req);
    const { rows } = await pool.query(
      'SELECT * FROM rental_history WHERE owner_user_id=$1 AND ($2::bigint IS NULL OR id<$2) ' +
      'ORDER BY id DESC LIMIT $3',
      [current(res).user.id, before, limit + 1],
    );
    res.json({ rentals: rows.slice(0, limit).map(rentalJson),
      nextCursor: rows.length > limit ? String(rows[limit - 1].id) : null });
  }));

  app.get('/api/admin/rentals', requireAuth, requireAdmin, route(async (req, res) => {
    const { limit, before } = pageParams(req);
    const owner = filterText(req, 'owner');
    const host = filterText(req, 'host');
    const { from, to } = dateRange(req);
    const { rows } = await pool.query(
      'SELECT * FROM rental_history WHERE ($1::bigint IS NULL OR id<$1) ' +
      'AND ($2::text IS NULL OR lower(owner_username)=lower($2)) ' +
      'AND ($3::text IS NULL OR lower(host_id)=lower($3) OR lower(host_name)=lower($3)) ' +
      "AND ($4::date IS NULL OR created_at >= $4::date) " +
      "AND ($5::date IS NULL OR created_at < ($5::date + interval '1 day')) " +
      'ORDER BY id DESC LIMIT $6',
      [before, owner, host, from, to, limit + 1],
    );
    res.json({ rentals: rows.slice(0, limit).map(rentalJson),
      nextCursor: rows.length > limit ? String(rows[limit - 1].id) : null });
  }));

  app.get('/api/admin/audit', requireAuth, requireAdmin, route(async (req, res) => {
    const { limit, before } = pageParams(req);
    const actor = filterText(req, 'actor');
    const action = filterText(req, 'action', 80);
    if (action && !/^[a-z][a-z0-9_.-]{1,79}$/.test(action)) {
      throw new ApiError(400, 'invalid_filter', uiMessage('ui.9818786cb60e', {}, 'en'));
    }
    const { from, to } = dateRange(req);
    const { rows } = await pool.query(
      'SELECT * FROM audit_events WHERE ($1::bigint IS NULL OR id<$1) ' +
      'AND ($2::text IS NULL OR lower(actor_username)=lower($2)) ' +
      'AND ($3::text IS NULL OR action=$3) ' +
      "AND ($4::date IS NULL OR occurred_at >= $4::date) " +
      "AND ($5::date IS NULL OR occurred_at < ($5::date + interval '1 day')) " +
      'ORDER BY id DESC LIMIT $6',
      [before, actor, action, from, to, limit + 1],
    );
    res.json({ events: rows.slice(0, limit).map(auditJson),
      nextCursor: rows.length > limit ? String(rows[limit - 1].id) : null });
  }));

  app.get('/api/admin/session-diagnostics', requireAuth, requireAdmin, route(async (req, res) => {
    const { limit } = pageParams(req, 500, 500);
    const session = filterText(req, 'session', 36);
    if (!session || !/^(?:[a-f0-9]{8}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i.test(session))
      throw new ApiError(400, 'invalid_filter', uiMessage('ui.fc409813893e', {}, 'en'));
    const sessionLower = session.length === 8 ? session + '-0000-0000-0000-000000000000' : session;
    const sessionUpper = session.length === 8 ? session + '-ffff-ffff-ffff-ffffffffffff' : session;
    const after = req.query.after;
    if (after !== undefined && (typeof after !== 'string' || !/^[1-9][0-9]{0,18}$/.test(after)))
      throw new ApiError(400, 'invalid_page', uiMessage('ui.b2b94ce15be4', {}, 'en'));
    const host = filterText(req, 'host'), severity = filterText(req, 'severity', 7), service = filterText(req, 'service', 8);
    if (severity && !['info','warning','error'].includes(severity) || service && !['server','agent','emulator'].includes(service))
      throw new ApiError(400, 'invalid_filter', uiMessage('ui.6e9a22dcecec', {}, 'en'));
    const { from, to } = dateRange(req);
    const { rows } = await pool.query(
      'SELECT * FROM service_logs WHERE session_id >= $1::uuid AND session_id <= $9::uuid ' +
      'AND ($2::bigint IS NULL OR id>$2) AND ($3::text IS NULL OR lower(host_id)=lower($3)) ' +
      'AND ($4::text IS NULL OR severity=$4) AND ($5::text IS NULL OR service=$5) ' +
      "AND ($6::date IS NULL OR occurred_at >= $6::date) AND ($7::date IS NULL OR occurred_at < ($7::date + interval '1 day')) " +
      'ORDER BY id ASC LIMIT $8', [sessionLower, after || null, host, severity, service, from, to, limit + 1, sessionUpper]);
    const events = rows.slice(0, limit).map(row => ({ id: String(row.id), occurredAt: new Date(String(row.occurred_at)).toISOString(),
      service: String(row.service), severity: String(row.severity), code: String(row.code), hostId: row.host_id ? String(row.host_id) : null,
      sessionId: String(row.session_id), message: String(row.message || '') }));
    res.json({ events, nextCursor: events.at(-1)?.id || after || null, hasMore: rows.length > limit });
  }));

  app.get('/api/admin/logs', requireAuth, requireAdmin, route(async (req, res) => {
    const { limit, before } = pageParams(req);
    const host = filterText(req, 'host');
    const severity = filterText(req, 'severity', 7);
    const service = filterText(req, 'service', 8);
    const session = filterText(req, 'session', 36);
    if (session && !/^(?:[a-f0-9]{8}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i.test(session)) throw new ApiError(400, 'invalid_filter', uiMessage('ui.daaae4a96cc6', {}, 'en'));
    if (severity && !['info','warning','error'].includes(severity) ||
        service && !['server','agent','emulator'].includes(service)) {
      throw new ApiError(400, 'invalid_filter', uiMessage('ui.6e9a22dcecec', {}, 'en'));
    }
    const { from, to } = dateRange(req);
    const { rows } = await pool.query(
      'SELECT * FROM service_logs WHERE ($1::bigint IS NULL OR id<$1) ' +
      'AND ($2::text IS NULL OR lower(host_id)=lower($2)) ' +
      'AND ($3::text IS NULL OR severity=$3) AND ($4::text IS NULL OR service=$4) ' +
      "AND ($5::date IS NULL OR occurred_at >= $5::date) " +
      "AND ($6::date IS NULL OR occurred_at < ($6::date + interval '1 day')) " +
      "AND ($8::text IS NULL OR session_id::text LIKE lower($8) || '%') " +
      'ORDER BY id DESC LIMIT $7',
      [before, host, severity, service, from, to, limit + 1, session],
    );
    res.json({ events: rows.slice(0, limit).map(row => ({
      id: String(row.id), occurredAt: new Date(String(row.occurred_at)).toISOString(),
      service: String(row.service), severity: String(row.severity), code: String(row.code),
      hostId: row.host_id ? String(row.host_id) : null,
      sessionId: row.session_id ? String(row.session_id) : null, message: String(row.message || ''),
    })), nextCursor: rows.length > limit ? String(rows[limit - 1].id) : null });
  }));
}
