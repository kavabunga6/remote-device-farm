import { expect, test } from '@playwright/test';

const profiles = Array.from({ length: 10 }, (_, index) => ({
  id: 'inventory-' + index,
  name: index === 8 ? 'Android 17 · Google APIs · Tablet · Extended integration environment' : 'Android ' + (17 - index % 4) + ' · Google APIs',
  androidVersion: String(17 - index % 4), apiLevel: 37 - index % 4, abi: 'x86_64',
  deviceType: index % 2 ? 'tablet' : 'mobile', imageFlavor: 'google_apis',
  image: 'registry.example.com/android:verified-' + index, enabled: index !== 3,
  cpu: 6, memoryMb: 6144, guestCores: 4, guestMemoryMb: 4096, diskGb: 16,
  deviceModel: index % 2 ? 'Tablet' : 'Pixel', resolution: '1080x1920',
  gpuMode: 'software', emulatorParams: '', recommended: index === 0,
}));

for (const [name, theme, width, fontScale, language] of [
  ['light', 'light', 1366, 1, 'ru'], ['dark', 'dark', 1366, 1, 'ru'],
  ['narrow-desktop', 'dark', 1024, 1, 'ru'], ['english', 'light', 1366, 1, 'en'],
  ['large-german', 'light', 1366, 1.25, 'de'], ['arabic', 'dark', 1366, 1, 'ar'],
] as const) {
  test('profile inventory stays compact and aligned in ' + name, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(value => localStorage.setItem('rdf.language', value), language);
    await page.route('**/api/me/preferences', route => route.fulfill({ json: {
      preferences: { theme, fontFamily: 'system', fontScale, defaultAdbKeyId: null },
    } }));
    await page.route(/\/api\/(admin\/)?profiles$/, route => route.fulfill({ json: { profiles } }));
    await page.goto('/#/admin/profiles');
    await expect(page.locator('html')).toHaveAttribute('lang', language);
    await expect(page.locator('.admin-profile-row')).toHaveCount(profiles.length);
    await page.evaluate(() => document.fonts.ready);
    const measurements = await page.locator('.admin-profile-catalog').evaluate(element => {
      const row = element.querySelector('.admin-profile-row')!.getBoundingClientRect();
      const controls = [...element.querySelectorAll('.admin-profiles-toolbar > label, .admin-profiles-more-filters > summary')].map(control => {
        const box = control.getBoundingClientRect(); return { top: box.top, bottom: box.bottom };
      });
      const rowBands = [...new Set(controls.map(box => Math.round(box.top)))];
      const aligned = rowBands.every(top => {
        const peers = controls.filter(box => Math.abs(box.top - top) < 1);
        return Math.max(...peers.map(box => box.bottom)) - Math.min(...peers.map(box => box.bottom)) <= 1;
      });
      return { firstRow: row.top, aligned, overflow: document.documentElement.scrollWidth - innerWidth };
    });
    expect(measurements.firstRow).toBeLessThan(fontScale > 1 ? 360 : 300);
    expect(measurements.aligned).toBe(true);
    expect(measurements.overflow).toBeLessThanOrEqual(1);
    const sixth = await page.locator('.admin-profile-row').nth(5).boundingBox();
    if (width > 1024 && fontScale === 1) expect(sixth!.y + sixth!.height).toBeLessThan(900);
    if (language === 'ru') {
      const resources = page.locator('.admin-profile-row').first().locator('.admin-profile-resources');
      await expect(resources.nth(0)).toContainText('CPU: 6');
      await expect(resources.nth(0)).toContainText('6 ГБ');
      await expect(resources.nth(1)).toContainText('CPU: 4');
      await expect(resources.nth(1)).toContainText('4 ГБ');
    }
    await page.screenshot({ path: testInfo.outputPath('profiles-' + name + '.png'), fullPage: false });
    await page.locator('.admin-profiles-more-filters > summary').click();
    const panel = page.locator('.admin-profiles-filter-panel');
    await expect(panel).toBeVisible();
    const sizes = await panel.locator('select').evaluateAll(selects => selects.map(select => {
      const box = select.getBoundingClientRect(); return { top: box.top, bottom: box.bottom };
    }));
    expect(Math.max(...sizes.map(box => box.top)) - Math.min(...sizes.map(box => box.top))).toBeLessThanOrEqual(1);
    expect(Math.max(...sizes.map(box => box.bottom)) - Math.min(...sizes.map(box => box.bottom))).toBeLessThanOrEqual(1);
    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();
    await expect(page.locator('.admin-profiles-more-filters > summary')).toBeFocused();
  });
}

test('profile tools return focus after import and dismiss with Escape or an outside click', async ({ page }) => {
  await page.goto('/#/admin/profiles');
  const tools = page.locator('.admin-profile-tools > summary');
  await tools.click();
  await page.getByRole('button', { name: 'Импорт JSON', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Импорт профилей из JSON', exact: true });
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(tools).toBeFocused();
  await tools.click();
  await page.keyboard.press('Escape');
  await expect(page.locator('.admin-profile-tools')).not.toHaveAttribute('open');
  await expect(tools).toBeFocused();
  await tools.click();
  await page.getByRole('searchbox', { name: 'Найти профиль', exact: true }).click();
  await expect(page.locator('.admin-profile-tools')).not.toHaveAttribute('open');
});
