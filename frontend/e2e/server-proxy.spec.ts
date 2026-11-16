import { test, expect } from '@playwright/test';

test('proxy password is write-only, retained by omission, and cleared explicitly', async ({ page }) => {
  let proxy = { enabled: true, url: 'http://proxy.example:3128', username: 'builder', passwordSet: true, noProxy: '' };
  const writes: Array<Record<string, unknown>> = [];
  await page.route('**/api/admin/outbound-proxy', async route => {
    if (route.request().method() === 'PUT') {
      const { password, ...patch } = route.request().postDataJSON(); writes.push({ ...patch, ...(password !== undefined ? { password } : {}) });
      proxy = { ...proxy, ...patch, passwordSet: password === undefined ? proxy.passwordSet : Boolean(password) };
    }
    await route.fulfill({ json: { proxy } });
  });
  await page.goto('/#/admin/settings');
  await expect(page.getByRole('heading', { name: 'Настройки сервера', exact: true })).toBeVisible();
  const password = page.getByLabel('Пароль', { exact: true });
  await expect(password).toHaveValue('');
  const save = page.getByRole('button', { name: 'Сохранить', exact: true });
  const reset = page.getByRole('button', { name: 'Отменить изменения' });
  await expect(save).toBeDisabled(); await expect(reset).toBeDisabled();
  await page.getByLabel('Адрес прокси').fill('https://proxy.example:8443');
  await expect(page.locator('.floating-form-save')).toBeVisible();
  await save.click(); await expect(save).toBeDisabled();
  expect(writes[0]).not.toHaveProperty('password');
  await page.getByLabel('Без прокси (NO_PROXY)', { exact: true }).fill('localhost,example.com');
  await save.click(); await expect(save).toBeDisabled();
  expect(writes.at(-1)?.noProxy).toBe('localhost,example.com');
  await password.fill('new test password'); await save.click(); await expect(save).toBeDisabled();
  expect(writes[2].password).toBe('new test password'); await expect(password).toHaveValue('');
  await page.getByRole('button', { name: 'Удалить сохранённый пароль' }).click();
  await save.click(); await expect(save).toBeDisabled(); expect(writes[3].password).toBe('');
  await expect(page.getByRole('button', { name: 'Удалить сохранённый пароль' })).toHaveCount(0);
  await page.getByLabel('Логин (необязательно)').fill('changed'); await expect(reset).toBeEnabled();
  await reset.click(); await expect(page.getByLabel('Логин (необязательно)')).toHaveValue('builder');
});

for (const [theme, language, scale] of [['light', 'ru', 1], ['dark', 'ru', 1.5], ['light', 'ar', 1.25], ['dark', 'de', 1.25]] as const) {
  test(`proxy form stays aligned in ${theme}, ${language}, ${scale}`, async ({ page }) => {
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.addInitScript(lang => localStorage.setItem('rdf-language', lang), language);
    await page.route('**/api/me/preferences*', route => route.fulfill({ json: { preferences: { theme, fontFamily: 'system', fontScale: scale, defaultAdbKeyId: null } } }));
    await page.route('**/api/admin/outbound-proxy', route => route.fulfill({ json: { proxy: { enabled: true, url: 'https://proxy.example:8443', username: 'builder', passwordSet: true, noProxy: '' } } }));
    await page.goto('/#/admin/settings'); await expect(page.locator('.proxy-credentials input')).toHaveCount(2);
    await page.evaluate(async language => { const { setLanguage } = await import('/src/i18n.ts'); await setLanguage(language); }, language);
    await expect(page.locator('html')).toHaveAttribute('dir', language === 'ar' ? 'rtl' : 'ltr');
    await page.evaluate(() => document.fonts.ready);
    const fields = page.locator('.proxy-credentials input');
    await expect.poll(() => fields.evaluateAll(elements => {
      const [a, b] = elements.map(x => x.getBoundingClientRect());
      return Math.max(Math.abs(a.top - b.top), Math.abs(a.bottom - b.bottom));
    })).toBeLessThanOrEqual(1);
    await page.screenshot({ path: `../.tmp-ui/proxy/${theme}-${language}-desktop.png`, fullPage: true, animations: 'disabled' });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect.poll(() => fields.evaluateAll(elements => {
      const [a, b] = elements.map(x => x.getBoundingClientRect());
      return Math.abs(a.left - b.left) + Math.abs(a.width - b.width);
    })).toBeLessThanOrEqual(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
    await page.screenshot({ path: `../.tmp-ui/proxy/${theme}-${language}-mobile.png`, fullPage: true, animations: 'disabled' });
  });
}
