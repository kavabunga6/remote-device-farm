// Dev mock for the env feature. Return true when the request was handled.
// `state` is shared by all mocks (user, sessions, hosts, profiles); `send(res, status, body)` writes JSON.
const env = {
  darkMode: 'no', fontScale: 1, animations: true, showTouches: false, pointerLocation: false, timezone: 'Europe/Moscow',
  size: { physical: '1080x1920', override: null }, density: { physical: 420, override: null },
  battery: { level: 100, charging: 'ac' },
  proxy: { enabled: false, host: '', port: 0 },
};

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => { try { resolve(JSON.parse(raw || '{}')); } catch { resolve({}); } });
  });
}

function apply(op, p) {
  const fail = (message) => { throw new Error(message); };
  switch (op) {
    case 'proxy': env.proxy = p.reset ? { enabled: false, host: '', port: 0 } : { enabled: true, host: p.host, port: Number(p.port) }; break;
    case 'dark_mode': env.darkMode = p.mode; break;
    case 'font_scale': env.fontScale = Number(p.scale); break;
    case 'animations': env.animations = !!p.enabled; break;
    case 'show_touches': env.showTouches = !!p.enabled; break;
    case 'pointer_location': env.pointerLocation = !!p.enabled; break;
    case 'timezone': env.timezone = p.zone; break;
    case 'display_density': env.density.override = p.reset ? null : Number(p.dpi); break;
    case 'display_size': env.size.override = p.reset ? null : `${p.width}x${p.height}`; break;
    case 'battery':
      if (p.reset) env.battery = { level: 100, charging: 'ac' };
      else { if (p.level !== undefined) env.battery.level = Number(p.level); if (p.charging) env.battery.charging = p.charging; }
      break;
    case 'deeplink': if (!/^[a-z][a-z0-9+.-]+:/.test(String(p.uri))) fail('Invalid link scheme'); break;
    case 'app_clear': case 'app_stop': case 'app_grant': case 'app_revoke': case 'network': case 'geo': break;
    default: fail('Unknown environment operation');
  }
}

export default function handle(req, res, path, method, _state, send) {
  if (!/^\/sessions\/[^/]+\/env$/.test(path)) return false;
  if (method === 'GET') { send(res, 200, { env }); return true; }
  readBody(req).then((body) => {
    try { apply(body.op, body.params || {}); send(res, 200, { result: { op: body.op, applied: true } }); }
    catch (error) { send(res, 422, { error: { code: 'env_failed', message: error.message } }); }
  });
  return true;
}
