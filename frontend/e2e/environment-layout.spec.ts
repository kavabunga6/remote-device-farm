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

for (const variant of [
  { width: 1920, height: 1080, theme: 'light', scale: 1, language: 'ru', split: false },
  { width: 1366, height: 768, theme: 'dark', scale: 1.25, language: 'ru', split: true },
  { width: 390, height: 844, theme: 'dark', scale: 1.5, language: 'ar', split: false },
  { width: 320, height: 844, theme: 'dark', scale: 1.5, language: 'ar', split: false },
] as const) {
  test(`environment headings and controls align at ${variant.width}px (${variant.language})`, async ({ page }, info) => {
    await page.setViewportSize({ width: variant.width, height: variant.height });
    await page.addInitScript(language => localStorage.setItem('rdf.language', language), variant.language);
    await page.route('**/api/me/preferences*', route => route.fulfill({ json: {
      preferences: { theme: variant.theme, fontFamily: 'system', fontScale: variant.scale, defaultAdbKeyId: null },
    } }));
    await page.route('**/api/me/notifications', route => route.fulfill({ json: { notifications: [] } }));
    await page.goto('/#/session/' + sessionId);
    if (!variant.split) await page.locator('.workspace-mode-buttons button').last().click();
    await page.locator('#tool-tab-env').click();
    await expect(page.locator('html')).toHaveAttribute('lang', variant.language);
    await expect(page.locator('html')).toHaveAttribute('data-effective-theme', variant.theme);
    await page.evaluate(() => document.fonts.ready);

    const panel = page.locator('.env-panel');
    const summaries = panel.locator('.env-card > summary');
    await expect(summaries).toHaveCount(7);
    const app = panel.locator('.env-app');
    await app.locator('summary').press('Enter');
    await expect(app).not.toHaveAttribute('open', '');
    const rows = await summaries.evaluateAll(elements => elements.map(element => {
      const title = element.querySelector('strong')!;
      const description = element.querySelector('.env-card-description')!;
      const icon = element.querySelector('.env-card-icon')!.getBoundingClientRect();
      const chevron = element.querySelector('.env-card-chevron')!.getBoundingClientRect();
      return {
        icon: icon.x, chevron: chevron.x,
        hierarchy: parseFloat(getComputedStyle(title).fontSize) > parseFloat(getComputedStyle(description).fontSize),
        descriptionFits: description.scrollWidth <= description.clientWidth + 1 && description.scrollHeight <= description.clientHeight + 1,
        rtl: chevron.right < icon.left,
      };
    }));
    for (const row of rows) {
      expect(row.hierarchy && row.descriptionFits).toBe(true);
      expect(row.rtl).toBe(variant.language === 'ar');
      expect(Math.abs(row.icon - rows[0]!.icon)).toBeLessThanOrEqual(1);
      expect(Math.abs(row.chevron - rows[0]!.chevron)).toBeLessThanOrEqual(1);
    }
    await panel.evaluate(el => { el.scrollTop = 0; });
    await app.locator('summary').blur();
    await page.screenshot({ path: info.outputPath('environment-sections.png') });

    const display = panel.locator('.env-appearance');
    await display.locator('summary').click();
    await expect(display.locator('h3')).toBeVisible();
    const forms = await display.locator('.env-display-row').evaluateAll(elements => elements.map(form => {
      const fields = Array.from(form.querySelectorAll('input'));
      const inputs = fields.map(el => el.getBoundingClientRect());
      const buttons = Array.from(form.querySelectorAll('button'), el => el.getBoundingClientRect());
      const context = document.createElement('canvas').getContext('2d')!;
      return {
        digitsFit: fields.every(input => {
          const style = getComputedStyle(input);
          context.font = style.font;
          const innerWidth = input.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
          return innerWidth + 1 >= context.measureText('4096').width && style.appearance === 'textfield';
        }),
        inputBottom: Math.max(...inputs.map(rect => rect.bottom)),
        inputAlignment: Math.abs(inputs[0]!.bottom - inputs.at(-1)!.bottom),
        buttonTop: buttons[0]!.top, buttonBottom: buttons[0]!.bottom,
        buttonAlignment: Math.abs(buttons[0]!.bottom - buttons[1]!.bottom),
      };
    }));
    for (const form of forms) {
      expect(form.digitsFit).toBe(true);
      expect(Math.max(form.inputAlignment, form.buttonAlignment)).toBeLessThanOrEqual(1);
      if (variant.width < 480) expect(form.buttonTop).toBeGreaterThan(form.inputBottom);
      else expect(Math.abs(form.inputBottom - form.buttonBottom)).toBeLessThanOrEqual(1);
    }
    await display.locator('.env-display-settings').scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath('environment-display.png') });
    expect(await panel.evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
  });
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

for (const [theme, width] of [['dark', 1366], ['light', 390]] as const) {
test(`a page error stays behind an open launch dialog in ${theme} theme at ${width}px`, async ({ page }, testInfo) => {
  await page.route('**/api/me/preferences*', route => route.fulfill({ json: {
    preferences: { theme, fontFamily: 'system', fontScale: 1.25, defaultAdbKeyId: null },
  } }));
  await page.route(envPath, async route => {
    if (route.request().method() === 'GET') return route.continue();
    await route.fulfill({ status: 422, json: { error: { code: 'env_failed', message: 'Unknown package: com.example.missing' } } });
  });
  await openEnvironment(page);
  const app = card(page, 'Приложение');
  await app.getByLabel('Пакет', { exact: true }).fill('com.example.missing');
  await app.getByRole('button', { name: 'Остановить', exact: true }).click();
  const stack = page.locator('body > .notification-stack');
  const toast = stack.locator('.notification-error');
  await expect(toast).toBeVisible();
  await page.clock.install();
  await page.clock.fastForward(7000);
  await expect(toast).toBeVisible();
  await page.clock.resume();
  await toast.getByRole('button', { name: 'Подробности', exact: true }).click();
  await page.getByRole('button', { name: 'Все сессии', exact: true }).click();
  await page.setViewportSize({ width, height: 900 });
  const originalToast = await toast.elementHandle();
  await page.getByRole('button', { name: 'Новая сессия', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Новая сессия' });
  await expect(dialog).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-effective-theme', theme);
  await expect(stack).toHaveAttribute('inert', '');
  await expect(dialog.locator('.notification-error')).toHaveCount(0);
  expect(await toast.evaluate((element, original) => element === original, originalToast)).toBe(true);
  expect(await toast.evaluate(element => {
    const { x, y, width, height } = element.getBoundingClientRect();
    return Boolean(document.elementFromPoint(x + width / 2, y + height / 2)?.closest('.modal-backdrop'));
  })).toBe(true);
  await toast.locator('.notification-close').evaluate(button => (button as HTMLElement).focus());
  await page.keyboard.press('Tab');
  expect(await dialog.evaluate(el => el.contains(document.activeElement))).toBe(true);
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: testInfo.outputPath('notification-behind-dialog.png') });
  await dialog.getByRole('button', { name: 'Отмена', exact: true }).click();
  await expect(stack).not.toHaveAttribute('inert', '');
  await expect(toast.locator('pre')).toContainText('Unknown package: com.example.missing');
  await toast.getByRole('button', { name: /^Закрыть уведомление:/ }).click();
  await expect(toast).toHaveCount(0);
});
}
