// Dev mock for session sharing. Return true when the request was handled.
// `state` is shared by all mocks (user, sessions, hosts, profiles); `send(res, status, body)` writes JSON.
//
// Preview a shared page: open #/shared/rdfs_view_aaaaaaaaaaaaaaaaaaaaaaaa (view) or #/shared/rdfs_control_aaaaaaaaaaaaaaaaaa
// (control). Open #/shared/rdfs_owner_aaaaaaaaaaaaaaaaaaaaaaaaaa to go back to the owner view.
const iso = (offsetMs) => new Date(Date.now() + offsetMs).toISOString();
let seq = 1;
let sharedAccess = null; // 'view' | 'control' while previewing a recipient
const shares = [{
  id: 's1', mode: 'view', createdAt: iso(-10 * 60000), expiresAt: iso(50 * 60000), maxRecipients: 1, recipientsUsed: 1,
  redeemers: [{ grantId: 'g1', name: 'Анна Смирнова', mode: 'view', redeemedAt: iso(-8 * 60000), expiresAt: iso(50 * 60000), connected: true }],
}];

function readJson(req) {
  return new Promise(resolve => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve({}); } });
  });
}

export default function handle(req, res, path, method, state, send) {
  const sessionId = state.sessions[0]?.id;
  if (sharedAccess && method === 'GET' && path === `/sessions/${sessionId}`) {
    send(res, 200, { session: { ...state.sessions[0], ownerId: 'other-user', ownerName: 'Анна Смирнова', adbKeyId: null, adminAccess: null, access: sharedAccess } });
    return true;
  }
  if (path === '/shares/mine' && method === 'GET') {
    send(res, 200, { shares: [{ sessionId: sessionId, ownerName: 'Анна Смирнова', profileName: 'Pixel 5', label: 'Регресс', mode: 'view', expiresAt: iso(42 * 60000) }] });
    return true;
  }
  if (path === '/shares/redeem' && method === 'POST') {
    void readJson(req).then(body => {
      const token = String(body.token || '');
      if (token.startsWith('rdfs_view')) sharedAccess = 'view';
      else if (token.startsWith('rdfs_control')) sharedAccess = 'control';
      else if (token.startsWith('rdfs_owner')) sharedAccess = null;
      else return send(res, 404, { error: { code: 'share_invalid', message: 'Share link is invalid or expired' } });
      send(res, 200, { sessionId, access: sharedAccess || 'owner' });
    });
    return true;
  }
  const base = new RegExp(`^/sessions/${sessionId}/shares(?:/([^/]+))?(?:/grants/([^/]+))?$`);
  const match = base.exec(path);
  if (!match) return false;
  const [, shareId, grantId] = match;
  if (!shareId && method === 'GET') { send(res, 200, { shares }); return true; }
  if (!shareId && method === 'POST') {
    void readJson(req).then(body => {
      if (shares.length >= 5) return send(res, 409, { error: { code: 'share_limit', message: 'limit' } });
      const maxRecipients = body.maxRecipients === undefined ? 1 : Number(body.maxRecipients);
      if (!['view', 'control'].includes(body.mode) || !Number.isInteger(maxRecipients) || maxRecipients < 1 || maxRecipients > 10) {
        return send(res, 400, { error: { code: 'invalid_share', message: 'invalid' } });
      }
      const share = { id: 's' + (++seq), mode: body.mode, createdAt: iso(0), expiresAt: iso((Number(body.ttlMinutes) || 60) * 60000), maxRecipients, recipientsUsed: 0, redeemers: [] };
      shares.unshift(share);
      send(res, 201, { share: { id: share.id, mode: share.mode, expiresAt: share.expiresAt, maxRecipients, recipientsUsed: 0 }, token: 'rdfs_' + body.mode + '_' + 'x'.repeat(30) });
    });
    return true;
  }
  const index = shares.findIndex(item => item.id === shareId);
  if (shareId && method === 'DELETE' && index >= 0) {
    if (grantId) shares[index].redeemers = shares[index].redeemers.filter(item => item.grantId !== grantId);
    else shares.splice(index, 1);
    send(res, 200, { ok: true });
    return true;
  }
  send(res, 404, { error: { code: 'not_found', message: 'Share not found' } });
  return true;
}
