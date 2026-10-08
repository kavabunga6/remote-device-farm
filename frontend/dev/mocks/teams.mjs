// Dev mock for the teams feature. Return true when the request was handled.
// `state` is shared by all mocks (user, sessions, hosts, profiles); `send(res, status, body)` writes JSON.
const people = {
  u1: { userId: 'u1', username: 'admin', displayName: 'admin' },
  u2: { userId: 'u2', username: 'ivan', displayName: 'Иван' },
};
const teams = [{ id: 't1', name: 'QA', maxSessions: 5, createdAt: new Date().toISOString(), members: [{ ...people.u2, role: 'lead' }], profileIds: ['a13'] }];
let seq = 1;

function readJson(req, done) {
  let raw = '';
  req.on('data', chunk => { raw += chunk; });
  req.on('end', () => { try { done(JSON.parse(raw || '{}')); } catch { done({}); } });
}

export default function handle(req, res, path, method, _state, send) {
  if (path === '/teams/mine' && method === 'GET') {
    send(res, 200, { teams: teams.map(team => ({ ...team, myRole: 'lead' })) });
    return true;
  }
  const teamSessions = path.match(/^\/teams\/([^/]+)\/sessions$/);
  if (teamSessions && method === 'GET') {
    const now = Date.now();
    send(res, 200, { sessions: [
      { id: 'ts1', state: 'running', label: 'Регресс', profileId: 'a13', profileName: 'Pixel 5', hostName: 'farm-01', ownerId: 'u2', ownerName: 'Иван', createdAt: new Date(now - 95 * 60000).toISOString(), lastActivityAt: new Date(now - 3 * 60000).toISOString(), ageSeconds: 95 * 60 },
      { id: 'ts2', state: 'starting', label: null, profileId: 'a13', profileName: 'Pixel 5', hostName: 'farm-02', ownerId: 'u3', ownerName: 'Мария Петрова', createdAt: new Date(now - 20000).toISOString(), lastActivityAt: new Date(now - 20000).toISOString(), ageSeconds: 20 },
    ] });
    return true;
  }
  if (path === '/me/limits' && method === 'GET') { send(res, 200, { maxSessions: 2, allowedProfileIds: null }); return true; }
  if (path === '/admin/teams' && method === 'GET') { send(res, 200, { teams }); return true; }
  if (path === '/admin/teams' && method === 'POST') {
    readJson(req, body => {
      if (teams.some(team => team.name.toLowerCase() === String(body.name).toLowerCase())) {
        return send(res, 409, { error: { code: 'team_exists', message: 'exists' } });
      }
      const team = { id: 't' + (++seq), name: body.name, maxSessions: body.maxSessions ?? null, createdAt: new Date().toISOString(), members: [], profileIds: [] };
      teams.push(team); send(res, 201, { team });
    });
    return true;
  }
  const match = path.match(/^\/admin\/teams\/([^/]+)(?:\/(members|profiles))?$/);
  if (!match) return false;
  const team = teams.find(item => item.id === match[1]);
  if (!team) { send(res, 404, { error: { code: 'not_found', message: 'Team not found' } }); return true; }
  if (method === 'DELETE') { teams.splice(teams.indexOf(team), 1); send(res, 200, { ok: true }); return true; }
  readJson(req, body => {
    if (match[2] === 'members') team.members = (body.members || []).map(item => ({ ...(people[item.userId] || { userId: item.userId, username: item.userId, displayName: item.userId }), role: item.role }));
    else if (match[2] === 'profiles') team.profileIds = body.profileIds || [];
    else {
      if (body.name !== undefined) team.name = body.name;
      if (body.maxSessions !== undefined) team.maxSessions = body.maxSessions;
    }
    send(res, 200, { team });
  });
  return true;
}
