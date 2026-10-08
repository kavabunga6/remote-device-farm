import { expect, test, type Page } from '@playwright/test';

async function fixture(page: Page, theme: 'light' | 'dark') {
  await page.route('**/api/me/notifications', route => route.fulfill({ json: { notifications: [] } }));
  await page.route('**/api/me/preferences', route => route.fulfill({ json: { preferences: { theme, fontFamily: 'system', fontScale: 1, defaultAdbKeyId: null } } }));
  await page.route('**/api/hosts', async route => {
    const source = (await (await route.fetch()).json()).hosts[0];
    const fresh = new Date().toISOString(), stale = new Date(Date.now() - 300_000).toISOString();
    const metrics = { ...source.metrics, cpuModel: 'Example CPU', cpuCores: 32, cpuUsagePercent: 37.6,
      gpuPresent: true, gpuModel: 'NVIDIA Example GPU', gpuCapabilities: ['cuda'],
      metricsSampledAt: fresh, gpuTelemetry: [{ index: 0, utilizationPercent: 0 }] };
    const hosts = [
      { id: 'live', metrics },
      { id: 'multi', metrics: { ...metrics, cpuUsagePercent: 0, gpuTelemetry: [{ index: 0, utilizationPercent: 0 }, { index: 1, utilizationPercent: 67 }] } },
      { id: 'stale', metrics: { ...metrics, metricsSampledAt: stale } },
      { id: 'unknown', metrics: { ...metrics, cpuUsagePercent: undefined, gpuTelemetry: undefined } },
      { id: 'offline', status: 'offline', metrics },
      { id: 'disabled', disabled: true, metrics },
    ].map(item => ({ ...source, status: 'online', disabled: false, lastSeenAt: fresh, devices: [], ...item, name: item.id, agentName: item.id, displayName: null }));
    await route.fulfill({ json: { hosts } });
  });
  await page.goto('/#/admin/nodes');
  await page.evaluate(() => document.fonts.ready);
}

for (const theme of ['light', 'dark'] as const) for (const width of [1366, 390]) test(`live node meters use reported samples: ${theme} ${width}`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  await fixture(page, theme);
  const card = (id: string) => page.locator('.node-overview').filter({ has: page.getByRole('link', { name: 'Настройки узла: ' + id, exact: true }) });
  await expect(card('live').getByRole('meter', { name: 'Загрузка CPU', exact: true })).toHaveAttribute('aria-valuenow', '38');
  await expect(card('live').getByRole('meter', { name: 'Загрузка GPU', exact: true })).toHaveAttribute('aria-valuenow', '0');
  await expect(card('live').locator('[data-resource=cpu] b')).toHaveText('38%');
  await expect(card('live').locator('[data-resource=gpu] b')).toHaveText('0%');
  await expect(card('multi').getByRole('meter', { name: 'Загрузка CPU', exact: true })).toHaveAttribute('aria-valuenow', '0');
  for (const [index, value] of [[0, '0'], [1, '67']] as const) await expect(card('multi').getByRole('meter', { name: 'Загрузка GPU #' + index, exact: true })).toHaveAttribute('aria-valuenow', value);
  for (const id of ['stale', 'unknown', 'offline', 'disabled']) await expect(card(id).locator('[data-resource=cpu], [data-resource=gpu]').getByRole('meter')).toHaveCount(0);
  const load = card('live').getByRole('meter', { name: 'Загрузка CPU', exact: true });
  const geometry = await load.evaluate(element => ({ width: element.clientWidth, fill: element.firstElementChild!.getBoundingClientRect().width,
    background: getComputedStyle(element).backgroundColor, fillColor: getComputedStyle(element.firstElementChild!).backgroundColor }));
  expect(geometry.width).toBeGreaterThan(20); expect(geometry.fill / geometry.width).toBeCloseTo(.38, 2);
  expect(geometry.fillColor).not.toBe(geometry.background); expect(geometry.background).not.toBe('rgba(0, 0, 0, 0)');
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
  await card('live').screenshot({ path: `../.tmp-ui/host-live-${theme}-${width}.png` });
});
