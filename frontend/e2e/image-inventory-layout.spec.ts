import { expect, test } from '@playwright/test';

const items = Array.from({ length: 8 }, (_, index) => ({
  digest: 'sha256:' + String(index).repeat(64),
  package: 'system-images;android-' + (37 - index % 4) + ';google_apis;x86_64',
  tags: ['release-' + index], sizeBytes: 2 * 1024 ** 3, createdAt: '2026-10-08T10:00:00Z',
  firstSeenAt: '2026-10-08T10:00:00Z', lastUsedAt: '2026-10-08T11:00:00Z',
  uses: index < 2 ? [
    { kind: 'catalog', id: 'catalog-' + index, name: 'Android image', image: 'image' },
    { kind: 'profile', id: 'phone-' + index, name: 'Android phone · Google APIs', image: 'image' },
    { kind: 'profile', id: 'tablet-' + index, name: 'Android tablet · Extended integration environment', image: 'image' },
  ] : [],
  blockers: index === 1 ? ['session'] : [],
}));

for (const [variant, theme, width, scale, language] of [
  ['dark', 'dark', 1366, 1, 'ru'], ['light', 'light', 1366, 1, 'ru'],
  ['narrow-desktop', 'dark', 1024, 1, 'en'], ['large-german', 'light', 1366, 1.25, 'de'],
  ['arabic', 'dark', 1366, 1, 'ar'], ['narrow', 'light', 390, 1, 'ru'],
] as const) {
  test('image inventory is compact and aligned in ' + variant, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(value => localStorage.setItem('rdf.language', value), language);
    await page.route('**/api/sessions', route => route.fulfill({ json: { sessions: [] } }));
    await page.route('**/api/me/preferences', route => route.fulfill({ json: {
      preferences: { theme, fontFamily: 'system', fontScale: scale, defaultAdbKeyId: null },
    } }));
    await page.route('**/api/admin/image-management/**', route => {
      const path = new URL(route.request().url()).pathname;
      return route.fulfill({ json: path.endsWith('/registry') ? {
        supported: true, repository: 'registry.example.com/android/emulator-images', items, maintenance: false,
      } : path.endsWith('/policy') ? { policy: {
        registryEnabled: false, registryKeep: 3, registryDays: 30, cacheEnabled: false,
        cacheDays: 30, cacheMaxGb: 0, intervalHours: 24,
      } } : { items: path.endsWith('/jobs') ? [] : items } });
    });
    await page.goto('/#/admin/images');
    const rows = page.locator('.image-inventory-table tbody tr');
    await expect(rows).toHaveCount(8);
    await page.evaluate(() => document.fonts.ready);
    const geometry = await page.locator('.image-management').evaluate(element => {
      const row = element.querySelector('.image-inventory-table tbody tr')!.getBoundingClientRect();
      const controls = [...element.querySelectorAll('.image-controls input, .image-controls select')].map(input => {
        const r = input.getBoundingClientRect(); return { top: r.top, bottom: r.bottom };
      });
      const bands = [...new Set(controls.map(r => Math.round(r.top)))];
      const aligned = bands.every(top => {
        const peers = controls.filter(r => Math.abs(r.top - top) < 1);
        return Math.max(...peers.map(r => r.bottom)) - Math.min(...peers.map(r => r.bottom)) <= 1;
      });
      return { top: row.top, aligned, overflow: document.documentElement.scrollWidth - innerWidth };
    });
    expect(geometry.aligned).toBe(true);
    expect(geometry.overflow).toBeLessThanOrEqual(1);
    expect(geometry.top).toBeLessThan(width < 700 ? 570 : scale > 1 ? 380 : 330);
    if (width >= 1024 && scale === 1) {
      const sixth = await rows.nth(5).boundingBox();
      expect(sixth!.y + sixth!.height).toBeLessThan(900);
    }
    await expect(page.locator('.image-selection')).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath('images-' + variant + '.png'), fullPage: false });
    await rows.first().locator('.image-profile-disclosure > summary').click();
    await expect(rows.first().getByRole('link')).toHaveCount(2);
    await expect(rows.first().getByRole('link').last()).toHaveAttribute('href', /profile=tablet-0$/);
    await rows.first().locator('.image-profile-disclosure > summary').click();
    await page.locator('.image-select-all input').check();
    await expect(page.locator('.image-selection')).toBeVisible();
    await expect(rows.nth(1).getByRole('checkbox')).not.toBeChecked();
    await expect(rows.nth(1).getByRole('checkbox')).toBeDisabled();
    await expect(page.locator('.image-selection')).toContainText('7');
    await page.locator('.image-cleanup-menu > summary').click();
    await expect(page.locator('.image-cleanup-options')).toBeVisible();
    const menu = await page.locator('.image-cleanup-options').boundingBox();
    expect(menu!.x).toBeGreaterThanOrEqual(0);
    expect(menu!.x + menu!.width).toBeLessThanOrEqual(width + 1);
    await page.keyboard.press('Escape');
    await expect(page.locator('.image-cleanup-options')).toBeHidden();
    await expect(page.locator('.image-cleanup-menu > summary')).toBeFocused();
    await page.locator('.image-repository > summary').click();
    await expect(page.locator('.image-repository-panel')).toBeVisible();
    await page.getByRole('searchbox').click();
    await expect(page.locator('.image-repository-panel')).toBeHidden();
  });
}
