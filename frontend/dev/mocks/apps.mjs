// Dev mock for the apps feature. Return true when the request was handled.
// `state` is shared by all mocks (user, sessions, hosts, profiles); `send(res, status, body)` writes JSON.
const MB = 1048576;
const usage = { maxBytes: 1024 * MB, maxApps: 50, maxFileBytes: 200 * MB };
let seq = 1;
const apps = [
  { id: 'a0000000-0000-4000-8000-000000000001', name: 'demo-debug.apk', size: 18.4 * MB | 0, sha256: 'a'.repeat(64),
    packageName: 'com.example.demo', versionName: '2.4.1', note: 'ночная сборка', uploadedAt: new Date(Date.now() - 86400000).toISOString() },
];
const summary = () => ({ count: apps.length, usedBytes: apps.reduce((n, a) => n + a.size, 0), ...usage });
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

export default function handle(req, res, path, method, _state, send) {
  if (path === '/apps' && method === 'GET') { send(res, 200, { apps, usage: summary() }); return true; }
  if (path === '/apps' && method === 'POST') {
    let name = 'upload.apk';
    let size = 0;
    req.on('data', (chunk) => {
      if (size === 0) {
        const match = /filename="([^"]{1,200})"/.exec(chunk.toString('latin1', 0, 2048));
        if (match) name = Buffer.from(match[1], 'latin1').toString('utf8');
      }
      size += chunk.length;
    });
    req.on('end', () => {
      if (!name.toLowerCase().endsWith('.apk')) return send(res, 400, { error: { code: 'not_apk', message: 'Only .apk files are accepted' } });
      const app = { id: `a0000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`, name, size, sha256: String(seq).padStart(64, '0'),
        packageName: 'com.example.' + name.replace(/\.apk$/i, '').toLowerCase().replace(/[^a-z0-9]/g, ''), versionName: '1.0', note: null,
        uploadedAt: new Date().toISOString() };
      apps.unshift(app);
      send(res, 201, { app, usage: summary() });
    });
    return true;
  }
  const one = /^\/apps\/([^/]+)$/.exec(path);
  if (one && method === 'DELETE') {
    const index = apps.findIndex((a) => a.id === one[1]);
    if (index < 0) send(res, 404, { error: { code: 'not_found', message: 'App not found' } });
    else { apps.splice(index, 1); send(res, 200, { ok: true, usage: summary() }); }
    return true;
  }
  if (/^\/sessions\/[^/]+\/apps\/install$/.test(path) && method === 'POST') {
    req.resume();
    delay(1200).then(() => send(res, 200, { ok: true, output: 'Success' }));
    return true;
  }
  if (/^\/sessions\/[^/]+\/apps\/install-url$/.test(path) && method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', async () => {
      await delay(1200);
      let url = '';
      try { url = JSON.parse(body).url || ''; } catch { /* fall through */ }
      if (!url.startsWith('https://')) send(res, 400, { error: { code: 'url_not_https', message: 'Only https:// links are allowed' } });
      else send(res, 200, { ok: true, output: 'Success' });
    });
    return true;
  }
  return false;
}
