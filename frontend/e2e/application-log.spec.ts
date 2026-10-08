import { expect, test, type Page } from '@playwright/test';
const epoch = '44444444-4444-4444-8444-444444444444';
async function fixture(page: Page, theme = 'light', scale = 1) {
  await page.route('**/api/me/preferences', route => route.fulfill({ json: { preferences: { theme, fontScale: scale, fontFamily: 'system', defaultAdbKeyId: null } } }));
  await page.addInitScript(() => {
    class Source {
      static CLOSED = 2;
      readyState = 1;
      onerror: (() => void) | null = null;
      listeners = new Map<string, ((event: { data: string }) => void)[]>();
      constructor() { Object.assign(window, { applicationLogSource: this }); }
      addEventListener(type: string, listener: (event: { data: string }) => void) { this.listeners.set(type, [...(this.listeners.get(type) || []), listener]); }
      emit(type: string, value: object) { for (const listener of this.listeners.get(type) || []) listener({ data: JSON.stringify(value) }); }
      close() { this.readyState = 2; }
    }
    Object.defineProperty(window, 'EventSource', { value: Source });
  });
  await page.goto('/#/admin/journal?tab=application');
  await expect(page.getByRole('tab', { name: 'Лог приложения', exact: true })).toHaveAttribute('aria-selected', 'true');
  await emit(page, 'ready', { reset: false, gap: false });
  await emit(page, 'entry', { id: epoch + ':1', occurredAt: '2026-10-07T10:20:30.000Z', level: 'info', message: 'Remote Device Farm API listening on 8080' });
  await emit(page, 'entry', { id: epoch + ':2', occurredAt: '2026-10-07T10:20:31.000Z', level: 'warning', message: 'Node policy refresh failed: node is temporarily unavailable' });
  await emit(page, 'entry', { id: epoch + ':3', occurredAt: '2026-10-07T10:20:32.000Z', level: 'error', message: 'Image reconciliation failed\nError: registry temporarily unavailable\n    at reconcileImages (image-worker.js:42:17)' });
  await expect(page.locator('.application-log-viewport pre')).toContainText('reconcileImages');
}
async function emit(page: Page, type: string, value: object) {
  await page.evaluate(({ type, value }) => (window as unknown as { applicationLogSource: { emit(type: string, value: object): void } }).applicationLogSource.emit(type, value), { type, value });
}
test('runtime log is plain text, updates, pauses, filters, exports and reconnects', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await fixture(page);
  const log = page.locator('.application-log-viewport');
  await expect(log.locator('table, button')).toHaveCount(0);
  await page.getByRole('button', { name: 'Пауза', exact: true }).click();
  await emit(page, 'entry', { id: epoch + ':4', occurredAt: '2026-10-07T10:20:33.000Z', level: 'info', message: 'Arrived while paused' });
  await expect(page.locator('.application-log-footer')).toContainText('новых: 1');
  await expect(log).not.toContainText('Arrived while paused');
  await page.getByRole('button', { name: 'Продолжить', exact: true }).click();
  await expect(log).toContainText('Arrived while paused');
  await page.getByLabel('Уровень', { exact: true }).selectOption('error');
  await expect(log).toContainText('Image reconciliation failed'); await expect(log).not.toContainText('API listening');
  await page.getByRole('button', { name: 'Копировать', exact: true }).click();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toContain('ERROR [server] Image reconciliation failed');
  expect(copied).not.toContain('API listening');
  const downloadEvent = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Скачать', exact: true }).click();
  const download = await downloadEvent; expect(download.suggestedFilename()).toMatch(/\.log$/);
  await page.getByLabel('Поиск в логе').fill('absent'); await expect(log).toContainText('Нет строк');
  await page.getByLabel('Поиск в логе').clear(); await page.getByLabel('Уровень', { exact: true }).selectOption('');
  await emit(page, 'ready', { reset: true, gap: false });
  await emit(page, 'entry', { id: '55555555-5555-4555-8555-555555555555:1', occurredAt: '2026-10-07T10:30:00.000Z', level: 'info', message: 'Server restarted' });
  await expect(log).toContainText('Server restarted'); await expect(log).not.toContainText('API listening');
  await expect(page.locator('.application-log-notice')).toContainText('Сервер перезапущен');
  await emit(page, 'unauthorized', {}); await expect(page.getByRole('alert')).toContainText('Доступ к логу закрыт');
  await page.getByRole('tab', { name: 'Действия', exact: true }).click();
  await expect(page.locator('.admin-journal-table')).toBeVisible();
});
for (const [width, theme, scale] of [[1366, 'light', 1], [1366, 'dark', 1], [390, 'light', 1], [390, 'dark', 1], [1366, 'light', 1.5]] as const) test(`log stream alignment at ${width} ${theme} ${scale}`, async ({ page }) => {
  await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
  await fixture(page, theme, scale); await page.evaluate(() => document.fonts.ready);
  const geometry = await page.locator('.application-log-toolbar').evaluate(element => {
    const controls = [...element.querySelectorAll('input, select, button')].map(control => control.getBoundingClientRect());
    return { fields: Math.abs(controls[0].top - controls[1].top), heights: controls.map(box => box.height), buttons: controls.slice(2).map(box => box.top), bounds: controls.map(box => [box.left, box.right]), overflow: document.documentElement.scrollWidth - innerWidth };
  });
  expect(geometry.overflow).toBeLessThanOrEqual(1);
  expect(Math.max(...geometry.heights) - Math.min(...geometry.heights)).toBeLessThanOrEqual(1);
  expect(Math.max(...geometry.buttons) - Math.min(...geometry.buttons)).toBeLessThanOrEqual(1);
  if (width > 600) expect(geometry.fields).toBeLessThanOrEqual(1);
  for (const [left, right] of geometry.bounds) { expect(left).toBeGreaterThanOrEqual(0); expect(right).toBeLessThanOrEqual(width); }
  await page.screenshot({ path: `../.tmp-ui/application-log/${width}-${theme}-${scale}.png`, animations: 'disabled', fullPage: true });
});

test('agent and emulator lines show their actual source in the stream and copied text', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await fixture(page);
  await emit(page, 'entry', { id: epoch + ':4', occurredAt: '2026-10-07T10:20:33.000Z', source: 'agent', level: 'info', message: 'session.boot_probe host=node-one session=1234: Android is booting' });
  await emit(page, 'entry', { id: epoch + ':5', occurredAt: '2026-10-07T10:20:34.000Z', source: 'emulator', level: 'error', message: 'container.state host=node-one session=1234: exitCode=64' });
  const log = page.locator('.application-log-viewport');
  await expect(log).toContainText('[agent] session.boot_probe');
  await expect(log).toContainText('[emulator] container.state');
  await page.getByLabel('Поиск в логе').fill('[agent]');
  await expect(log).toContainText('Android is booting');
  await expect(log).not.toContainText('exitCode=64');
  await page.getByRole('button', { name: 'Копировать', exact: true }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('INFO [agent] session.boot_probe');
});
