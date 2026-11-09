import { expect, test } from '@playwright/test';
import type { OpsSummary } from '../src/ops-api';

const now = Date.parse('2026-10-04T18:00:00Z');
const series = (bucketMinutes: number, values: number[]) => [4, 40, 4, 4].map((total, index) => ({
  hostId: 'host-' + index,
  hostName: index < 2 ? 'worker-' + (index + 1) : 'Archive installation check',
  points: values.map((used, pointIndex) => ({
    at: new Date(now - (values.length - pointIndex) * bucketMinutes * 60_000).toISOString(),
    used: index < 2 ? used : 0,
    total,
  })),
}));
const summary: OpsSummary = {
  generatedAt: new Date(now).toISOString(),
  utilization24h: { bucketMinutes: 15, series: series(15, [0, 1.25, 3, 2]) },
  utilization14d: { bucketMinutes: 120, series: series(120, [0.875, 1.25, 3.5, 2]) },
  sessionsPerDay: Array.from({ length: 14 }, (_, i) => ({
    day: new Date(Date.UTC(2026, 9, 4 - (13 - i))).toISOString().slice(0, 10),
    count: i === 13 ? 7 : i === 12 ? 16 : i === 8 ? 2 : 0,
  })),
  duration: { count: 12, avgSeconds: 2500, p90Seconds: 3900 },
  startsByHourUtc: Array(24).fill(0),
  peakHourUtc: null,
  topUsers: [{ username: 'qa-automation', sessions: 10, minutes: 145 }],
  failures: { last24h: 0, last14d: 1 },
  sampleCount: 16,
};

test('charts expose counts directly and hide nodes that never used a slot', async ({ page }, testInfo) => {
  await page.route('**/api/admin/ops/summary', route => route.fulfill({ json: summary }));
  await page.emulateMedia({ colorScheme: 'light' });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/#/admin/ops');

  const panel = page.getByRole('region', { name: 'Занятые слоты' });
  const chart = panel.getByRole('img', { name: 'Количество занятых слотов по узлам' });
  const readings = panel.getByRole('status');
  const daily = page.getByRole('region', { name: 'Сессии по дням' });
  const dailyChart = daily.getByRole('img', { name: 'Сессий в день за 14 дней' });

  await expect(chart).toBeVisible();
  await expect(panel.getByText('Среднее число занятых слотов за 15 минут', { exact: true })).toBeVisible();
  await expect(readings).toContainText('2 из 4');
  await expect(readings).toContainText('2 из 40');
  await expect(readings).not.toContainText('Archive installation check');
  await expect(page.locator('.admin-ops').getByRole('table')).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Самые активные пользователи' }).getByText('qa-automation')).toBeVisible();

  const lines = chart.locator('polyline');
  await expect(lines).toHaveCount(2);
  // Equal occupied counts share coordinates even when capacities differ.
  expect(await lines.nth(0).getAttribute('points')).toBe(await lines.nth(1).getAttribute('points'));
  const ticks = await chart.locator('g > text.ops-tick').allTextContents();
  expect(ticks[0]).toBe('0');
  expect(ticks.every(tick => /^\d+$/.test(tick))).toBe(true);
  expect(Number(ticks.at(-1))).toBeGreaterThanOrEqual(3);

  const point = (await lines.first().getAttribute('points'))!.split(' ')[1]!.split(',').map(Number);
  await chart.hover({ position: { x: point[0]!, y: point[1]! } });
  await expect(readings).toContainText('1,25 из 4');
  await expect(readings).toContainText('1,25 из 40');
  await chart.focus();
  await chart.press('Home');
  await expect(readings).toContainText('Нет замера');
  await chart.press('End');
  await expect(readings).toContainText('Нет замера');
  await chart.press('ArrowLeft');
  await expect(readings).toContainText('2 из 4');

  await panel.getByRole('button', { name: '14 дней', exact: true }).click();
  await expect(panel.getByText('Среднее число занятых слотов за 2 часа', { exact: true })).toBeVisible();
  await expect(readings).toContainText('2 из 4');

  await expect(daily).toContainText('UTC');
  await expect(daily.getByRole('status')).toContainText('Сессии · 7');
  await dailyChart.press('ArrowLeft');
  await expect(daily.getByRole('status')).toContainText('Сессии · 16');
  await dailyChart.press('ArrowLeft');
  await expect(daily.getByRole('status')).toContainText('Сессии · 0');

  await page.evaluate(() => document.fonts.ready);
  const [slotBox, dayBox] = await Promise.all([chart.boundingBox(), dailyChart.boundingBox()]);
  expect(Math.abs(slotBox!.y - dayBox!.y)).toBeLessThanOrEqual(1);
  await expect(panel).toBeVisible();
  await page.locator('.ops-panels').screenshot({ path: testInfo.outputPath('ops-light.png') });
});

test('the narrow dark RTL view distinguishes idle slots from missing readings', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await page.addInitScript(() => localStorage.setItem('rdf.language', 'ar'));
  await page.route('**/api/me/preferences*', route => route.fulfill({ json: {
    preferences: { theme: 'dark', fontFamily: 'system', fontScale: 1.25, defaultAdbKeyId: null },
  } }));
  await page.route('**/api/admin/ops/summary', route => route.fulfill({ json: {
    ...summary, utilization14d: { bucketMinutes: 120, series: series(120, [0, 0, 0, 0]) },
  } }));
  await page.goto('/#/admin/ops');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.locator('html')).toHaveAttribute('data-effective-theme', 'dark');
  await page.evaluate(() => document.fonts.ready);
  const panels = page.locator('.ops-panels');
  await expect(panels.getByRole('img')).toHaveCount(2);
  const switcher = panels.locator('.ops-switch');
  const controls = await switcher.getByRole('button').evaluateAll(buttons => buttons.map(button => {
    const { top, bottom } = button.getBoundingClientRect();
    return { top, bottom };
  }));
  expect(Math.abs(controls[0]!.top - controls[1]!.top)).toBeLessThanOrEqual(1);
  expect(Math.abs(controls[0]!.bottom - controls[1]!.bottom)).toBeLessThanOrEqual(1);
  expect(await panels.evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
  await panels.screenshot({ path: testInfo.outputPath('ops-dark-rtl.png') });
  await switcher.getByRole('button').last().click();
  await expect(panels.getByText('أظهرت القياسات المتاحة أن جميع الفتحات كانت خالية.', { exact: true })).toBeVisible();
  await expect(panels.getByRole('img')).toHaveCount(1);
});
