import { expect, test, type Page } from '@playwright/test';
const id = '44444444-4444-4444-8444-444444444444';
const person = { id, username: 'ivan', displayName: 'Иван Петров', provider: 'local', role: 'user', createdAt: '2026-01-01T00:00:00Z' };
async function fixture(page: Page, theme = 'light', scale = 1) {
  await page.route('**/api/me/preferences', route => route.fulfill({ json: { preferences: { theme, fontScale: scale, fontFamily: 'system', defaultAdbKeyId: null } } }));
  await page.route('**/api/admin/users', route => route.fulfill({ json: { users: [person, { ...person, id: 'external', username: 'directory', displayName: 'LDAP User', provider: 'ldap' }] } }));
  await page.goto('/#/admin/users');
  await expect(page.getByRole('button', { name: 'Сбросить пароль пользователя «Иван Петров»', exact: true })).toBeVisible();
}
for (const theme of ['light', 'dark']) test(`admin password reset validates, retries and identifies its user in ${theme}`, async ({ page }) => {
  await fixture(page, theme);
  await expect(page.getByRole('button', { name: /Сбросить пароль пользователя/ })).toHaveCount(1);
  const trigger = page.getByRole('button', { name: 'Сбросить пароль пользователя «Иван Петров»', exact: true });
  await trigger.click();
  const dialog = page.getByRole('dialog', { name: 'Сбросить пароль', exact: true });
  const password = dialog.getByLabel('Новый пароль', { exact: true });
  const confirmation = dialog.getByLabel('Повторите пароль', { exact: true });
  await expect(password).toBeFocused();
  await expect(dialog).toContainText('@ivan');
  await expect(dialog.getByRole('button', { name: 'Сбросить пароль', exact: true })).toBeDisabled();
  let requests = 0;
  await page.route(`**/api/admin/users/${id}/password`, route => {
    requests++;
    expect(route.request().postDataJSON()).toEqual({ newPassword: 'new-password-example' });
    return route.fulfill(requests === 1 ? { status: 500, json: { error: { code: 'internal_error', message: 'Не удалось сбросить пароль' } } } : { json: { ok: true } });
  });
  await password.fill('new-password-example');
  await confirmation.fill('different-password-example');
  await dialog.getByRole('button', { name: 'Сбросить пароль', exact: true }).click();
  await expect(dialog.getByRole('alert')).toHaveText('Пароли не совпадают.');
  expect(requests).toBe(0);
  await confirmation.fill('new-password-example');
  await dialog.getByRole('button', { name: 'Сбросить пароль', exact: true }).click();
  await expect(dialog.getByRole('alert')).toHaveText('Не удалось сбросить пароль');
  await expect(password).toHaveValue('new-password-example');
  await dialog.getByRole('button', { name: 'Сбросить пароль', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('.notification-toast').filter({ hasText: 'Пароль сброшен' })).toContainText('Иван Петров (@ivan)');
  await expect(trigger).toBeFocused();
  await page.getByRole('button', { name: 'Изменить пользователя «Иван Петров»', exact: true }).click();
  await page.getByRole('dialog', { name: 'Данные пользователя' }).getByRole('button', { name: 'Сбросить пароль', exact: true }).click();
  await expect(dialog).toBeVisible();
  await expect(password).toHaveValue('');
  await expect(page.getByRole('dialog')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
});
for (const [width, theme, scale] of [[1366, 'light', 1], [1366, 'dark', 1], [390, 'light', 1], [390, 'dark', 1], [1366, 'light', 1.5]] as const) {
  test(`password reset fields align at ${width} ${theme} ${scale}`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await fixture(page, theme, scale);
    await page.getByRole('button', { name: 'Сбросить пароль пользователя «Иван Петров»', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Сбросить пароль', exact: true });
    await page.evaluate(() => document.fonts.ready);
    const geometry = await dialog.evaluate(element => {
      const fields = [...element.querySelectorAll('.user-password-fields input')].map(field => field.getBoundingClientRect());
      const box = element.getBoundingClientRect();
      const tools = [...element.querySelectorAll('.password-tools-actions button')].map(button => button.getBoundingClientRect());
      const toolsAligned = Math.max(...tools.map(box => box.top)) - Math.min(...tools.map(box => box.top)) <= 1 && Math.max(...tools.map(box => box.bottom)) - Math.min(...tools.map(box => box.bottom)) <= 1;
      const toolsInside = tools.every(tool => tool.left >= box.left && tool.right <= box.right);
      return { toolsAligned, toolsInside, topDiff: Math.abs(fields[0].top - fields[1].top), bottomDiff: Math.abs(fields[0].bottom - fields[1].bottom), heightDiff: Math.abs(fields[0].height - fields[1].height), left: box.left, right: box.right, overflow: document.documentElement.scrollWidth - innerWidth };
    });
    expect(geometry.toolsAligned).toBe(true); expect(geometry.toolsInside).toBe(true);
    expect(geometry.overflow).toBeLessThanOrEqual(1);
    expect(geometry.left).toBeGreaterThanOrEqual(0); expect(geometry.right).toBeLessThanOrEqual(width);
    expect(geometry.heightDiff).toBeLessThanOrEqual(1);
    if (width > 600) { expect(geometry.topDiff).toBeLessThanOrEqual(1); expect(geometry.bottomDiff).toBeLessThanOrEqual(1); }
    await dialog.getByLabel('Новый пароль', { exact: true }).fill('new-password-example');
    await dialog.getByLabel('Повторите пароль', { exact: true }).fill('different-password');
    await dialog.getByRole('button', { name: 'Сбросить пароль', exact: true }).click();
    await expect(dialog.getByRole('alert')).toBeVisible();
    await page.screenshot({ path: `../.tmp-ui/password-reset/${width}-${theme}-${scale}.png`, animations: 'disabled' });
  });
}
