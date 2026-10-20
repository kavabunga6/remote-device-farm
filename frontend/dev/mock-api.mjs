import { readFileSync } from 'node:fs';
const messages = JSON.parse(readFileSync(new URL('../../shared/messages.json', import.meta.url), 'utf8'));
import { pageLogcat, parseLogcat, validateLogcatParams } from '../../agent/src/logcat.mjs';
import { parseDeviceInfo } from '../../agent/src/device-info.mjs';
import featureMocks from './mocks/index.mjs';
import { setMockRole } from './mocks/roles.mjs';

// Dev-only mock of the backend API so the UI can be developed without the server stack.
// Enable with: npm run dev:mock
const now = Date.now();
const iso = (minAgo) => new Date(now - minAgo * 60000).toISOString();
const user = { id: 'u1', username: 'admin', displayName: 'admin', role: 'admin' };
let userProfile = { ...user, provider: 'local', firstName: 'Алексей', lastName: 'Тестовый', company: 'Device Farm', jobTitle: 'QA-инженер', managedByProvider: false };
const adminUsers = [
  { ...user, provider: 'local', company: 'Device Farm', jobTitle: 'Администратор', createdAt: iso(60 * 24 * 90) },
  { id: 'u2', username: 'ivan', displayName: 'Иван', role: 'user', provider: 'local', company: 'Тестовая компания', jobTitle: 'Android-разработчик', createdAt: iso(60 * 24 * 10) },
];
let nextUserId = 2;
const host = {
  id: 'h1', name: 'worker-01', agentName: 'worker-01', displayName: null, status: 'online', slots: 2, slotMode: 'dynamic', manualSlots: 2,
  slotCpu: 4, slotMemoryMb: 6144, disabled: false, policySupported: true, policyPending: false, reportedSlots: 2, slotCap: null, usedSlots: 1,
  lastSeenAt: iso(0),
  metrics: { cpuCores: 32, cpuPhysicalCores: 16, cpuThreads: 32, cpuModel: 'Example CPU', memoryTotalMb: 65536, memoryFreeMb: 40960, memoryAvailableMb: 45056, gpuPresent: true, gpuModel: 'NVIDIA Example GPU', gpuVendor: 'NVIDIA', nvidiaGpuAvailable: true, hostIp: '192.0.2.10', diskTotalGb: 1024, diskFreeGb: 768, architecture: 'x86_64', environmentType: 'bare-metal', agentRuntime: 'container' },
};
const profiles = [
  { id: 'a11-gpu', name: 'Android 11 · NVIDIA GPU', androidVersion: '11', apiLevel: 30, abi: 'x86_64', image: 'budtmo/docker-android:emulator_11.0', cpu: 4, memoryMb: 6144, guestMemoryMb: 4096, guestCores: 4, diskGb: 16, emulatorParams: '', enabled: true, deviceModel: 'Pixel 5', resolution: '720x1280' },
  { id: 'a13', name: 'Android 13 · Software', androidVersion: '13', apiLevel: 33, abi: 'x86_64', image: 'budtmo/docker-android:emulator_13.0', cpu: 4, memoryMb: 6144, guestMemoryMb: 4096, guestCores: 4, diskGb: 16, diskMaxGb: 64, sdcardGb: 2, sdcardMaxGb: 8, emulatorParams: '', enabled: true, deviceModel: 'Pixel 6', resolution: '1080x2400' },
];
const sessions = [{ deviceKind: 'emulator', platform: 'android', sdkLevel: 30, osVersion: '11', capabilities: ['video','audio','touch','keys','rotate','files','install','shell','logs','device-info','env','network','screenshot','tunnel'], id: 'cbd55091-aaaa-bbbb-cccc-000000000001', ownerId: 'u1', ownerName: 'worker-01', hostId: 'h1', hostName: 'worker-01', profileId: 'a11-gpu', profileName: 'Android 11 · NVIDIA GPU', state: 'running', gpuMode: 'nvidia', orientation: 'portrait', audioEnabled: false, networkEnabled: true, createdAt: iso(27), label: null, lastActivityAt: iso(56), idleExpiresAt: new Date(now + 4 * 60000).toISOString(), expiresAt: new Date(now + 6 * 3600000).toISOString() }];
const tokens = [
  { id: 't1', name: 'CI pipeline', kind: 'personal', createdAt: iso(60 * 24 * 12), expiresAt: new Date(now + 86400000 * 48).toISOString(), lastUsedAt: iso(35) },
  { id: 't2', name: 'Локальные тесты', kind: 'personal', createdAt: iso(60 * 24 * 40), expiresAt: null, lastUsedAt: null },
];
const adbKeys = [{ id: 'k1', name: 'Рабочий ноутбук', fingerprint: 'SHA256:q3Fv0m1Xl2sW9mP3tA8sJpYb0H4o5cLw2uB1nRkE7ZQ', createdAt: iso(60 * 24 * 20) }];
const prefs = { theme: 'system', fontFamily: 'system', fontScale: 0, defaultAdbKeyId: null };
const rentals = [
  { id: 'r1', sessionId: 'cbd55091-aaaa', ownerUserId: 'u1', ownerUsername: 'admin', hostId: 'h1', hostName: 'worker-01', profileId: 'a11-gpu', profileName: 'Android 11 · NVIDIA GPU', createdAt: iso(27), startedAt: iso(27), endedAt: null, finalState: null },
  { id: 'r2', sessionId: 'aa71e0b2-aaaa', ownerUserId: 'u1', ownerUsername: 'admin', hostId: 'h1', hostName: 'worker-01', profileId: 'a13', profileName: 'Android 13 · Software', createdAt: iso(3000), startedAt: iso(3000), endedAt: iso(2900), finalState: 'stopped' },
];
let loggedIn = true;
// Synthetic logcat in `threadtime` format, run through the real agent parser and pager.
const TAGS = [['I', 'ActivityManager', 'Start proc %p for service'], ['D', 'chromium', 'Network state changed: online'], ['W', 'WifiService', 'rssi %n below threshold, scanning'], ['I', 'InputDispatcher', 'touch (%n, %n) delivered'], ['E', 'AndroidRuntime', 'FATAL EXCEPTION: main'], ['W', 'Choreographer', 'Skipped %n frames! The application may be doing too much work on its main thread.'], ['D', 'MediaCodec', 'h264 encoder ready'], ['E', 'Netd', 'dns timeout 8.8.8.8'], ['I', 'SurfaceFlinger', 'vsync period 16666666'], ['D', 'ActivityThread', 'handleLaunchActivity'], ['I', 'zygote', 'Background concurrent copying GC freed %n KB'], ['D', 'NetworkMonitor', 'PROBE_HTTPS 204 ok'], ['I', 'WindowManager', 'Relayout Window{%n u0 com.example.testapp}']];
let logSeq = 0;
const logLines = [];
const pad = (n, w = 2) => String(n).padStart(w, '0');
function addLog(count) {
  for (let i = 0; i < count; i++) {
    const t = new Date(now - (600 - logSeq) * 700);
    const [lvl, tag, msg] = TAGS[(logSeq * 7 + (logSeq % 5) + (logSeq % 3 ? 5 : 0)) % TAGS.length];
    const text = msg.replace('%p', 'com.example.testapp').replace(/%n/g, () => String(10 + (logSeq * 37) % 900));
    const ts = `${pad(t.getMonth() + 1)}-${pad(t.getDate())} ${pad(t.getHours())}:${pad(t.getMinutes())}:${pad(t.getSeconds())}.${pad(t.getMilliseconds(), 3)}`;
    logLines.push(`${ts} ${String(1000 + logSeq % 4 * 111).padStart(5)} ${String(1000 + logSeq % 4 * 111).padStart(5)} ${lvl} ${tag.padEnd(8)}: ${text}`);
    if (tag === 'AndroidRuntime') logLines.push(`${ts} 1000 1000 E AndroidRuntime: java.lang.NullPointerException: Attempt to invoke virtual method on a null object`, `${ts} 1000 1000 E AndroidRuntime: 	at com.example.testapp.MainActivity.onCreate(MainActivity.java:42)`);
    logSeq++;
  }
}
addLog(500);
const INFO_TEXT = `##props
[ro.product.manufacturer]: [Google]
[ro.product.brand]: [google]
[ro.product.model]: [Pixel 5 (emulator)]
[ro.product.device]: [generic_x86_64]
[ro.hardware]: [ranchu]
[ro.build.version.release]: [11]
[ro.build.version.sdk]: [30]
[ro.build.version.security_patch]: [2020-09-05]
[ro.build.id]: [RSR1.201013.001]
[ro.build.type]: [userdebug]
[ro.build.fingerprint]: [google/sdk_gphone_x86_64/generic_x86_64:11/RSR1.201013.001/6903271:userdebug/dev-keys]
[ro.debuggable]: [1]
[ro.product.cpu.abilist]: [x86_64,x86,arm64-v8a,armeabi-v7a,armeabi]
[ro.opengles.version]: [196609]
[ro.hardware.egl]: [emulation]
[persist.sys.timezone]: [Europe/Moscow]
[persist.sys.locale]: [ru-RU]
##wm
Physical size: 720x1280
Physical density: 320
##uptime
1630.52 3000.00
##mem
MemTotal:        4044324 kB
MemAvailable:    2100000 kB
##df
/dev/block/vdc 5992652 1500000 4400000  26% /data
##battery
  AC powered: true
  USB powered: false
  status: 2
  level: 100
##ip
2: eth0    inet 10.0.2.15/24 brd 10.0.2.255 scope global eth0
##id
uid=0(root) gid=0(root)
##kernel
5.4.0-android11
##pkgs
package:com.example.testapp versionCode:42
package:com.abc.tool versionCode:7
##chrome
    versionName=83.0.4103.106
`;
const send = (res, code, body) => { res.statusCode = code; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(body)); };

export default function mockApi() {
  let allowLaunchOverrides = false;
  const profilePermissions = list => list.map(profile => ({ ...profile, allowLaunchOverrides: profile.allowLaunchOverrides ?? null, launchOverridesAllowed: profile.allowLaunchOverrides ?? allowLaunchOverrides }));
  return {
    name: 'rdf-mock-api',
    transformIndexHtml() {
      return [{ tag: 'script', injectTo: 'head-prepend', children: `(${wsMock.toString()})()` }];
    },
    configureServer(server) {
      server.middlewares.use('/api', (req, res) => {
        const path = (req.url || '/').split('?')[0];
        const m = req.method;
        const state = { user, sessions, host, profiles, tokens, now, adminUsers };
        for (const handler of featureMocks) if (handler(req, res, path, m, state, send)) return;
        if (path === '/admin/launch-settings' && m === 'GET') return send(res, 200, { allowLaunchOverrides });
        if (path === '/admin/launch-settings' && m === 'PATCH') { let body=''; req.on('data', chunk => body+=chunk); req.on('end', () => { allowLaunchOverrides = JSON.parse(body).allowLaunchOverrides === true; send(res, 200, { allowLaunchOverrides }); }); return; }
        if (path === '/config') return send(res, 200, { authMethods: ['local'], limits: { maxSessionsPerUser: 3, idleTimeoutMinutes: 60, maxSessionHours: 8 } });
        if (path === '/me') return send(res, 200, { user: loggedIn ? user : null });
        if (path === '/login') { loggedIn = true; return send(res, 200, { user }); }
        if (path === '/logout') { loggedIn = false; return send(res, 200, {}); }
        if (path === '/navigation-counts' && m === 'GET') {
          const current = sessions.filter(session => ['starting', 'running', 'stopping'].includes(session.state));
          return send(res, 200, { counts: { sessions: current.filter(session => session.ownerId === user.id).length, allSessions: current.length, nodes: 1, profiles: profiles.length, users: adminUsers.length, tokens: tokens.length } });
        }
        if (path === '/hosts') {
          // The baseline live agent keeps reporting during a long test run.
          // Explicit stale timestamps and offline fixture states stay unchanged.
          const lastSeenAt = host.status === 'online' && host.lastSeenAt === iso(0) ? new Date().toISOString() : host.lastSeenAt;
          return send(res, 200, { hosts: [{ ...host, lastSeenAt }] });
        }
        if (path === '/profiles' || path === '/admin/profiles') return send(res, 200, { profiles: profilePermissions(profiles) });
        if (path === '/sessions' && m === 'GET') return send(res, 200, { sessions });
        const sm = path.match(/^\/sessions\/([^/]+)$/);
        if (sm && m === 'GET') return send(res, 200, { session: sessions[0] });
        if (sm && m === 'PATCH') {
          let raw = '';
          req.on('data', c => { raw += c; });
          req.on('end', () => { sessions[0].label = JSON.parse(raw || '{}').label ?? null; send(res, 200, { session: sessions[0] }); });
          return;
        }
        if (/^\/sessions\/[^/]+\/keepalive$/.test(path) && m === 'POST') { sessions[0].idleExpiresAt = new Date(Date.now() + 60 * 60000).toISOString(); return send(res, 200, { session: sessions[0] }); }
        if (sm && m === 'DELETE') return send(res, 200, { ok: true, released: true });
        if (/^\/sessions\/[^/]+\/adb-port-access$/.test(path)) return m === 'GET' ? send(res, 200, { access: { host: '192.0.2.10', port: 15555, expiresAt: null, fingerprint: 'SHA256:q3Fv0m1X', sessionId: 'cbd55091' } }) : send(res, 200, { ok: true });
        const lm = path.match(/^\/sessions\/[^/]+\/(logcat|logcat\/clear|logcat\/apps|device-info)$/);
        if (lm) {
          const q = new URL(req.url, 'http://x').searchParams;
          if (lm[1] === 'device-info') return send(res, 200, { ...parseDeviceInfo(INFO_TEXT), session: { id: sessions[0].id, hostName: 'worker-01', createdAt: sessions[0].createdAt, startedAt: sessions[0].createdAt, orientation: 'portrait', networkEnabled: true, audioEnabled: false }, profile: { id: 'a11-gpu', name: 'Android 11 · NVIDIA GPU', image: 'budtmo/docker-android:emulator_11.0', androidVersion: '11', cpu: 4, memoryMb: 6144, guestMemoryMb: 4096, guestCores: 4, diskGb: 16, gpuMode: 'nvidia', emulatorParams: '-gpu host' } });
          const mockApps = [{ packageName: 'com.example.testapp', uid: 10123 }, { packageName: 'com.android.chrome', uid: 10124 }, { packageName: 'com.example.stopped', uid: 10125 }];
          if (lm[1] === 'logcat/apps') return send(res, 200, { apps: mockApps });
          if (lm[1] === 'logcat/clear') { logLines.length = 0; return send(res, 200, { ok: true }); }
          addLog(Math.floor(Math.random() * 3));
          const options = validateLogcatParams({ lines: q.get('lines') ? Number(q.get('lines')) : undefined, minLevel: q.get('level') || undefined, since: q.get('since') || undefined, skip: q.get('skip') ? Number(q.get('skip')) : undefined });
          const app = mockApps.find(app => app.packageName === q.get('packageName'));
          const allEntries = parseLogcat(logLines.join(String.fromCharCode(10)));
          const appEntries = !app ? allEntries : allEntries.filter(entry => app.packageName === 'com.example.testapp' ? entry.pid === 1000 : app.packageName === 'com.android.chrome' ? entry.pid === 1111 : false);
          return send(res, 200, { ...pageLogcat(appEntries, options), app: app ? { ...app, pids: app.packageName === 'com.example.stopped' ? [] : [app.packageName === 'com.example.testapp' ? 1000 : 1111], sharedPackages: [] } : null });
        }
        if (/\/adb$/.test(path)) return send(res, 200, { stdout: 'ok\n', stderr: '', exitCode: 0 });
        const adbKeyMatch = path.match(/^\/me\/adb-public-keys\/([^/]+)$/);
        if (adbKeyMatch && m === 'PATCH') {
          let raw = '';
          req.on('data', chunk => { raw += chunk; });
          req.on('end', () => {
            const key = adbKeys.find(item => item.id === adbKeyMatch[1]);
            if (!key) return send(res, 404, { error: { code: 'adb_key_not_found', message: messages['ui.ff67904614b1'].en } });
            const name = JSON.parse(raw || '{}').name;
            if (typeof name !== 'string' || !name.trim() || name.length > 80 || /[\x00-\x1f\x7f]/.test(name)) return send(res, 400, { error: { code: 'invalid_adb_key_name', message: messages['ui.31a629668265'].en } });
            key.name = name.trim();
            send(res, 200, { key });
          });
          return;
        }
        if (path === '/me/adb-public-keys') return send(res, 200, { keys: adbKeys });
        if (path === '/me/adb-key') return send(res, 200, { key: { fingerprint: 'SHA256:u5PqL2x', createdAt: iso(60 * 24 * 3) } });
        if (path === '/me/profile' && m === 'GET') return send(res, 200, { profile: userProfile });
        if (path === '/me/profile' && m === 'PATCH') {
          let raw = '';
          req.on('data', chunk => { raw += chunk; });
          req.on('end', () => {
            const fields = JSON.parse(raw || '{}');
            userProfile = { ...userProfile, firstName: fields.firstName ?? null, lastName: fields.lastName ?? null, company: fields.company ?? null, jobTitle: fields.jobTitle ?? null };
            send(res, 200, { profile: userProfile });
          });
          return;
        }
        if (path === '/me/preferences') return send(res, 200, { preferences: prefs });

        if (path === '/me/rentals' || path === '/admin/rentals') return send(res, 200, { rentals, nextCursor: null });
        if (path === '/admin/audit') return send(res, 200, { events: [{ id: 'e1', occurredAt: iso(5), actorUserId: 'u1', actorUsername: 'admin', subjectUserId: null, action: 'session.create', outcome: 'success', targetType: 'session', targetId: 'cbd55091' }], nextCursor: null });
        if (path === '/admin/application-log/stream') {
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
          res.write('event: ready\ndata: {"reset":false,"gap":false,"capacity":2000}\n\n');
          let sequence = 0;
          const emit = (level, message) => {
            const record = { id: '00000000-0000-4000-8000-000000000000:' + ++sequence, occurredAt: new Date().toISOString(), level, message };
            res.write('id: ' + record.id + '\nevent: entry\ndata: ' + JSON.stringify(record) + '\n\n');
          };
          emit('info', 'Remote Device Farm API listening on 8080');
          emit('warning', 'Node policy refresh failed: node is temporarily unavailable');
          emit('error', 'Emulator image background reconciliation failed; retrying');
          const timer = setInterval(() => emit('info', 'Host metrics sample completed'), 3000);
          res.on('close', () => clearInterval(timer));
          return;
        }
        if (path === '/admin/logs') return send(res, 200, { events: [{ id: 'l1', occurredAt: iso(9), service: 'agent', severity: 'warning', code: 'dns_timeout', hostId: 'h1', sessionId: null }], nextCursor: null });
        if (path === '/admin/agents') return send(res, 200, { agents: [{ hostId: 'h1', createdAt: iso(60 * 24 * 30), name: 'worker-01', status: 'active', source: 'environment', canRevoke: false, lastSeenAt: iso(1) }] });
        if (path === '/admin/agent-bundle/info') return send(res, 200, { version: '0.4.2', filename: 'agent.tar.gz', sha256: 'ab12cd34ef56', sizeBytes: 18200000 });
        if (path === '/admin/users' && m === 'GET') return send(res, 200, { users: adminUsers });
        if (path === '/admin/users' && m === 'POST') {
          let raw = '';
          req.on('data', chunk => { raw += chunk; });
          req.on('end', () => {
            const fields = JSON.parse(raw || '{}');
            const created = { id: 'u' + (++nextUserId), username: fields.username, displayName: fields.displayName, role: fields.role || 'user', provider: 'local', company: fields.company || null, jobTitle: fields.jobTitle || null, createdAt: new Date().toISOString() };
            setMockRole(created,fields.roleId);
            adminUsers.push(created);
            send(res, 201, { user: created });
          });
          return;
        }
        const passwordUserMatch = path.match(/^\/admin\/users\/([^/]+)\/password$/);
        if (passwordUserMatch && m === 'POST') {
          const existing = adminUsers.find(person => person.id === passwordUserMatch[1]);
          if (!existing) return send(res, 404, { error: { code: 'not_found', message: 'Пользователь не найден' } });
          if (existing.provider !== 'local') return send(res, 409, { error: { code: 'managed_password', message: 'Пароль управляется внешним сервисом' } });
          let raw = '';
          req.on('data', chunk => { raw += chunk; });
          req.on('end', () => {
            const password = JSON.parse(raw || '{}').newPassword;
            if (typeof password !== 'string' || password.length < 12 || password.length > 2048) return send(res, 400, { error: { code: 'invalid_password', message: 'Не менее 12 символов' } });
            send(res, 200, { ok: true });
          });
          return;
        }
        const userMatch = path.match(/^\/admin\/users\/([^/]+)$/);
        if (userMatch && m === 'DELETE') {
          const index = adminUsers.findIndex(person => person.id === userMatch[1]);
          if (index < 0) return send(res, 404, { error: { message: 'Пользователь не найден' } });
          if (adminUsers[index].id === user.id) return send(res, 409, { error: { message: 'Нельзя удалить свою учётную запись' } });
          adminUsers.splice(index, 1);
          return send(res, 200, { ok: true });
        }
        if (userMatch && m === 'PATCH') {
          const existing = adminUsers.find(person => person.id === userMatch[1]);
          if (!existing) return send(res, 404, { error: 'mock: user not found' });
          let raw = '';
          req.on('data', chunk => { raw += chunk; });
          req.on('end', () => {
            const fields = JSON.parse(raw || '{}');
            Object.assign(existing, { displayName: fields.displayName, company: fields.company || null, jobTitle: fields.jobTitle || null });
            send(res, 200, { user: existing });
          });
          return;
        }
        if (path === '/tokens' || path === '/admin/tokens') return send(res, 200, { tokens: path === '/tokens' ? tokens : [] });
        if (/\/slots$/.test(path)) return send(res, 200, { occupants: [] });
        return send(res, 404, { error: 'mock: not implemented ' + path });
      });
    },
  };
}

// Runs in the browser: a fake device stream drawn on a canvas.
function wsMock() {
  const Real = window.WebSocket;
  window.WebSocket = function (url, p) {
    if (!/\/api\/sessions\/.+\/stream/.test(String(url))) return new Real(url, p);
    const s = { readyState: 0, bufferedAmount: 0, send(raw) { const message = JSON.parse(raw); if (message.type === 'ping') queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ type: 'pong', id: message.id, serverTime: Date.now() }) })); }, close() { this.readyState = 3; this.onclose?.({}); }, onopen: null, onmessage: null, onclose: null, onerror: null, addEventListener() {}, removeEventListener() {} };
    setTimeout(() => {
      if (s.readyState === 3) return;
      s.readyState = 1; s.onopen && s.onopen({});
      s.onmessage?.({ data: JSON.stringify({ type: 'ready', inputEpoch: crypto.randomUUID(), serverTime: Date.now(), inputMaxAgeMs: 1500 }) });
      if (String(url).includes('transport=webrtc')) { s.onmessage?.({ data: JSON.stringify({ type: 'rtc-capabilities', available: false, reason: 'Локальный макет не передаёт WebRTC.' }) }); return; }
      const c = document.createElement('canvas'); c.width = 720; c.height = 1280; const g = c.getContext('2d');
      const grad = g.createLinearGradient(0, 0, 0, 1280); grad.addColorStop(0, '#f4a8c6'); grad.addColorStop(.55, '#d79ac4'); grad.addColorStop(.8, '#8a4a97'); grad.addColorStop(1, '#3d1450');
      g.fillStyle = grad; g.fillRect(0, 0, 720, 1280);
      g.fillStyle = '#fff'; g.font = '300 56px sans-serif'; g.textAlign = 'center'; g.fillText('Friday, Oct 2  10°C', 360, 220);
      g.font = '28px sans-serif'; g.textAlign = 'left'; g.fillText('6:20', 28, 44);
      [['#1a73e8', 120], ['#2f80ed', 280], ['#ea4335', 560]].forEach(([col, x]) => { g.fillStyle = col; g.beginPath(); g.arc(x + 50, 980, 56, 0, 7); g.fill(); });
      g.fillStyle = 'rgba(255,255,255,.92)'; g.beginPath(); g.roundRect(50, 1070, 620, 90, 45); g.fill();
      const data = c.toDataURL('image/jpeg', .8).split(',')[1];
      s.onmessage && s.onmessage({ data: JSON.stringify({ type: 'frame', mime: 'image/jpeg', data, width: 720, height: 1280 }) });
    }, 150);
    return s;
  };
  window.WebSocket.OPEN = 1; window.WebSocket.CLOSED = 3; window.WebSocket.CONNECTING = 0; window.WebSocket.CLOSING = 2;
}
