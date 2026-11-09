import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';

const id = 'cbd55091-aaaa-bbbb-cccc-000000000001';
const base = '**/api/sessions/' + id + '/performance';
const sample = {
  sampledAt: '2026-01-01T12:00:00.000Z',
  cpuCores: 1.8, throttlePercent: 0, memoryBytes: 3e9, memoryLimitBytes: 6e9,
  readBytesPerSecond: 2.2e6, writeBytesPerSecond: 0,
};
const processes = [
  { pid: 42, name: 'com.example.navigation.background', cpuPercent: 135, residentBytes: 220e6 },
  { pid: 230, name: 'com.example.photo.editor', cpuPercent: 22, residentBytes: 610e6 },
  { pid: 81, name: 'system_server', cpuPercent: 7, residentBytes: 175e6 },
  { pid: 102, name: 'surfaceflinger', cpuPercent: 3.4, residentBytes: 89e6 },
];

async function openSession(page: Page, theme: 'light' | 'dark', language: 'ru' | 'ar', ended = false) {
  await page.addInitScript(value => localStorage.setItem('rdf.language', value), language);
  await page.route('**/api/me/preferences*', route => route.fulfill({ json: {
    preferences: { theme, fontFamily: 'system', fontScale: 1.25, defaultAdbKeyId: null },
  } }));
  if (ended) await page.route('**/api/sessions/' + id, async route => {
    const response = await route.fetch();
    const body = await response.json();
    body.session.state = 'failed';
    await route.fulfill({ response, json: body });
  });
  await page.goto('/#/session/' + id);
  await expect(page.locator('html')).toHaveAttribute('lang', language);
  await expect(page.locator('html')).toHaveAttribute('data-effective-theme', theme);
  await page.locator('.workspace-mode-buttons button').last().click();
  await expect(page.locator('#tool-tab-performance')).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}

test('live process samples follow visibility and pause for manual traces', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  let samples = 0, snapshots = 0, recordings = 0;
  const pendingSample = Promise.withResolvers<void>();
  const pendingTrace = Promise.withResolvers<void>();
  await page.route(base, route => {
    samples++;
    return route.fulfill({ json: { sample } });
  });
  await page.route(base + '/processes', async route => {
    expect(route.request().method()).toBe('POST');
    snapshots++;
    if (snapshots === 5) await pendingSample.promise;
    await route.fulfill({ json: { sampledAt: new Date(Date.parse(sample.sampledAt) + snapshots * 1000).toISOString(), processes } });
  });
  const bytes = Buffer.from([10, 2, 8, 1]);
  await page.route(base + '/trace', async route => {
    expect(route.request().method()).toBe('POST');
    recordings++;
    await pendingTrace.promise;
    await route.fulfill({ body: bytes, contentType: 'application/octet-stream' });
  });
  await openSession(page, 'light', 'ru');
  await page.clock.install();
  await page.clock.runFor(5200);
  expect(samples).toBe(0);
  expect(snapshots).toBe(0);
  await page.locator('#tool-tab-performance').click();
  const panel = page.getByRole('tabpanel');
  const monitor = panel.getByRole('region', { name: 'Процессы Android' }).first();
  await expect(panel).toContainText('1,8');
  await expect(monitor.getByRole('rowheader').first()).toContainText(processes[0].name);
  expect(samples).toBe(1);
  expect(snapshots).toBe(1);
  expect(recordings).toBe(0);
  await expect(monitor.getByRole('row').nth(1)).toContainText(/135\s*%/);
  await expect(monitor.getByRole('row').nth(1).locator('.process-usage-track > span').first()).toHaveCSS('inline-size',
    await monitor.getByRole('row').nth(1).locator('.process-usage-track').first().evaluate(el => getComputedStyle(el).inlineSize));
  await monitor.getByRole('button', { name: 'Память RSS' }).click();
  await expect(monitor.getByRole('rowheader').first()).toContainText(processes[1].name);
  await expect(monitor.getByRole('columnheader', { name: 'Память RSS' })).toHaveAttribute('aria-sort', 'descending');
  await page.clock.runFor(6200);
  await expect.poll(() => snapshots).toBe(2);
  await expect(monitor.locator('time')).toHaveAttribute('datetime', '2026-01-01T12:00:02.000Z');
  await monitor.getByRole('button', { name: 'Пауза' }).click();
  await expect(monitor.getByRole('status')).toHaveText('На паузе');
  await page.clock.runFor(10_500);
  expect(snapshots).toBe(2);
  await monitor.getByRole('button', { name: 'Продолжить' }).click();
  await expect.poll(() => snapshots).toBe(3);
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  const samplesWhenHidden = samples;
  await page.clock.runFor(10_500);
  expect(samples).toBe(samplesWhenHidden);
  expect(snapshots).toBe(3);
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(monitor.locator('time')).toHaveAttribute('datetime', '2026-01-01T12:00:04.000Z');
  await page.clock.runFor(6200);
  await expect.poll(() => snapshots).toBe(5);
  await page.getByRole('button', { name: 'Записать 10 с' }).click();
  expect(recordings).toBe(0);
  pendingSample.resolve();
  await expect.poll(() => recordings).toBe(1);
  await page.clock.runFor(10_500);
  expect(snapshots).toBe(5);
  pendingTrace.resolve();
  const downloadButton = panel.getByRole('button', { name: /Скачать/ });
  await expect(downloadButton).toBeVisible();
  const [download] = await Promise.all([page.waitForEvent('download'), downloadButton.click()]);
  expect(await readFile((await download.path())!)).toEqual(bytes);
  expect(download.suggestedFilename()).toBe('android.perfetto-trace');
  expect(recordings).toBe(1);
  await expect(monitor.locator('time')).toHaveAttribute('datetime', '2026-01-01T12:00:06.000Z');
  expect(await panel.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  await monitor.screenshot({ path: testInfo.outputPath('performance-light.png') });
  await page.locator('.workspace-mode-buttons button').nth(1).click();
  const paused = samples;
  await page.clock.runFor(10_500);
  expect(samples).toBe(paused);
  expect(snapshots).toBe(6);
});

test('changing the process interval applies the new cadence without overlapping a sample and persists on reload', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.route(base, route => route.fulfill({ json: { sample } }));
  let reads = 0;
  const pending = Promise.withResolvers<void>();
  await page.route(base + '/processes', async route => {
    const read = ++reads;
    if (read === 2) await pending.promise;
    await route.fulfill({ json: { sampledAt: new Date(Date.parse(sample.sampledAt) + read * 1000).toISOString(), processes } });
  });
  await openSession(page, 'light', 'ru');
  await page.clock.install();
  await page.locator('#tool-tab-performance').click();
  const monitor = page.locator('.process-monitor');
  const interval = monitor.getByRole('combobox', { name: 'Интервал обновления' });
  await expect(interval).toHaveValue('6');
  expect(await interval.locator('option').evaluateAll(options => options.map(option => (option as HTMLOptionElement).value)))
    .toEqual(['2', '4', '6', '8', '10', '15', '30']);
  await expect(monitor.locator('time')).toHaveAttribute('datetime', '2026-01-01T12:00:01.000Z');
  await interval.selectOption('2');
  await expect.poll(() => reads).toBe(2);
  await page.clock.runFor(2400);
  expect(reads).toBe(2);
  await interval.selectOption('30');
  pending.resolve();
  await expect(monitor.locator('time')).toHaveAttribute('datetime', '2026-01-01T12:00:02.000Z');
  await page.clock.runFor(25_000);
  expect(reads).toBe(2);
  await page.clock.runFor(3200);
  await expect(monitor.locator('time')).toHaveAttribute('datetime', '2026-01-01T12:00:03.000Z');
  await interval.selectOption('2');
  await expect(monitor.locator('time')).toHaveAttribute('datetime', '2026-01-01T12:00:04.000Z');
  await page.clock.runFor(2200);
  await expect(monitor.locator('time')).toHaveAttribute('datetime', '2026-01-01T12:00:05.000Z');
  await page.reload();
  await page.locator('#tool-tab-performance').click();
  await expect(interval).toHaveValue('2');
});

test('live Android processes remain readable in a narrow RTL workspace and recover after a failed sample', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 430, height: 900 });
  await page.route(base, route => route.fulfill({ json: { sample } }));
  let attempts = 0;
  await page.route(base + '/processes', route => {
    attempts++;
    return attempts === 2 ? route.fulfill({ status: 503, json: { error: 'Unavailable' } })
      : route.fulfill({ json: { sampledAt: sample.sampledAt, processes } });
  });
  await openSession(page, 'dark', 'ar');
  await page.clock.install();
  await page.locator('#tool-tab-performance').click();
  const monitor = page.locator('.process-monitor');
  await expect(monitor).toContainText(processes[0].name);
  await page.clock.runFor(6200);
  await expect(monitor.getByRole('status')).toHaveText('تجري إعادة المحاولة');
  await expect(monitor).toContainText(processes[0].name);
  await page.clock.runFor(5200);
  expect(attempts).toBe(2);
  await page.clock.runFor(7300);
  await expect(monitor.getByRole('status')).toHaveText('تحديث مباشر');
  expect(attempts).toBe(3);
  expect(await monitor.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  const sortButtons = await monitor.locator('thead button').evaluateAll(buttons => buttons.map(button => {
    const { top, bottom } = button.getBoundingClientRect();
    return { top, bottom };
  }));
  expect(Math.abs(sortButtons[0].top - sortButtons[1].top)).toBeLessThanOrEqual(1);
  expect(Math.abs(sortButtons[0].bottom - sortButtons[1].bottom)).toBeLessThanOrEqual(1);
  const controls = await monitor.locator('.process-actions :is(select, button)').evaluateAll(items => items.map(item => {
    const { top, bottom } = item.getBoundingClientRect();
    return { top, bottom };
  }));
  expect(Math.abs(controls[0].top - controls[1].top)).toBeLessThanOrEqual(1);
  expect(Math.abs(controls[0].bottom - controls[1].bottom)).toBeLessThanOrEqual(1);
  await monitor.screenshot({ path: testInfo.outputPath('performance-live-dark-rtl.png') });
});

test('a retained crash snapshot fits a narrow RTL workspace without polling the stopped device', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 900, height: 850 });
  let samples = 0;
  await page.route(base, route => { samples++; return route.fulfill({ json: { sample } }); });
  await page.route(base + '/crash', route => route.fulfill({ json: { crash: {
    reason: 'oom', occurredAt: sample.sampledAt, exitCode: 137, oomKilled: true, lastSample: sample,
    logs: ['synthetic emulator shutdown'],
  } } }));
  await openSession(page, 'dark', 'ar', true);
  await page.locator('#tool-tab-performance').click();
  const panel = page.getByRole('tabpanel');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(panel).toContainText('توقّف المحاكي بسبب نفاد الذاكرة.');
  await panel.locator('summary').click();
  await expect(panel.getByText('synthetic emulator shutdown')).toBeVisible();
  expect(await panel.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  expect(samples).toBe(0);
  await page.screenshot({ path: testInfo.outputPath('performance-dark-rtl.png') });
});

test('rental history opens a crash snapshot after the device has been released', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => localStorage.setItem('rdf.language', 'ru'));
  await page.route('**/api/me/rentals*', route => route.fulfill({ json: {
    nextCursor: null, rentals: [{ id: '1', sessionId: id, hostName: 'Node', profileName: 'Android 16',
      createdAt: sample.sampledAt, startedAt: sample.sampledAt, endedAt: sample.sampledAt, finalState: 'stopping', hasCrash: true }],
  } }));
  let reads = 0;
  await page.route(base + '/crash', route => {
    reads++;
    return route.fulfill({ json: { crash: { reason: 'exit', occurredAt: sample.sampledAt, exitCode: 139,
      oomKilled: false, lastSample: null, logs: [] } } });
  });
  await page.goto('/#/account/history');
  const open = page.getByRole('button', { name: 'Снимок при сбое' });
  await expect(open).toBeVisible();
  expect(reads).toBe(0);
  await open.click();
  const dialog = page.getByRole('dialog', { name: 'Снимок при сбое' });
  await expect(dialog).toContainText('139');
  expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  expect(reads).toBe(1);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(open).toBeFocused();
});
