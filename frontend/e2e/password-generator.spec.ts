import { expect, test, type Page } from '@playwright/test';
const id = '44444444-4444-4444-8444-444444444444';
const person = { id, username: 'ivan', displayName: 'Иван Петров', provider: 'local', role: 'user', createdAt: '2026-01-01T00:00:00Z' };
async function resetFixture(page: Page) {
  await page.route('**/api/admin/users', route => route.fulfill({ json: { users: [person] } }));
  await page.goto('/#/admin/users');
  await page.getByRole('button', { name: 'Сбросить пароль пользователя «Иван Петров»', exact: true }).click();
  return page.getByRole('dialog', { name: 'Сбросить пароль', exact: true });
}

test('admin generates, shows, copies and regenerates a password; nothing is saved before confirmation', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  let requests = 0, savedPassword = '';
  await page.route(`**/api/admin/users/${id}/password`, route => {
    requests++; savedPassword = route.request().postDataJSON().newPassword;
    return route.fulfill({ json: { ok: true } });
  });
  const dialog = await resetFixture(page);
  const password = dialog.getByLabel('Новый пароль', { exact: true });
  const confirmation = dialog.getByLabel('Повторите пароль', { exact: true });
  await expect(dialog.getByRole('button', { name: 'Копировать пароль', exact: true })).toBeDisabled();
  await dialog.getByRole('button', { name: 'Сгенерировать', exact: true }).click();
  const first = await password.inputValue(); expect(first).toHaveLength(20); await expect(confirmation).toHaveValue(first);
  await expect(password).toHaveAttribute('type', 'password'); expect(requests).toBe(0);
  await dialog.getByRole('button', { name: 'Показать пароль', exact: true }).click();
  await expect(password).toHaveAttribute('type', 'text'); await expect(confirmation).toHaveAttribute('type', 'text');
  await dialog.getByRole('button', { name: 'Копировать пароль', exact: true }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(first);
  await expect(dialog.getByRole('status')).toHaveText('Пароль скопирован.');
  await confirmation.fill('mismatched-password');
  await dialog.getByRole('button', { name: 'Сгенерировать', exact: true }).click();
  const second = await password.inputValue(); expect(second).not.toBe(first); await expect(confirmation).toHaveValue(second);
  await expect(dialog.getByRole('status')).toHaveCount(0); expect(requests).toBe(0);
  await dialog.getByRole('button', { name: 'Сбросить пароль', exact: true }).click();
  await expect(dialog).toHaveCount(0); expect(requests).toBe(1); expect(savedPassword).toBe(second);
  await page.getByRole('button', { name: 'Сбросить пароль пользователя «Иван Петров»', exact: true }).click();
  await expect(password).toHaveValue(''); await expect(password).toHaveAttribute('type', 'password');
});

test('own password generation keeps the current password and submits matching fields only on save', async ({ page }) => {
  let requests = 0, body: unknown;
  await page.route('**/api/me/password', route => { requests++; body = route.request().postDataJSON(); return route.fulfill({ json: { ok: true } }); });
  await page.goto('/#/account/security');
  const form = page.locator('.settings-password-form');
  await form.getByLabel('Текущий пароль', { exact: true }).fill('old-password-example');
  await form.getByRole('button', { name: 'Сгенерировать', exact: true }).click();
  const generated = await form.getByLabel('Новый пароль', { exact: true }).inputValue(); expect(generated).toHaveLength(20);
  await expect(form.getByLabel('Повторите новый пароль', { exact: true })).toHaveValue(generated);
  await expect(form.getByLabel('Текущий пароль', { exact: true })).toHaveValue('old-password-example'); expect(requests).toBe(0);
  await form.getByRole('button', { name: 'Показать пароль', exact: true }).click();
  await expect(form.getByLabel('Текущий пароль', { exact: true })).toHaveAttribute('type', 'password');
  await form.getByRole('button', { name: 'Изменить пароль', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Пароль изменён.' })).toBeVisible();
  expect(body).toEqual({ currentPassword: 'old-password-example', newPassword: generated }); expect(requests).toBe(1);
  for (const label of ['Текущий пароль', 'Новый пароль', 'Повторите новый пароль']) await expect(form.getByLabel(label, { exact: true })).toHaveValue('');
  await expect(form.getByRole('button', { name: 'Копировать пароль', exact: true })).toBeDisabled();
});

test('new users can generate a password and a clipboard failure has a usable fallback', async ({ page }) => {
  await page.goto('/#/admin/users');
  await page.getByRole('button', { name: 'Новый пользователь', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Новый пользователь', exact: true });
  await dialog.getByRole('button', { name: 'Сгенерировать', exact: true }).click();
  const password = dialog.getByLabel('Пароль', { exact: true }); expect(await password.inputValue()).toHaveLength(20);
  await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new Error('denied'); } } }));
  await dialog.getByRole('button', { name: 'Копировать пароль', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('Покажите пароль');
  await dialog.getByRole('button', { name: 'Показать пароль', exact: true }).click();
  await expect(password).toHaveAttribute('type', 'text');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Новый пользователь', exact: true }).click();
  await expect(password).toHaveValue(''); await expect(password).toHaveAttribute('type', 'password');
});

for (const [width, theme, scale] of [[1366, 'light', 1], [1366, 'dark', 1], [390, 'light', 1], [390, 'dark', 1], [1366, 'light', 1.5]] as const) test(`own password controls align at ${width} ${theme} ${scale}`, async ({ page }) => {
  await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
  await page.route('**/api/me/preferences', route => route.fulfill({ json: { preferences: { theme, fontScale: scale, fontFamily: 'system', defaultAdbKeyId: null } } }));
  await page.goto('/#/account/security');
  await page.locator('.settings-password-form').getByRole('button', { name: 'Сгенерировать', exact: true }).click();
  await page.evaluate(() => document.fonts.ready);
  const geometry = await page.locator('.password-tools-actions').evaluate(element => {
    const boxes = [...element.querySelectorAll('button')].map(button => button.getBoundingClientRect());
    const fields = [...element.closest('form')!.querySelectorAll('.new-password-fields input')].map(field => field.getBoundingClientRect());
    const formBox = element.closest('form')!.getBoundingClientRect();
    const pairBox = element.closest('form')!.querySelector('.new-password-fields')!.getBoundingClientRect();
    const groupAligned = Math.abs(formBox.left - pairBox.left) <= 1 && Math.abs(formBox.right - pairBox.right) <= 1;
    const fieldsAligned = Math.abs(fields[0].top - fields[1].top) <= 1 && Math.abs(fields[0].bottom - fields[1].bottom) <= 1;
    return { groupAligned, fieldsAligned, tops: boxes.map(box => box.top), bottoms: boxes.map(box => box.bottom), inside: boxes.every(box => box.left >= 0 && box.right <= innerWidth), overflow: document.documentElement.scrollWidth - innerWidth };
  });
  expect(Math.max(...geometry.tops) - Math.min(...geometry.tops)).toBeLessThanOrEqual(1);
  expect(Math.max(...geometry.bottoms) - Math.min(...geometry.bottoms)).toBeLessThanOrEqual(1);
  expect(geometry.groupAligned).toBe(true);
  if (width > 600) expect(geometry.fieldsAligned).toBe(true);
  expect(geometry.inside).toBe(true); expect(geometry.overflow).toBeLessThanOrEqual(1);
  await page.screenshot({ path: `../.tmp-ui/password-generator/own-${width}-${theme}-${scale}.png`, animations: 'disabled', fullPage: true });
});
