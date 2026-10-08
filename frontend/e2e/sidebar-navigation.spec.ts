import { expect, test, type Page } from '@playwright/test';

test('the brand opens the overview and every sidebar click reloads the page even when it is already open', async ({ page }) => {
  let hostLoads = 0;
  await page.route('**/api/hosts', route => { hostLoads++; return route.continue(); });
  await page.goto('/#/admin/users');
  const search = page.getByLabel('Найти пользователя');
  await search.fill('иван');
  const before = hostLoads;
  await page.getByRole('navigation', { name: 'Администрирование' }).getByRole('link', { name: 'Пользователи' }).click();
  await expect(search).toHaveValue('');
  await expect.poll(() => hostLoads).toBeGreaterThan(before);
  await page.getByRole('link', { name: 'Device Farm — Сессии' }).click();
  await expect(page).toHaveURL(/#\/overview$/);
  await expect(page.getByRole('heading', { name: 'Сессии', level: 1 })).toBeVisible();
});


const counts = { sessions: 2, allSessions: 17, tokens: 0, nodes: 3, profiles: 1024, users: 1234567 };
async function sidebarFixture(page: Page, theme = 'light', scale = 1) {
  await page.route('**/api/me/preferences', route => route.fulfill({ json: { preferences: { theme, fontScale: scale, fontFamily: 'system', defaultAdbKeyId: null } } }));
  await page.route('**/api/navigation-counts', route => route.fulfill({ json: { counts } }));
  await page.goto('/#/overview');
  await expect(page.locator('.sidebar .side-nav-count')).toHaveCount(6);
  await expect(page.getByRole('navigation', { name: 'Главная навигация' }).getByRole('link', { name: 'Сессии', exact: true }).locator('small')).toHaveText('2');
  await page.evaluate(() => document.fonts.ready);
}

test('sidebar separates own/all sessions, displays zero and refreshes on focus', async ({ page }) => {
  await sidebarFixture(page);
  const admin = page.getByRole('navigation', { name: 'Администрирование' });
  await expect(admin.getByRole('link', { name: 'Все сессии' }).locator('small')).toHaveText('17');
  await expect(page.getByRole('link', { name: 'API-токены', exact: true }).locator('small')).toHaveText('0');
  await page.route('**/api/navigation-counts', route => route.fulfill({ json: { counts: { ...counts, sessions: 0, users: 9 } } }));
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(admin.getByRole('link', { name: 'Пользователи' }).locator('small')).toHaveText('9');
  await expect(page.getByRole('link', { name: 'Сессии', exact: true }).locator('small')).toHaveText('0');
});

test('counter failure leaves navigation and the session list usable, and ordinary users have no admin counts', async ({ page }) => {
  await page.route('**/api/navigation-counts', route => route.fulfill({ status: 503, json: { error: { message: 'temporarily unavailable' } } }));
  await page.goto('/#/overview');
  await expect(page.getByRole('heading', { name: 'Мои сессии' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Сессии', exact: true }).locator('small')).toHaveText('—');
  await page.route('**/api/me', route => route.fulfill({ json: { user: { id: 'u2', username: 'ivan', role: 'user' } } }));
  await page.route('**/api/navigation-counts', route => route.fulfill({ json: { counts: { sessions: 0, tokens: 3 } } }));
  await page.reload();
  await expect(page.getByRole('navigation', { name: 'Администрирование' })).toHaveCount(0);
  await expect(page.locator('.side-nav-count')).toHaveCount(2);
  await expect(page.getByRole('link', { name: 'API-токены', exact: true }).locator('small')).toHaveText('3');
});

for (const [width, theme, scale] of [[1366, 'light', 1], [1366, 'dark', 1], [390, 'light', 1], [390, 'dark', 1], [1366, 'light', 1.5]] as const) test(`sidebar count alignment at ${width} ${theme} ${scale}`, async ({ page }) => {
  await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
  await sidebarFixture(page, theme, scale);
  if (width === 390) await page.getByRole('button', { name: 'Открыть меню' }).click();
  const badges = page.locator('.sidebar .side-nav-count');
  await expect(badges.first()).toBeVisible();
  const geometry = await badges.evaluateAll(elements => elements.map(element => {
    const badge = element.getBoundingClientRect(), row = element.parentElement!.getBoundingClientRect();
    const icon = element.parentElement!.querySelector('svg')!.getBoundingClientRect();
    const range = document.createRange(); range.selectNodeContents(element.parentElement!.querySelector('span')!);
    const textRight = range.getBoundingClientRect().right;
    return { textGap: badge.left - textRight, center: (badge.left + badge.right) / 2, centered: Math.abs((badge.top + badge.bottom - row.top - row.bottom) / 2), iconCenter: Math.abs((icon.top + icon.bottom - badge.top - badge.bottom) / 2), inside: badge.left >= row.left && badge.right <= row.right, overflow: element.parentElement!.scrollWidth - element.parentElement!.clientWidth };
  }));
  expect(Math.max(...geometry.map(box => box.center)) - Math.min(...geometry.map(box => box.center))).toBeLessThanOrEqual(1);
  for (const box of geometry) { expect(box.textGap).toBeGreaterThanOrEqual(6); expect(box.centered).toBeLessThanOrEqual(1); expect(box.iconCenter).toBeLessThanOrEqual(1); expect(box.inside).toBe(true); expect(box.overflow).toBeLessThanOrEqual(1); }
  await page.getByRole('navigation', { name: 'Администрирование' }).getByRole('link', { name: 'Профили устройств' }).click();
  if (width === 390) await page.getByRole('button', { name: 'Открыть меню' }).click();
  // Selected and unselected badges share the same trailing column.
  const centers = await badges.evaluateAll(elements => elements.map(element => { const rect = element.getBoundingClientRect(); return (rect.left + rect.right) / 2; }));
  expect(Math.max(...centers) - Math.min(...centers)).toBeLessThanOrEqual(1);
  await page.screenshot({ path: `../.tmp-ui/sidebar-counts/${width}-${theme}-${scale}.png`, animations: 'disabled', fullPage: true });
});


test('creating a user refreshes the sidebar total immediately', async ({ page }) => {
  let userCount = 2;
  await page.route('**/api/navigation-counts', route => route.fulfill({ json: { counts: { ...counts, users: userCount } } }));
  await page.route('**/api/admin/users', async route => {
    if (route.request().method() === 'POST') userCount++;
    await route.continue();
  });
  await page.goto('/#/admin/users');
  const badge = page.getByRole('navigation', { name: 'Администрирование' }).getByRole('link', { name: 'Пользователи' }).locator('small');
  await expect(badge).toHaveText('2');
  await page.getByRole('button', { name: 'Новый пользователь', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Логин', { exact: true }).fill('sidebar-count-user');
  await dialog.getByLabel('Отображаемое имя', { exact: true }).fill('Проверка счётчика');
  await dialog.getByLabel('Пароль', { exact: true }).fill('counter-test-password');
  await dialog.getByRole('button', { name: 'Создать пользователя', exact: true }).click();
  await expect(badge).toHaveText('3');
});
