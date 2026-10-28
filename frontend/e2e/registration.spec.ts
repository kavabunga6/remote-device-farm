import { expect, test, type Page } from '@playwright/test';
const roleId = '00000000-0000-4000-8000-000000000002';
async function signOut(page: Page, enabled = true) {
  await page.route('**/api/me', route => route.fulfill({ json: { user: null } }));
  await page.route('**/api/config', route => route.fulfill({ json: { authMethods: ['local'], registrationEnabled: enabled } }));
  await page.goto('/');
}
test('registration navigation, confirmation and language switching preserve entered credentials', async ({ page }) => {
  await signOut(page);
  let posts = 0;
  await page.route('**/api/register', route => { posts++; return route.fulfill({ status: 409, json: { error: { code: 'registration_login_unavailable', message: 'This username is unavailable. Choose another.' } } }); });
  await page.getByRole('link', { name: 'Зарегистрироваться', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Создание аккаунта' })).toBeVisible();
  await page.getByRole('textbox', { name: 'Логин', exact: true }).fill('new-user');
  await page.getByLabel('Пароль', { exact: true }).fill('example-password-42');
  await page.getByLabel('Повторите пароль', { exact: true }).fill('another-password-42');
  await page.getByRole('button', { name: 'Создать аккаунт', exact: true }).click();
  await expect(page.getByRole('alert')).toBeVisible(); expect(posts).toBe(0);
  await page.getByLabel('Повторите пароль', { exact: true }).fill('example-password-42');
  const trigger = page.getByRole('button', { name: 'Язык интерфейса: Русский' });
  await trigger.click();
  await page.getByRole('menuitemradio', { name: 'English', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Create an account' })).toBeVisible();
  await expect(page.getByLabel('Username', { exact: true })).toHaveValue('new-user');
  await expect(page.getByLabel('Password', { exact: true })).toHaveValue('example-password-42');
  await expect(page.getByLabel('Confirm password', { exact: true })).toHaveValue('example-password-42');
  await expect(page.getByRole('button', { name: 'Interface language: English' })).toBeFocused();
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('This username is unavailable. Choose another.'); expect(posts).toBe(1);
  await page.getByRole('button', { name: 'Show password' }).click();
  await expect(page.getByLabel('Password', { exact: true })).toHaveAttribute('type', 'text');
  await page.getByRole('link', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
});
test('disabled registration has no entry point, including a direct URL', async ({ page }) => {
  await signOut(page, false); await page.goto('/#/register');
  await expect(page.getByRole('heading', { name: 'Вход', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Зарегистрироваться', exact: true })).toHaveCount(0);
});
test('registration submits only credentials and signs in after a successful creation', async ({ page }) => {
  await signOut(page);
  let submitted: unknown, created = false;
  const user = { id: 'registered-user', username: 'new-user', role: 'user', roleId, permissions: ['sessions.view'] };
  await page.route('**/api/me', route => route.fulfill({ json: { user: created ? user : null } }));
  await page.route('**/api/register', route => {
    submitted = route.request().postDataJSON(); created = true;
    return route.fulfill({ status: 201, json: { user } });
  });
  await page.getByRole('link', { name: 'Зарегистрироваться', exact: true }).click();
  await page.getByLabel('Логин', { exact: true }).fill('new-user');
  await page.getByLabel('Пароль', { exact: true }).fill('example-password-42');
  await page.getByLabel('Повторите пароль', { exact: true }).fill('example-password-42');
  await page.getByRole('button', { name: 'Создать аккаунт', exact: true }).click();
  await expect(page.locator('.login-card')).toHaveCount(0);
  expect(submitted).toEqual({ username: 'new-user', password: 'example-password-42' });
});
test('administrator chooses a registration role; failed save preserves the draft', async ({ page }) => {
  const custom = { id: 'observer-role', name: 'Observer', builtin: null, permissions: ['sessions.view'], userCount: 0 };
  const user = { id: roleId, name: 'User', builtin: 'user', permissions: ['sessions.view'], userCount: 0 };
  await page.route('**/api/admin/roles', route => route.fulfill({ json: { roles: [user, custom, { id: 'admin-role', name: 'Administrator', builtin: 'admin', permissions: [], userCount: 1 }] } }));
  let settings = { enabled: false, roleId, available: true }, saves = 0;
  await page.route('**/api/admin/registration-settings', route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: { settings } });
    saves++;
    if (saves === 1) return route.fulfill({ status: 503, json: { error: { message: 'Unavailable' } } });
    settings = { ...settings, ...route.request().postDataJSON() };
    return route.fulfill({ json: { settings } });
  });
  await page.goto('/#/admin/roles');
  const card = page.locator('.registration-settings'); await card.locator('summary').click();
  await card.getByRole('combobox').selectOption('observer-role');
  await expect(card.locator('option[value="admin-role"]')).toHaveCount(0);
  await card.getByRole('switch').check();
  await card.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect(card.getByRole('alert')).toBeVisible();
  await expect(card.getByRole('combobox')).toHaveValue('observer-role'); await expect(card.getByRole('switch')).toBeChecked();
  await card.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect(card.getByRole('status')).toHaveText('Настройки регистрации сохранены');
  expect(settings).toEqual({ enabled: true, roleId: 'observer-role', available: true });
});
for (const theme of ['light', 'dark']) test(`registration geometry and language menu in ${theme}`, async ({ page }) => {
  await page.emulateMedia({ colorScheme: theme as 'light' | 'dark' });
  await page.addInitScript(theme => localStorage.setItem('rdf.theme', theme), theme);
  await page.setViewportSize({ width: 1366, height: 1000 });
  await signOut(page); await page.getByRole('link', { name: 'Зарегистрироваться', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-effective-theme', theme);
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: `../.tmp-ui/registration-${theme}-form.png`, fullPage: true });
  await page.getByRole('button', { name: 'Язык интерфейса: Русский' }).click();
  await page.screenshot({ path: `../.tmp-ui/registration-${theme}.png`, fullPage: true });
  const before = await page.locator('.login-card').boundingBox(); await page.keyboard.press('Escape');
  expect(await page.locator('.login-card').boundingBox()).toEqual(before);
  for (const [width, scale] of [[1366, 1], [1366, 1.5], [390, 1]]) {
    await page.setViewportSize({ width, height: 1100 });
    await page.evaluate(scale => document.documentElement.style.fontSize = `${16 * scale}px`, scale);
    const geometry = await page.locator('.login-form').evaluate(form => {
      const boxes = [...form.querySelectorAll('input,button[type=submit]')].map(el => el.getBoundingClientRect());
      return { left: boxes.map(r => r.left), right: boxes.map(r => r.right), height: boxes.map(r => r.height), overflow: document.documentElement.scrollWidth > innerWidth };
    });
    expect(Math.max(...geometry.left) - Math.min(...geometry.left)).toBeLessThanOrEqual(1);
    expect(Math.max(...geometry.right) - Math.min(...geometry.right)).toBeLessThanOrEqual(1);
    expect(Math.max(...geometry.height) - Math.min(...geometry.height)).toBeLessThanOrEqual(1);
    expect(geometry.overflow).toBe(false);
  }
});
