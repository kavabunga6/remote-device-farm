// Dev mock for the queue, notifications and webhooks. Return true when the request was handled.
// `state` is shared by all mocks (user, sessions, hosts, profiles); `send(res, status, body)` writes JSON.
const EVENTS = ['session.ready', 'session.failed', 'session.expiring', 'session.released', 'queue.assigned', 'device.quarantined'];
const iso = (offsetMs) => new Date(Date.now() + offsetMs).toISOString();
const queue = [{ id: 'q1', profileId: 'a13', profileName: 'Android 13 · Software', hostId: null, hostName: null, label: null, createdAt: iso(-4 * 60000), expiresAt: iso(26 * 60000), position: 2 }];
const webhooks = [{ id: 'w1', url: 'https://hooks.example.com/rdf', events: [...EVENTS], enabled: true, lastStatus: 'ok', lastAttemptAt: iso(-3600000), createdAt: iso(-86400000) }];
let notifications = [{ id: 'n1', kind: 'session.expiring', title: 'Сессия скоро освободится', body: 'Устройство простаивает. Откройте его, чтобы оставить за собой.', sessionId: null, createdAt: iso(-20000) }];
let seq = 1;

function readJson(req) {
  return new Promise(resolve => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve({}); } });
  });
}

export default function handle(req, res, path, method, state, send) {
  if (path === '/queue' && method === 'GET') { send(res, 200, { entries: queue, maxEntries: 3 }); return true; }
  if (path === '/queue' && method === 'POST') {
    void readJson(req).then(body => {
      if (queue.length >= 3) return send(res, 409, { error: { code: 'queue_full', message: 'full' } });
      const profile = state.profiles.find(item => item.id === body.profileId);
      if (!profile) return send(res, 404, { error: { code: 'profile_not_found', message: 'Profile not found' } });
      const entry = { id: 'q' + (++seq), profileId: profile.id, profileName: profile.name, hostId: null, hostName: null, label: body.label || null,
        createdAt: iso(0), expiresAt: iso(30 * 60000), position: queue.length + 1 };
      queue.push(entry);
      send(res, 201, { id: entry.id, expiresAt: entry.expiresAt });
    });
    return true;
  }
  const entry = path.match(/^\/queue\/([^/]+)$/);
  if (entry && method === 'DELETE') {
    const index = queue.findIndex(item => item.id === entry[1]);
    if (index < 0) { send(res, 404, { error: { code: 'not_found', message: 'Queue entry not found' } }); return true; }
    queue.splice(index, 1);
    queue.forEach((item, i) => { item.position = i + 1; });
    res.statusCode = 204; res.end();
    return true;
  }
  if (path === '/me/notifications' && method === 'GET') { send(res, 200, { notifications }); return true; }
  if (path === '/me/notifications/read' && method === 'POST') {
    void readJson(req).then(body => {
      const before = notifications.length;
      notifications = body.ids ? notifications.filter(item => !body.ids.includes(item.id)) : [];
      send(res, 200, { marked: before - notifications.length });
    });
    return true;
  }
  if (path === '/me/webhooks' && method === 'GET') { send(res, 200, { webhooks, events: EVENTS }); return true; }
  if (path === '/me/webhooks' && method === 'POST') {
    void readJson(req).then(body => {
      if (typeof body.url !== 'string' || !body.url.startsWith('https://')) {
        return send(res, 400, { error: { code: 'invalid_webhook_url', message: 'Нужен адрес https://. Обратитесь к администратору, если требуется http.' } });
      }
      const hook = { id: 'w' + (++seq), url: body.url, events: body.events || EVENTS, enabled: true, lastStatus: null, lastAttemptAt: null, createdAt: iso(0) };
      webhooks.push(hook);
      send(res, 201, { ...hook, secret: body.secret || 'mock-secret-' + seq.toString(16).padStart(16, '0') });
    });
    return true;
  }
  const hook = path.match(/^\/me\/webhooks\/([^/]+)(\/test)?$/);
  if (hook) {
    const found = webhooks.find(item => item.id === hook[1]);
    if (!found) { send(res, 404, { error: { code: 'not_found', message: 'Webhook not found' } }); return true; }
    if (hook[2] && method === 'POST') { found.lastStatus = 'ok'; send(res, 200, { ok: true, status: 200, error: null }); return true; }
    if (method === 'PATCH') {
      void readJson(req).then(body => {
        if (typeof body.enabled === 'boolean') found.enabled = body.enabled;
        if (Array.isArray(body.events)) found.events = body.events;
        send(res, 200, found);
      });
      return true;
    }
    if (method === 'DELETE') { webhooks.splice(webhooks.indexOf(found), 1); res.statusCode = 204; res.end(); return true; }
  }
  return false;
}
