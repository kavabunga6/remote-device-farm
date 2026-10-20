import { expect, test } from '@playwright/test';
import path from 'node:path';
const id = 'cbd55091-aaaa-bbbb-cccc-000000000001';

for (const theme of ['light', 'dark']) {
  test(`console history and pending commands stay scoped to the session in ${theme} theme`, async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.route('**/api/me/preferences', route => route.fulfill({ json: { preferences: { theme, fontFamily: 'system', fontScale: 1 } } }));
    await page.route('**/api/me/notifications', route => route.fulfill({ json: { notifications: [] } }));
    let count = 0;
    let finish: (() => Promise<void>) | undefined;
    await page.route('**/api/sessions/*/adb', async route => {
      count++;
      if (count === 1) await route.fulfill({ json: { stdout: 'confirmed-output', stderr: '', exitCode: 0 } });
      else await new Promise<void>(resolve => { finish = async () => { await route.fulfill({ json: { stdout: 'late-output', stderr: '', exitCode: 0 } }).catch(() => {}); resolve(); }; });
    });
    await page.goto('/#/session/' + id);
    const input = page.getByRole('textbox', { name: 'Команда для выбранного устройства' });
    await expect(input).toBeEnabled();
    await input.fill('getprop ro.product.model');
    await input.press('Enter');
    await expect(page.locator('.terminal-output')).toContainText('confirmed-output');
    await input.press('ArrowUp');
    await expect(input).toHaveValue('getprop ro.product.model');
    if (process.env.UI_CAPTURE_DIR) await page.screenshot({ path: path.join(process.env.UI_CAPTURE_DIR, 'console-' + theme + '.png') });
    await input.press('Enter');
    await expect.poll(() => Boolean(finish)).toBe(true);
    await page.evaluate(() => { window.location.hash = '/'; });
    await expect(input).toHaveCount(0);
    await page.evaluate(session => { window.location.hash = '/session/' + session; }, id);
    await expect(input).toBeEnabled();
    await finish!();
    await expect(page.locator('.terminal-output')).not.toContainText('late-output');
    await expect(page.locator('.terminal-output')).not.toContainText('confirmed-output');
  });
}
