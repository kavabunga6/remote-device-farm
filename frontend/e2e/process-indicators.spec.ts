import { expect, test } from '@playwright/test';
const id = 'cbd55091-aaaa-bbbb-cccc-000000000001';
for (const [width, theme, scale] of [[1440, 'light', 1], [1440, 'dark', 1.25], [390, 'light', 1.25], [390, 'dark', 1]] as const) {
  test(`session process motion follows state at ${width} ${theme}`, async ({ page }) => {
    let state = 'starting';
    await page.setViewportSize({ width, height: 900 });
    await page.route('**/api/me/notifications', route => route.fulfill({ json: { notifications: [] } }));
    await page.route('**/api/me/preferences', route => route.fulfill({ json: { preferences: { theme, fontScale: scale, fontFamily: 'system' } } }));
    await page.route('**/api/sessions', async route => {
      const body = await (await route.fetch()).json();
      body.sessions = body.sessions.map((session: any) => ({ ...session, state, startupProgress: { stage: 'booting' } }));
      await route.fulfill({ json: body });
    });
    await page.goto('/#/overview');
    const card = page.locator('.session-card').filter({ has: page.locator('.status-starting') }).first();
    await expect(card).toContainText('Запускается');
    const spinner = card.locator('.status-badge .activity-indicator');
    await expect(spinner).toHaveCount(1);
    await page.evaluate(() => document.fonts.ready);
    expect(await spinner.evaluate(node => getComputedStyle(node).animationName)).toBe('spin');
    const rotation = await spinner.evaluate(async node => {
      const first = getComputedStyle(node).transform;
      await new Promise(resolve => setTimeout(resolve, 180));
      return [first, getComputedStyle(node).transform];
    });
    expect(rotation[0]).not.toBe(rotation[1]);
    const rect = await card.locator('.status-badge').boundingBox();
    const icon = await card.locator('.session-status-icon').boundingBox();
    expect(Math.abs(rect!.y + rect!.height / 2 - icon!.y - icon!.height / 2)).toBeLessThanOrEqual(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth-innerWidth)).toBeLessThanOrEqual(1);
    await page.screenshot({ path: `../.tmp-ui/process-indicators/${width}-${theme}.png` });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    expect(await spinner.evaluate(node => getComputedStyle(node).animationName)).toBe('none');
    state = 'running';
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    const running = page.locator('.session-card').filter({ has: page.locator('.status-running') }).first();
    await expect(running).toContainText('Работает');
    await expect(running.locator('.activity-indicator')).toHaveCount(0);
    expect((await running.locator('.status-badge').boundingBox())!.height).toBe(rect!.height);
    state = 'stopping';
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    const stopping = page.locator('.session-card').filter({ has: page.locator('.status-stopping') }).first();
    await expect(stopping).toContainText('Останавливается');
    await expect(stopping.locator('.activity-indicator')).toHaveCount(1);
  });
}

test('pending upload toast remains visible until the operation completes', async ({ page }) => {
  await page.clock.install();
  let finish!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  await page.route('**/api/me/notifications', route => route.fulfill({ json: { notifications: [] } }));
  await page.route('**/api/sessions/'+id+'/files', async route => {
    await gate; await route.fulfill({ json: { path: '/sdcard/Download/test.pem' } });
  });
  await page.goto('/#/session/'+id);
  await expect(page.locator('.device-controls')).toBeVisible();
  try {
    await page.locator('.viewer-panel input[type=file][multiple]').setInputFiles({ name: 'test.pem', mimeType: 'text/plain', buffer: Buffer.from('test') });
    const toast = page.locator('.notification-toast');
    await expect(toast.locator('.activity-indicator')).toHaveCount(1);
    await page.clock.fastForward(20_000);
    await expect(toast).toContainText('Передаём файл');
    finish();
    await expect(toast).toContainText('Файл загружен');
    await expect(toast.locator('.activity-indicator')).toHaveCount(0);
    await page.clock.fastForward(6_001);
    await expect(toast).toHaveCount(0);
  } finally { finish(); }
});
