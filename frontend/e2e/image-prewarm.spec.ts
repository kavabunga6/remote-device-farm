import { expect, test } from '@playwright/test';

for (const theme of ['light', 'dark'] as const) for (const width of [1366, 390]) test(`catalog prewarm reports queue, failures and completed downloads: ${theme} ${width}`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  let requested = false, readsAfterRequest = 0;
  const requests: unknown[] = [];
  const longImage = 'registry.example.test/mobile/validation/emulator@sha256:' + 'a'.repeat(64);
  await page.route('**/api/me/notifications', route => route.fulfill({ json: { notifications: [] } }));
  await page.route('**/api/me/preferences', route => route.fulfill({ json: { preferences: { theme, fontFamily: 'system', fontScale: 1, defaultAdbKeyId: null } } }));
  await page.route('**/api/admin/emulator-images', route => route.fulfill({ json: {
    registry: { mode: 'builtin', builtinAddress: 'registry.example.test', externalAddress: null, externalUsername: null, externalPasswordSet: false },
    builder: { id: 'h1', name: 'worker-01' }, images: [], jobs: [],
  } }));
  await page.route('**/api/admin/emulator-images/prewarm', route => {
    if (route.request().method() === 'POST') {
      requested = true; requests.push(route.request().postDataJSON());
      return route.fulfill({ status: 202, json: { queued: 1, skipped: 2 } });
    }
    const state = ++readsAfterRequest > 1 ? 'done' : 'queued';
    return route.fulfill({ json: { items: requested ? [
      { hostId: 'h1', image: longImage, state, error: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
      { hostId: 'removed-node', image: longImage + '-failed', state: 'failed', error: 'Image download failed', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
    ] : [] } });
  });
  await page.goto('/#/admin/profiles');
  await page.getByRole('button', { name: 'Каталог образов', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Каталог образов Google', exact: true });
  const download = dialog.getByRole('button', { name: 'Скачать на узлы', exact: true });
  await expect(download).toBeEnabled();
  await expect(dialog.locator('#catalog-prewarm-hint')).toContainText('несколько гигабайт');
  await expect(dialog.locator('.emulator-catalog-prewarm')).toHaveCount(0);
  readsAfterRequest = 0;
  await download.click();
  await expect(page.getByRole('status').filter({ hasText: 'Загрузка образов запланирована' })).toContainText('Добавлено в очередь: 1. Пропущено: 2.');
  expect(requests).toEqual([{}]);
  const jobs = dialog.locator('.emulator-catalog-prewarm');
  await expect(jobs).toBeVisible();
  await jobs.locator('summary').click();
  await expect(jobs.locator('li')).toHaveCount(2);
  await expect(jobs.locator('[data-state=queued]')).toHaveText('В очереди');
  await expect(jobs.locator('[data-state=failed]')).toHaveText('Ошибка загрузки');
  await expect(jobs).toContainText('Проверьте связь с узлом');
  await expect(jobs.locator('[data-state=done]')).toHaveText('На узле', { timeout: 7000 });
  await expect(jobs.locator('summary')).toContainText('0 в работе · 2 всего');
  await page.evaluate(() => document.fonts.ready);
  await jobs.scrollIntoViewIfNeeded();
  const overflow = await dialog.evaluate(element => Math.max(...[element, element.querySelector('.emulator-catalog-body')!, element.querySelector('.emulator-catalog-prewarm')!].map(node => node.scrollWidth - node.clientWidth), document.documentElement.scrollWidth - innerWidth));
  expect(overflow).toBeLessThanOrEqual(1);
  await page.screenshot({ path: `../.tmp-ui/catalog-prewarm-${theme}-${width}.png` });
});
