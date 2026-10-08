import { expect, test } from '@playwright/test';
import type { OpsSummary } from '../src/ops-api';

test('slot history displays counts regardless of host capacity and explains the averaging period', async ({ page }) => {
  const now = Date.parse('2026-10-04T18:00:00Z');
  const series = (bucketMinutes: number, values: number[]) => [4, 40].map((total, index) => ({
    hostId: `host-${index}`,
    hostName: `worker-${index + 1}`,
    points: values.map((used, pointIndex) => ({
      at: new Date(now - (values.length - pointIndex) * bucketMinutes * 60_000).toISOString(),
      used,
      total,
    })),
  }));
  const summary: OpsSummary = {
    generatedAt: new Date(now).toISOString(),
    utilization24h: { bucketMinutes: 15, series: series(15, [0, 1.25, 3, 2]) },
    utilization14d: { bucketMinutes: 120, series: series(120, [0.875, 1.25, 3.5, 2]) },
    sessionsPerDay: [],
    duration: { count: 0, avgSeconds: null, p90Seconds: null },
    startsByHourUtc: Array(24).fill(0),
    peakHourUtc: null,
    topUsers: [],
    failures: { last24h: 0, last14d: 0 },
    sampleCount: 16,
  };
  await page.route('**/api/admin/ops/summary', route => route.fulfill({ json: summary }));
  await page.emulateMedia({ colorScheme: 'light' });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/#/admin/ops');

  const panel = page.locator('.ops-panel').filter({ has: page.getByRole('heading', { name: 'Занятые слоты', exact: true }) });
  const chart = panel.getByRole('img', { name: 'Количество занятых слотов по узлам' });
  await expect(chart).toBeVisible();
  await expect(panel.getByText('Среднее за 15 минут', { exact: true })).toBeVisible();
  const lines = chart.locator('polyline');
  await expect(lines).toHaveCount(2);
  // Equal occupied counts must share coordinates even when capacity differs tenfold.
  expect(await lines.nth(0).getAttribute('points')).toBe(await lines.nth(1).getAttribute('points'));
  const ticks = await chart.locator('g > text.ops-tick').allTextContents();
  expect(ticks.length).toBeGreaterThan(1);
  expect(ticks[0]).toBe('0');
  expect(ticks.every(tick => /^\d+$/.test(tick))).toBe(true);
  expect(Number(ticks.at(-1))).toBeGreaterThanOrEqual(3);

  const point = (await lines.first().getAttribute('points'))!.split(' ')[1]!.split(',').map(Number);
  await chart.hover({ position: { x: point[0]!, y: point[1]! } });
  const tooltip = panel.getByRole('status');
  await expect(tooltip).toContainText('1,25 из 4');
  await expect(tooltip).toContainText('1,25 из 40');
  await expect(tooltip).not.toContainText('%');

  await panel.getByText('Данные графика таблицей', { exact: true }).click();
  const table = panel.getByRole('table', { name: /Занятые слоты по узлам/ });
  await expect(table.getByRole('columnheader')).toHaveText(['Время', 'Узел', 'Занято в среднем', 'Всего слотов']);
  const rows = table.locator('tbody tr');
  await expect(rows.nth(2).getByRole('cell').nth(2)).toHaveText('1,25');
  await expect(rows.nth(2).getByRole('cell').nth(3)).toHaveText('4');
  await expect(rows.nth(3).getByRole('cell').nth(2)).toHaveText('1,25');
  await expect(rows.nth(3).getByRole('cell').nth(3)).toHaveText('40');
  await expect(table).not.toContainText('%');

  await panel.getByRole('button', { name: '14 дней', exact: true }).click();
  await expect(panel.getByText('Среднее за 2 часа', { exact: true })).toBeVisible();
  await expect(table).toHaveAccessibleName(/за 14 дней · среднее за 2 часа/);
  await expect(rows.first().getByRole('cell').nth(2)).toHaveText('0,88');
  expect((await chart.locator('g > text.ops-tick').allTextContents()).every(tick => /^\d+$/.test(tick))).toBe(true);
  expect(await panel.evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);

  await panel.getByRole('button', { name: '24 часа', exact: true }).click();
  await expect(panel.getByText('Среднее за 15 минут', { exact: true })).toBeVisible();
  await panel.screenshot({ path: '../.tmp-ui/ops-slot-count.png' });
});
