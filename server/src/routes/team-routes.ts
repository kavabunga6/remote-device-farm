import { uiMessage } from '../messages.js';
import { randomUUID } from 'node:crypto';
import type { Express, Response } from 'express';
import { recordAuditEvent } from '../audit.js';
import { transaction } from '../db.js';
import { ApiError, boundedString, isUuid, route } from '../http-common.js';
import type { ServerContext } from '../server-context.js';
import { allowedProfileIds, teamLimitFor } from '../teams.js';

const MAX_MEMBERS = 500;
const MAX_PROFILES = 200;
const isUniqueViolation = (error: unknown): boolean => typeof error === 'object' && error !== null && (error as { code?: string }).code === '23505';

// null = use the global default, 0 = unlimited, otherwise 1..1000.
function parseLimit(value: unknown): number | null {
  if (value === null) return null;
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 1000) return value;
  throw new ApiError(400, 'invalid_limit', uiMessage('ui.504338b2d54e', {}, 'en'));
}

function teamId(raw: string): string {
  if (!isUuid(raw)) throw new ApiError(404, 'not_found', uiMessage('ui.34d918824a12', {}, 'en'));
  return raw;
}

// Teams and per-team quotas.
export function registerTeamRoutes(app: Express, context: ServerContext): void {
  const { pool, config, requireAuth, requireAdmin, current } = context;

  async function loadTeams(ids?: string[]) {
    const teams = await pool.query(
      `SELECT id,name,max_sessions,created_at FROM teams ${ids ? 'WHERE id=ANY($1::uuid[])' : ''} ORDER BY lower(name)`, ids ? [ids] : []);
    const members = await pool.query(
      `SELECT m.team_id,m.user_id,m.role,u.username,u.display_name FROM team_members m JOIN users u ON u.id=m.user_id
       ORDER BY lower(u.display_name),u.username`);
    const profiles = await pool.query('SELECT team_id,profile_id FROM team_profiles ORDER BY profile_id');
    return teams.rows.map(row => ({
      id: String(row.id), name: String(row.name),
      maxSessions: row.max_sessions == null ? null : Number(row.max_sessions),
      createdAt: new Date(String(row.created_at)).toISOString(),
      members: members.rows.filter(m => m.team_id === row.id).map(m => ({
        userId: String(m.user_id), username: String(m.username), displayName: String(m.display_name), role: String(m.role),
      })),
      profileIds: profiles.rows.filter(p => p.team_id === row.id).map(p => String(p.profile_id)),
    }));
  }
  async function oneTeam(id: string) {
    const [team] = await loadTeams([id]);
    if (!team) throw new ApiError(404, 'not_found', uiMessage('ui.34d918824a12', {}, 'en'));
    return team;
  }
  const audit = (res: Response, action: string, id: string) =>
    recordAuditEvent(pool, { action, actor: current(res).user, targetType: 'team', targetId: id }).catch(() => {
      console.error('Audit event persistence failed');
    });

  app.get('/api/admin/teams', requireAuth, requireAdmin, route(async (_req, res) => {
    res.json({ teams: await loadTeams() });
  }));

  app.post('/api/admin/teams', requireAuth, requireAdmin, route(async (req, res) => {
    const name = boundedString(req.body?.name, 80);
    if (!name) throw new ApiError(400, 'invalid_name', uiMessage('ui.7868e7a6fb5f', {}, 'en'));
    const maxSessions = req.body?.maxSessions === undefined ? null : parseLimit(req.body.maxSessions);
    const id = randomUUID();
    try {
      await pool.query('INSERT INTO teams(id,name,max_sessions) VALUES($1,$2,$3)', [id, name, maxSessions]);
    } catch (error) {
      if (isUniqueViolation(error)) throw new ApiError(409, 'team_exists', uiMessage('ui.c5ed1a443221', {}, 'en'));
      throw error;
    }
    await audit(res, 'admin.team_created', id);
    res.status(201).json({ team: await oneTeam(id) });
  }));

  app.patch('/api/admin/teams/:id', requireAuth, requireAdmin, route(async (req, res) => {
    const id = teamId(String(req.params.id));
    const sets: string[] = [];
    const values: unknown[] = [id];
    if (req.body?.name !== undefined) {
      const name = boundedString(req.body.name, 80);
      if (!name) throw new ApiError(400, 'invalid_name', uiMessage('ui.7868e7a6fb5f', {}, 'en'));
      values.push(name); sets.push(`name=$${values.length}`);
    }
    if (req.body?.maxSessions !== undefined) { values.push(parseLimit(req.body.maxSessions)); sets.push(`max_sessions=$${values.length}`); }
    if (!sets.length) throw new ApiError(400, 'nothing_to_update', uiMessage('ui.aeb531150e91', {}, 'en'));
    let updated;
    try {
      updated = await pool.query(`UPDATE teams SET ${sets.join(',')} WHERE id=$1 RETURNING id`, values);
    } catch (error) {
      if (isUniqueViolation(error)) throw new ApiError(409, 'team_exists', uiMessage('ui.c5ed1a443221', {}, 'en'));
      throw error;
    }
    if (!updated.rowCount) throw new ApiError(404, 'not_found', uiMessage('ui.34d918824a12', {}, 'en'));
    await audit(res, 'admin.team_updated', id);
    res.json({ team: await oneTeam(id) });
  }));

  // Removes the team and its memberships only; users and sessions stay.
  app.delete('/api/admin/teams/:id', requireAuth, requireAdmin, route(async (req, res) => {
    const id = teamId(String(req.params.id));
    const deleted = await pool.query('DELETE FROM teams WHERE id=$1 RETURNING id', [id]);
    if (!deleted.rowCount) throw new ApiError(404, 'not_found', uiMessage('ui.34d918824a12', {}, 'en'));
    await audit(res, 'admin.team_deleted', id);
    res.json({ ok: true });
  }));

  app.put('/api/admin/teams/:id/members', requireAuth, requireAdmin, route(async (req, res) => {
    const id = teamId(String(req.params.id));
    const list: unknown = req.body?.members;
    if (!Array.isArray(list) || list.length > MAX_MEMBERS) throw new ApiError(400, 'invalid_members', uiMessage('ui.334ea438632c', {}, 'en'));
    const seen = new Set<string>();
    const members = list.map(item => {
      const userId = typeof item?.userId === 'string' ? item.userId.toLowerCase() : '';
      const role = item?.role === undefined ? 'member' : item.role;
      if (!isUuid(userId) || (role !== 'member' && role !== 'lead') || seen.has(userId)) {
        throw new ApiError(400, 'invalid_members', uiMessage('ui.b8a8b7e04e6b', {}, 'en'));
      }
      seen.add(userId);
      return { userId, role: role as string };
    });
    await transaction(pool, async client => {
      const team = await client.query('SELECT id FROM teams WHERE id=$1 FOR UPDATE', [id]);
      if (!team.rowCount) throw new ApiError(404, 'not_found', uiMessage('ui.34d918824a12', {}, 'en'));
      if (members.length) {
        const known = await client.query("SELECT count(*)::integer AS total FROM users WHERE id=ANY($1::uuid[]) AND provider!='system' AND removed_at IS NULL", [members.map(m => m.userId)]);
        if (Number(known.rows[0]?.total) !== members.length) throw new ApiError(400, 'unknown_user', uiMessage('ui.1493f3107da0', {}, 'en'));
      }
      await client.query('DELETE FROM team_members WHERE team_id=$1', [id]);
      for (const member of members) {
        await client.query('INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,$3)', [id, member.userId, member.role]);
      }
    });
    await audit(res, 'admin.team_members_updated', id);
    res.json({ team: await oneTeam(id) });
  }));

  app.put('/api/admin/teams/:id/profiles', requireAuth, requireAdmin, route(async (req, res) => {
    const id = teamId(String(req.params.id));
    const list: unknown = req.body?.profileIds;
    if (!Array.isArray(list) || list.length > MAX_PROFILES || list.some(item => typeof item !== 'string' || !item || item.length > 80)) {
      throw new ApiError(400, 'invalid_profiles', uiMessage('ui.6917498573ed', {}, 'en'));
    }
    const profileIds = [...new Set(list as string[])];
    await transaction(pool, async client => {
      const team = await client.query('SELECT id FROM teams WHERE id=$1 FOR UPDATE', [id]);
      if (!team.rowCount) throw new ApiError(404, 'not_found', uiMessage('ui.34d918824a12', {}, 'en'));
      if (profileIds.length) {
        const known = await client.query('SELECT count(*)::integer AS total FROM profiles WHERE id=ANY($1::text[])', [profileIds]);
        if (Number(known.rows[0]?.total) !== profileIds.length) throw new ApiError(400, 'unknown_profile', uiMessage('ui.c997060ae026', {}, 'en'));
      }
      await client.query('DELETE FROM team_profiles WHERE team_id=$1', [id]);
      for (const profileId of profileIds) {
        await client.query('INSERT INTO team_profiles(team_id,profile_id) VALUES($1,$2)', [id, profileId]);
      }
    });
    await audit(res, 'admin.team_profiles_updated', id);
    res.json({ team: await oneTeam(id) });
  }));

  // Teams of the signed-in user with members; no session access comes with it.
  app.get('/api/teams/mine', requireAuth, route(async (_req, res) => {
    const userId = current(res).user.id;
    const mine = await pool.query('SELECT team_id,role FROM team_members WHERE user_id=$1', [userId]);
    const teams = mine.rows.length ? await loadTeams(mine.rows.map(row => String(row.team_id))) : [];
    res.json({ teams: teams.map(team => ({
      ...team, myRole: String(mine.rows.find(row => row.team_id === team.id)?.role || 'member'),
    })) });
  }));

  // Metadata only: no stream, shell or other access path is exposed through this route.
  app.get('/api/teams/:id/sessions', requireAuth, route(async (req, res) => {
    const id = teamId(String(req.params.id));
    const user = current(res).user;
    if (user.role !== 'admin') {
      const lead = await pool.query("SELECT 1 FROM team_members WHERE team_id=$1 AND user_id=$2 AND role='lead'", [id, user.id]);
      if (!lead.rowCount) throw new ApiError(404, 'not_found', uiMessage('ui.34d918824a12', {}, 'en'));
    }
    const { rows } = await pool.query(
      `SELECT s.id,s.state,s.label,s.created_at,s.last_activity_at,s.profile_id,p.name AS profile_name,
              COALESCE(h.display_name,h.name) AS host_name,s.owner_user_id,u.username,u.display_name
       FROM sessions s JOIN team_members m ON m.user_id=s.owner_user_id AND m.team_id=$1
       JOIN users u ON u.id=s.owner_user_id JOIN profiles p ON p.id=s.profile_id JOIN hosts h ON h.id=s.host_id
       WHERE s.state IN ('starting','running','stopping') ORDER BY s.created_at DESC LIMIT 500`, [id]);
    res.json({ sessions: rows.map(row => ({
      id: String(row.id), state: String(row.state), label: row.label == null ? null : String(row.label),
      profileId: String(row.profile_id), profileName: String(row.profile_name), hostName: String(row.host_name),
      ownerId: String(row.owner_user_id), ownerName: String(row.display_name || row.username),
      createdAt: new Date(String(row.created_at)).toISOString(),
      lastActivityAt: new Date(String(row.last_activity_at)).toISOString(),
      ageSeconds: Math.max(0, Math.round((Date.now() - new Date(String(row.created_at)).getTime()) / 1000)),
    })) });
  }));

  // Effective limits for the signed-in user (teams already applied).
  app.get('/api/me/limits', requireAuth, route(async (_req, res) => {
    const user = current(res).user;
    res.json({
      maxSessions: await teamLimitFor(pool, user, config.maxSessionsPerUser),
      allowedProfileIds: await allowedProfileIds(pool, user),
    });
  }));
}
