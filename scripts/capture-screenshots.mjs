import { createRequire } from 'node:module';
import { readFileSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(new URL('../frontend/package.json', import.meta.url));
const { chromium } = require('@playwright/test');
const port = Number(process.env.MOCK_PORT || 5198);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid MOCK_PORT');
const base = `http://127.0.0.1:${port}`;
const html = await (await fetch(base, { signal: AbortSignal.timeout(5000) })).text();
if (!html.includes('function wsMock(')) throw new Error('Start frontend/dev/run-mock.mjs before capture');
const output = resolve(root, 'docs/screenshots');
mkdirSync(output, { recursive: true });
const deskOnly = process.argv.includes('--desk-only');
const sessionOnly = process.argv.includes('--session-only');
const partialCapture = deskOnly || sessionOnly;
function saveCapture(file, bytes) {
  const temporary = resolve(output, '.tmp-' + file);
  writeFileSync(temporary, bytes);
  renameSync(temporary, resolve(output, file));
}
const stamp = new Date();
const earlier = minutes => new Date(stamp.getTime() - minutes * 60000).toISOString();
const sid = 'cbd55091-aaaa-bbbb-cccc-000000000001';
const repo = 'registry.example.test/rdf-emulator';
const digest = letter => 'sha256:' + letter.repeat(64);
const imageDigest = index => digest('abcdef01'[index]);
const versions = [
  { api: '37', android: '17' }, { api: '36.1', android: '16' },
  { api: '35', android: '15' }, { api: '34', android: '14' },
];
const profiles = versions.flatMap(({ api, android }, index) => ['mobile', 'tablet'].map((deviceType, variant) => ({
  id: index === 0 ? variant ? 'a13' : 'a11-gpu' : 'android-' + api + '-' + deviceType,
  name: (variant ? 'Tablet · ' : '') + 'Android ' + android + ' · Google APIs',
  androidVersion: android, apiLevel: Number(api), abi: 'x86_64', deviceType, imageFlavor: 'google_apis',
  image: repo + ':' + api + '-google_apis-x86_64@' + imageDigest(index * 2),
  imageContract: 'emulator-v1', cpu: variant ? 8 : 6, memoryMb: variant ? 8192 : 6144,
  guestMemoryMb: 4096, guestCores: variant ? 6 : 4, diskGb: variant ? 16 : 8,
  enabled: index !== 3, recommended: index === 0 && !variant,
  deviceModel: variant ? 'Tablet' : 'Pixel 6', resolution: variant ? '2560x1600' : '1080x2400',
})));
const sessions = profiles.slice(0, 2).map((profile, index) => ({
  id: index ? '00000000-0000-4000-8000-000000000002' : sid,
  deviceKind: 'emulator', platform: 'android', sdkLevel: profile.apiLevel, osVersion: profile.androidVersion,
  ownerId: 'u1', ownerName: 'admin', hostId: 'h1', hostName: 'worker-01',
  profileId: profile.id, profileName: profile.name, state: index ? 'starting' : 'running',
  gpuMode: index ? 'off' : 'nvidia', orientation: 'portrait', audioEnabled: false, networkEnabled: true,
  createdAt: earlier(index ? 1 : 12), lastActivityAt: earlier(0),
  idleExpiresAt: new Date(stamp.getTime() + 45 * 60000).toISOString(),
  expiresAt: new Date(stamp.getTime() + 6 * 3600000).toISOString(), label: null,
}));
const images = versions.flatMap(({ api }, index) => [0, 1].map(older => ({
  digest: imageDigest(index * 2 + older),
  tags: older ? [] : [api + '-google_apis-x86_64'],
  package: 'system-images;android-' + api + ';google_apis;x86_64',
  sizeBytes: (2.5 - index * .2) * 1024 ** 3,
  createdAt: earlier((index + older + 1) * 1440), children: [], known: true,
  uses: older ? [] : [
    { kind: 'catalog', id: 'catalog-' + api, name: 'Google APIs', image: profiles[index * 2].image },
    ...profiles.slice(index * 2, index * 2 + 2).map(profile => ({
      kind: 'profile', id: profile.id, name: profile.name, image: profile.image,
    })),
  ],
  blockers: [],
})));

const permissionCatalog = JSON.parse(readFileSync(resolve(root, 'shared/permissions.json'), 'utf8'));
const qaPermissions = [...new Set([...permissionCatalog.user, 'profiles.view', 'images.view', 'logs.view'])];
const deskWindows = {
  device: { left: 40, top: 72, width: 520, height: 856 },
  tools: { left: 592, top: 72, width: 968, height: 382 },
};
const deskLogcat = { left: 592, top: 478, width: 968, height: 450 };
const environmentWindows = {
  ...deskWindows,
  tools: { left: 592, top: 72, width: 464, height: 856 },
};
const demoCommands = new Map([
  ['getprop ro.product.model', profiles[0].deviceModel],
  ['wm size', 'Physical size: ' + profiles[0].resolution],
]);
const demoEnvironment = {
  proxy: { enabled: false, host: '', port: 0 },
  darkMode: 'auto', fontScale: 1, animations: true, showTouches: true, pointerLocation: false,
  timezone: 'UTC', size: { physical: profiles[0].resolution, override: null },
  density: { physical: 420, override: null }, battery: { level: 85, charging: 'ac' },
};
const screens = [
  { id: 'sessions-dark', route: 'overview', theme: 'dark', selector: '.session-card' },
  { id: 'device-dark', route: 'session/' + sid, theme: 'dark', selector: '.device-screen', layout: 'split' },
  { id: 'logcat-light', route: 'session/' + sid, theme: 'light', selector: '[role=tablist]', tab: 'Logcat', layout: 'split' },
  {
    id: 'desk-logcat-dark', route: 'session/' + sid, theme: 'dark', selector: '.device-screen', layout: 'desk', desk: 'diagnostics',
    windows: deskWindows, widgets: { logs: deskLogcat },
  },
  {
    id: 'desk-environment-light', route: 'session/' + sid, theme: 'light', selector: '.device-screen', layout: 'desk', desk: 'environment',
    windows: environmentWindows, widgets: { env: { left: 1080, top: 72, width: 480, height: 856 } },
  },
  { id: 'desk-overview-light', route: 'session/' + sid, theme: 'light', selector: '.device-screen', layout: 'desk', desk: 'overview' },
  { id: 'nodes-light', route: 'admin/nodes', theme: 'light', selector: '.host-card', fullPage: true },
  { id: 'agent-onboarding-dark', route: 'admin/nodes', theme: 'dark', selector: '.host-card', publicOrigin: true },
  { id: 'profiles-light', route: 'admin/profiles', theme: 'light', selector: '.admin-profile-row', fullPage: true },
  { id: 'images-dark', route: 'admin/images', theme: 'dark', selector: '.image-inventory-table tbody tr' },
  { id: 'roles-light', route: 'admin/roles', theme: 'light', selector: 'h1', fullPage: true },
  { id: 'login-dark', route: 'overview', theme: 'dark', login: true, selector: '.login-card' },
];
const manifest = { capturedAt: stamp.toISOString(), source: 'Current UI with mock API and demo data', language: 'en', viewport: { width: 1600, height: 1000 }, screens: [] };
const previousManifest = partialCapture ? JSON.parse(readFileSync(resolve(output, 'manifest.json'), 'utf8')) : null;
const captures = new Map(previousManifest?.screens.map(screen => [screen.file, screen]));
const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome' });
try {
  for (const screen of screens) {
    if (deskOnly && !screen.desk || sessionOnly && !screen.route.startsWith('session/')) continue;
    const context = await browser.newContext({ viewport: manifest.viewport, colorScheme: screen.theme, locale: 'en-US', reducedMotion: 'reduce' });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(({ theme, layout, profileId, windows, widgets }) => {
      localStorage.setItem('rdf.language', 'en');
      localStorage.setItem('rdf.theme', theme);
      if (layout) localStorage.setItem('rdf-session-default-view:u1', layout);
      const scope = 'u1:' + encodeURIComponent('profile:' + profileId);
      if (windows) localStorage.setItem(`rdf-session-floating-v3:${scope}:initial:base`, JSON.stringify({ front: 'tools', windows }));
      for (const [id, geometry] of Object.entries(widgets)) {
        localStorage.setItem(`rdf-session-desk-widget-v1:${scope}:${id}`, JSON.stringify(geometry));
      }
    }, {
      theme: screen.theme, layout: screen.layout, profileId: sessions[0].profileId,
      windows: screen.desk ? screen.windows ?? deskWindows : undefined,
      widgets: screen.desk ? screen.widgets ?? { logs: deskLogcat } : {},
    });
    if (screen.publicOrigin) await page.route('https://farm.example.test/**', async route => {
      const url = new URL(route.request().url());
      await route.fulfill({ response: await route.fetch({ url: base + url.pathname + url.search }) });
    });
    await page.route('**/api/**', async route => {
      const request = route.request(), path = new URL(request.url()).pathname;
      const sessionPath = '/api/sessions/' + sid;
      if (screen.desk === 'diagnostics' && path === sessionPath + '/adb' && request.method() === 'POST') {
        const { argv } = request.postDataJSON();
        const stdout = Array.isArray(argv) && argv.length === 2 && argv[0] === 'shell' ? demoCommands.get(argv[1]) : undefined;
        if (stdout !== undefined) return route.fulfill({ json: { stdout: stdout + '\n', stderr: '', exitCode: 0 } });
      }
      if (request.method() !== 'GET') return route.abort();
      if (path === '/api/me/preferences') return route.fulfill({ json: { preferences: { theme: screen.theme, fontFamily: 'system', fontScale: 1, defaultAdbKeyId: null } } });
      if (path === '/api/hosts') {
        const payload = await (await route.fetch({ url: base + path })).json();
        return route.fulfill({ json: { hosts: payload.hosts.map(host => ({ ...host, usedSlots: sessions.length, slotCpu: 8, slotMemoryMb: 8192 })) } });
      }
      if (path === '/api/queue') return route.fulfill({ json: { entries: [{
        id: 'demo-queue', profileId: profiles[2].id, profileName: profiles[2].name,
        hostId: null, hostName: null, label: null, position: 1, createdAt: earlier(4),
        expiresAt: new Date(stamp.getTime() + 26 * 60000).toISOString(),
      }], maxEntries: 3 } });
      if (path === '/api/shares/mine') return route.fulfill({ json: { shares: [{
        sessionId: '00000000-0000-4000-8000-000000000003', ownerName: 'Alex Chen',
        profileName: profiles[2].name, label: 'Compatibility checks', mode: 'view',
        expiresAt: new Date(stamp.getTime() + 42 * 60000).toISOString(),
      }] } });
      if (path === '/api/me/notifications') return route.fulfill({ json: { notifications: [] } });
      if (path === '/api/admin/roles') return route.fulfill({ json: { roles: [
        { id: 'r-admin', name: 'Administrator', builtin: 'admin', permissions: permissionCatalog.groups.flatMap(g => g.actions.map(a => a.id)), userCount: 1 },
        { id: 'r-user', name: 'User', builtin: 'user', permissions: permissionCatalog.user, userCount: 1 },
        { id: 'r-qa', name: 'QA Engineer', builtin: null, permissions: qaPermissions, userCount: 0 },
      ], catalog: permissionCatalog.groups } });
      if (screen.login && path === '/api/me') return route.fulfill({ json: { user: null } });
      if (['/api/profiles', '/api/admin/profiles'].includes(path)) return route.fulfill({ json: { profiles } });
      if (path === '/api/sessions') return route.fulfill({ json: { sessions } });
      if (path === sessionPath) return route.fulfill({ json: { session: sessions[0] } });
      if (screen.desk === 'environment' && path === sessionPath + '/env') return route.fulfill({ json: { env: demoEnvironment } });
      if (screen.desk === 'environment' && path === sessionPath + '/device-info') {
        const info = await (await route.fetch()).json();
        const profile = profiles[0];
        const [width, height] = profile.resolution.split('x').map(Number);
        return route.fulfill({ json: {
          ...info, collectedAt: stamp.toISOString(),
          session: { ...info.session, id: sid, createdAt: sessions[0].createdAt, startedAt: sessions[0].createdAt },
          profile: { ...profile, gpuMode: sessions[0].gpuMode },
          device: { ...info.device, model: profile.deviceModel },
          android: { ...info.android, release: profile.androidVersion, sdk: profile.apiLevel, securityPatch: null, buildId: null, fingerprint: null },
          display: { ...info.display, physical: { width, height }, density: demoEnvironment.density.physical },
          system: { ...info.system, timezone: demoEnvironment.timezone, locale: 'en-US' },
          battery: { ...info.battery, level: demoEnvironment.battery.level },
        } });
      }
      if (path === '/api/admin/image-management/registry') return route.fulfill({ json: { supported: true, repository: repo, items: images, maintenance: false } });
      if (path === '/api/navigation-counts') return route.fulfill({ json: { counts: { sessions: 2, allSessions: 2, nodes: 1, profiles: profiles.length, images: images.length, users: 2, tokens: 2 } } });
      if (screen.publicOrigin) return route.fallback();
      return route.continue();
    });
    await page.goto((screen.publicOrigin ? 'https://farm.example.test' : base) + '/#/' + screen.route);
    await page.locator(screen.selector).first().waitFor({ timeout: 15000 });
    if (screen.id === 'agent-onboarding-dark') {
      await page.getByRole('button', { name: 'Connect a node', exact: true }).click();
      await page.locator('.agent-package-row').waitFor();
    }
    if (screen.id === 'roles-light') await page.getByRole('button', { name: /^QA Engineer/ }).click();
    if (screen.tab) { await page.getByRole('tab', { name: screen.tab, exact: true }).click(); await page.locator('.log-panel').waitFor(); }
    if (screen.layout) await page.waitForFunction(() => {
      const frame = document.querySelector('.device-screen img.active-frame');
      return frame?.complete && frame.naturalWidth > 0;
    });
    if (screen.tab || (screen.desk && screen.desk !== 'environment')) await page.locator('.log-panel .log-row').first().waitFor();
    if (screen.desk === 'diagnostics') {
      const input = page.locator('.terminal-input input');
      for (const [command, stdout] of demoCommands) {
        await input.fill(command);
        await input.press('Enter');
        await page.locator('.terminal-entry pre').filter({ hasText: stdout }).waitFor();
      }
      await input.blur();
      await page.locator('.terminal-output').evaluate(terminal => { terminal.scrollTop = 0; });
    }
    if (screen.desk === 'environment') {
      await page.locator('#tool-tab-info').click();
      await page.locator('.info-panel').getByText('Google ' + profiles[0].deviceModel, { exact: true }).waitFor();
      await page.locator('.env-app[open] summary').click();
      await page.locator('.env-card:last-child summary').waitFor();
      await page.mouse.move(36, 960);
    }
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(600);
    if (screen.desk) await page.mouse.move(12, 960);
    if (screen.desk === 'overview') {
      await page.getByRole('button', { name: 'Window overview', exact: true }).click();
      await page.getByRole('dialog', { name: 'Window overview', exact: true }).waitFor();
      await page.waitForFunction(() => document.querySelectorAll('[data-window-preview]').length === 3);
    }
    const geometry = await page.evaluate(() => ({ theme: document.documentElement.dataset.effectiveTheme, overflow: Math.max(0, document.documentElement.scrollWidth - innerWidth) }));
    if (errors.length || geometry.overflow > 1 || geometry.theme !== screen.theme) throw new Error(JSON.stringify({ screen: screen.id, errors, ...geometry }));
    const file = screen.id + '.png';
    saveCapture(file, await page.screenshot({ animations: 'disabled', fullPage: screen.fullPage === true }));
    captures.set(file, {
      file, route: screen.route, theme: screen.theme, horizontalOverflow: geometry.overflow, browserErrors: errors,
      ...(partialCapture ? { capturedAt: stamp.toISOString() } : {}),
    });
    console.log(file);
    await context.close();
  }
  const entries = screens.map(screen => captures.get(screen.id + '.png')).filter(Boolean);
  saveCapture('manifest.json', JSON.stringify({ ...(previousManifest ?? manifest), screens: entries }, null, 2) + '\n');
} finally { await browser.close(); }
