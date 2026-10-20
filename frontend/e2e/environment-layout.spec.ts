import { expect, test, type Page } from '@playwright/test';
const sessionId = 'cbd55091-aaaa-bbbb-cccc-000000000001';
const envPath = `**/api/sessions/${sessionId}/env`;
const card = (page: Page, title: string) => page.locator('details.env-card').filter({ has: page.locator('summary strong').filter({ hasText: new RegExp('^' + title + '$') }) });
async function openEnvironment(page: Page) {
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.route('**/api/me/notifications', route => route.fulfill({ json: { notifications: [] } }));
  await page.goto('/#/session/' + sessionId);
  await page.getByRole('group', { name: 'Компоновка сессии' }).getByRole('button', { name: 'Инструменты', exact: true }).click();
  await page.getByRole('tab', { name: 'Среда', exact: true }).click();
}

test('environment sections collapse without losing input and presets require an explicit apply', async ({ page }) => {
  const changes: unknown[] = [];
  await page.route(envPath, async route => {
    if (route.request().method() === 'GET') return route.continue();
    changes.push(route.request().postDataJSON());
    await route.fulfill({ json: { result: { applied: true } } });
  });
  await openEnvironment(page);
  await expect(page.locator('.env-card summary strong')).toHaveText(['Виртуальная камера', 'Приложение', 'Ссылка', 'Экран', 'Сеть', 'Геолокация', 'Устройство']);
  const app = card(page, 'Приложение');
  await app.getByLabel('Пакет', { exact: true }).fill('com.example.app');
  await app.locator('summary').focus(); await page.keyboard.press('Enter');
  await expect(app).not.toHaveAttribute('open', '');
  await app.locator('summary').press('Enter');
  await expect(app.getByLabel('Пакет', { exact: true })).toHaveValue('com.example.app');
  await app.locator('summary').click();

  const network = card(page, 'Сеть');
  await network.locator('summary').click();
  await network.getByRole('combobox', { name: 'Профиль сети' }).selectOption('3g');
  expect(changes).toEqual([]);
  await network.getByRole('button', { name: 'Применить', exact: true }).click();
  await expect(page.locator('.notification-success .notification-title')).toHaveText('Сеть: 3G');
  expect(changes).toEqual([{ op: 'network', params: { profile: '3g' } }]);
  await network.locator('summary').click();
  await expect(network.locator('summary')).toContainText('3G');

  const geo = card(page, 'Геолокация');
  await geo.locator('summary').click();
  await geo.getByRole('combobox', { name: 'Пресет геолокации' }).selectOption('london');
  await expect(geo.getByLabel('Широта', { exact: true })).toHaveValue('51.5074');
  await expect(geo.getByLabel('Долгота', { exact: true })).toHaveValue('-0.1278');
  expect(changes).toHaveLength(1);
  await geo.getByRole('button', { name: 'Задать' }).click();
  await expect.poll(() => changes.length).toBe(2);
  expect(changes[1]).toEqual({ op: 'geo', params: { lat: 51.5074, lon: -0.1278 } });
  await geo.getByLabel('Широта', { exact: true }).fill('100');
  await expect(geo.getByRole('combobox')).toHaveValue('');
  await expect(geo.getByRole('button', { name: 'Задать' })).toBeDisabled();
  expect(await page.locator('.env-panel').evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
});

for (const theme of ['light', 'dark'] as const) {
  test(`long device errors stay in a shared notification in ${theme} theme`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme });
    const error = 'Exception occurred while executing: java.lang.IllegalArgumentException: Unknown package: ru.ivi.client at ' + 'com.android.server.pm.permission.PermissionManagerService.grantRuntimePermission'.repeat(60);
    await page.route(envPath, async route => {
      if (route.request().method() === 'GET') return route.continue();
      await route.fulfill({ status: 422, json: { error: { code: 'env_failed', message: error } } });
    });
    await openEnvironment(page);
    const app = card(page, 'Приложение');
    await app.getByLabel('Пакет', { exact: true }).fill('ru.ivi.client');
    const before = await app.evaluate(el => el.getBoundingClientRect().height);
    await app.getByRole('button', { name: 'Выдать', exact: true }).click();
    const toast = page.locator('.notification-error');
    await expect(toast.getByRole('alert')).toContainText('Приложение не найдено на устройстве. Проверьте имя пакета.');
    await expect(toast.locator('pre')).toHaveCount(0);
    await expect(app).not.toContainText('Exception');
    expect(await app.evaluate(el => el.getBoundingClientRect().height)).toBe(before);
    await toast.getByRole('button', { name: 'Подробности', exact: true }).click();
    await expect(toast.locator('pre')).toContainText('Unknown package: ru.ivi.client');
    const sizes = await toast.evaluate(el => {
      const rect = el.getBoundingClientRect();
      const details = el.querySelector('pre')!;
      return { right: rect.right, bottom: rect.bottom, overflow: details.scrollWidth - details.clientWidth };
    });
    expect(sizes.right).toBeLessThanOrEqual(1366);
    expect(sizes.bottom).toBeLessThanOrEqual(768);
    expect(sizes.overflow).toBeLessThanOrEqual(1);
    await app.getByRole('button', { name: 'Выдать', exact: true }).click();
    await expect(toast).toHaveCount(1);
    await expect(app.getByRole('button', { name: 'Выдать', exact: true })).toBeEnabled();
    await toast.getByRole('button', { name: /^Закрыть уведомление:/ }).focus();
    await page.keyboard.press('Enter');
    await expect(toast).toHaveCount(0);
    expect(await page.locator('.env-panel').evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
  });
}

test('an error remains readable and keyboard accessible when a dialog opens', async ({ page }) => {
  await page.route(envPath, async route => {
    if (route.request().method() === 'GET') return route.continue();
    await route.fulfill({ status: 422, json: { error: { code: 'env_failed', message: 'Unknown package: com.example.missing' } } });
  });
  await openEnvironment(page);
  const app = card(page, 'Приложение');
  await app.getByLabel('Пакет', { exact: true }).fill('com.example.missing');
  await app.getByRole('button', { name: 'Остановить', exact: true }).click();
  const toast = page.locator('.notification-error');
  await expect(toast).toBeVisible();
  await page.clock.install();
  await page.clock.fastForward(7000);
  await expect(toast).toBeVisible();
  await page.clock.resume();
  await page.getByRole('button', { name: 'Все сессии', exact: true }).click();
  await page.getByRole('button', { name: 'Новая сессия', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('.notification-error')).toBeVisible();
  await toast.getByRole('button', { name: /^Закрыть уведомление:/ }).focus();
  await page.keyboard.press('Tab');
  expect(await dialog.evaluate(el => el.contains(document.activeElement))).toBe(true);
  await toast.getByRole('button', { name: /^Закрыть уведомление:/ }).focus();
  await page.keyboard.press('Enter');
  await expect(toast).toHaveCount(0);
  expect(await dialog.evaluate(el => el.contains(document.activeElement))).toBe(true);
});
