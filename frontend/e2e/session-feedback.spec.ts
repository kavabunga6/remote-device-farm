import { expect, test } from '@playwright/test';
const sessionId = 'cbd55091-aaaa-bbbb-cccc-000000000001';
for (const [width, theme, scale] of [[1440, 'light', 1], [1440, 'dark', 1.25], [390, 'light', 1], [390, 'dark', 1.5]] as const) {
  test(`upload feedback floats without resizing the device at ${width} ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.route('**/api/me/preferences', route => route.fulfill({ json: { preferences: { theme, fontScale: scale, fontFamily: 'system' } } }));
    await page.route('**/api/me/notifications', route => route.fulfill({ json: { notifications: [] } }));
    let finish!: () => void;
    const gate = new Promise<void>(resolve => { finish = resolve; });
    await page.route('**/api/sessions/'+sessionId+'/files', async route => {
      await gate; await route.fulfill({ json: { path: '/sdcard/Download/rootCA.pem' } });
    });
    await page.goto('/#/session/'+sessionId);
    await expect(page.locator('[data-media=video]')).toHaveAttribute('data-state', 'live');
    await page.evaluate(() => document.fonts.ready);
    const geometry = () => page.locator('.viewer-panel,.viewer-stage,.device-screen').evaluateAll(nodes => nodes.map(node => {
      const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height };
    }));
    const before = await geometry();
    try {
      await page.locator('.viewer-panel input[type=file][multiple]').setInputFiles({ name: 'rootCA.pem', mimeType: 'application/x-pem-file', buffer: Buffer.from('fixture certificate') });
      await expect(page.locator('.notification-title')).toHaveText('Передаём файл');
      expect(await geometry()).toEqual(before);
      finish();
      await expect(page.locator('.notification-title')).toHaveText('Файл загружен');
      await expect(page.locator('.notification-message')).toContainText('rootCA.pem');
      await expect(page.locator('.viewer-panel .upload-feedback,.viewer-panel .capture-feedback,.viewer-panel .audio-notice')).toHaveCount(0);
      expect(await geometry()).toEqual(before);
      expect(await page.evaluate(() => document.documentElement.scrollWidth-innerWidth)).toBeLessThanOrEqual(1);
      await page.screenshot({ path: `../.tmp-ui/session-feedback/upload-${width}-${theme}.png` });
    } finally { finish(); }
  });
}

test('ready feedback commits with the session card and does not replay a late server notification', async ({ page }) => {
  await page.clock.install();
  let running = false, lateNotice = false;
  await page.route('**/api/sessions', async route => {
    const data = await (await route.fetch()).json();
    data.sessions = data.sessions.map((session: any) => ({ ...session, state: running ? 'running' : 'starting' }));
    await route.fulfill({ json: data });
  });
  await page.route('**/api/me/notifications', route => route.fulfill({ json: { notifications: lateNotice ? [{ id: sessionId, sessionId, kind: 'session.ready', title: 'Устройство готово', body: 'Android 11', createdAt: new Date().toISOString() }] : [] } }));
  await page.goto('/#/overview');
  await expect(page.locator('.session-card').first()).toContainText('Запускается');
  await page.evaluate(() => {
    (window as any).__readyTrace = [];
    new MutationObserver(() => {
      const running = [...document.querySelectorAll('.session-card .status-badge')].some(node => node.textContent?.includes('Работает'));
      if (running) (window as any).__readyTrace.push([...document.querySelectorAll('.notification-title')].some(node => node.textContent === 'Устройство готово'));
    }).observe(document.body, { childList: true, subtree: true, characterData: true });
  });
  running = true; await page.clock.fastForward(10_000);
  await expect(page.locator('.session-card').first()).toContainText('Работает');
  await expect(page.locator('.notification-title')).toHaveText('Устройство готово');
  expect(await page.evaluate(() => (window as any).__readyTrace)).not.toContain(false);
  await page.locator('.notification-close').click();
  lateNotice = true; await page.clock.fastForward(10_000);
  await expect(page.locator('.notification-toast')).toHaveCount(0);
});

test('start request is acknowledged while its API response is pending', async ({ page }) => {
  let finish!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  await page.route('**/api/me/notifications', route => route.fulfill({ json: { notifications: [] } }));
  await page.route('**/api/sessions', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    await gate;
    await route.fulfill({ status: 503, json: { error: { message: 'Тестовый отказ запуска' } } });
  });
  await page.goto('/#/overview');
  await page.locator('.session-card').first().getByRole('button', { name: 'Ещё такой же' }).click();
  const dialog = page.getByRole('dialog', { name: 'Новая сессия', exact: true });
  try {
    await dialog.getByRole('button', { name: 'Запустить', exact: true }).click();
    await expect(dialog.locator('.notification-title')).toHaveText('Отправляем запрос запуска');
    finish();
    await expect(dialog.locator('.notification-title')).toHaveText('Не удалось начать запуск');
  } finally { finish(); }
});
