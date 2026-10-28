import { expect, test } from '@playwright/test';
import path from 'node:path';

for (const [theme, language] of [['light', 'ru'], ['dark', 'en']] as const) {
  test(`provider failure and recovery remain visible in ${theme}/${language}`, async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.addInitScript(lang => localStorage.setItem('rdf.language', lang), language);
    await page.route('**/api/me/preferences', route => route.fulfill({ json: { preferences: { theme, fontFamily: 'system', fontScale: 1 } } }));
    await page.route('**/api/me/notifications', route => route.fulfill({ json: { notifications: [] } }));
    let ready = false;
    let hostId = '';
    await page.route('**/api/hosts', async route => {
      const body = await (await route.fetch()).json();
      const host = body.hosts[0]; hostId = host.id;
      await route.fulfill({ json: { hosts: [{ ...host, status: 'online', lastSeenAt: new Date().toISOString(), devices: [],
        providers: [{ kind: 'emulator', platform: 'android', status: 'ready', code: null },
          { kind: 'usb-android', platform: 'android', status: ready ? 'ready' : 'unavailable', code: ready ? null : 'inventory-unavailable' }],
      }] } });
    });
    await page.goto('/#/admin/nodes');
    const warning = page.locator('.node-overview .node-provider-row[data-state=unavailable]');
    await expect(warning).toContainText('USB Android');
    await page.evaluate(id => { window.location.hash = '/admin/nodes?host=' + encodeURIComponent(id); }, hostId);
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    const status = dialog.locator('.node-provider-status');
    await expect(status.locator('[data-state=unavailable]')).toContainText(language === 'ru' ? 'Не удалось получить список устройств' : 'Could not list devices');
    const alignment = await status.locator('.node-provider-row>div').evaluateAll(rows => rows.map(row => {
      const [name, state] = row.children;
      const nameBox = name.getBoundingClientRect(), stateBox = state.getBoundingClientRect();
      return { delta: Math.abs(nameBox.y - stateBox.y), overlap: nameBox.right > stateBox.left };
    }));
    expect(alignment.every(row => row.delta < 2 && !row.overlap)).toBe(true);
    if (process.env.UI_CAPTURE_DIR) await page.screenshot({ path: path.join(process.env.UI_CAPTURE_DIR, 'providers-' + theme + '.png') });
    ready = true;
    await page.reload();
    await expect(page.getByRole('dialog').locator('.node-provider-row[data-state=ready]')).toHaveCount(2);
    await expect(page.getByRole('dialog').locator('.node-provider-row[data-state=unavailable]')).toHaveCount(0);
  });
}
