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


const counts = { sessions: 2, allSessions: 17, tokens: 0, nodes: 3, profiles: 1024, images: 8, users: 1234567 };
async function sidebarFixture(page: Page, theme = 'light', scale = 1) {
  await page.route('**/api/me/preferences', route => route.fulfill({ json: { preferences: { theme, fontScale: scale, fontFamily: 'system', defaultAdbKeyId: null } } }));
  await page.route('**/api/navigation-counts', route => route.fulfill({ json: { counts } }));
  await page.goto('/#/overview');
  await expect(page.locator('.sidebar .side-nav-count')).toHaveCount(7);
  await expect(page.getByRole('navigation', { name: 'Главная навигация' }).getByRole('link', { name: 'Сессии', exact: true }).locator('small')).toHaveText('2');
  await page.evaluate(() => document.fonts.ready);
}

test('compact sidebar keeps navigation and account actions accessible and remembers the layout', async ({ page }, info) => {
  await page.setViewportSize({ width: 1366, height: 800 });
  await sidebarFixture(page, 'dark', 1.25);
  const sidebar = page.locator('.sidebar');
  const links = sidebar.locator('.side-nav a');
  const count = await links.count();
  const fullWidth = (await sidebar.boundingBox())!.width;
  await sidebar.getByRole('button', { name: 'Свернуть боковое меню' }).press('Enter');
  const expand = sidebar.getByRole('button', { name: 'Развернуть боковое меню' });
  await expect(expand).toBeFocused();
  await expect(expand).toHaveAttribute('aria-expanded', 'false');
  expect((await sidebar.boundingBox())!.width).toBeLessThan(fullWidth / 2);
  await expect(links).toHaveCount(count);
  const items = await sidebar.locator('.side-nav a, .side-profile, .side-logout').evaluateAll(nodes => nodes.map(node => {
    const button = node.getBoundingClientRect();
    return { width: button.width, height: button.height, center: button.x + button.width / 2, label: node.getAttribute('title') };
  }));
  const centers = items.map(item => item.center);
  expect(Math.max(...centers) - Math.min(...centers)).toBeLessThanOrEqual(1);
  for (const item of items) { expect(item.width).toBe(44); expect(item.height).toBe(44); expect(item.label).toBeTruthy(); }
  await sidebar.getByRole('link', { name: 'Пользователи', exact: true }).press('Enter');
  await expect(page.getByRole('heading', { name: 'Пользователи', level: 1 })).toBeVisible();
  await page.reload();
  await expect(expand).toBeVisible();
  await expect(sidebar.getByRole('link', { name: 'Пользователи', exact: true })).toHaveAttribute('aria-current', 'page');
  await page.screenshot({ path: info.outputPath('compact-sidebar.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Открыть меню' }).click();
  await expect(expand).toBeHidden();
  await expect(sidebar.getByRole('link', { name: 'Пользователи', exact: true }).locator('span')).toBeVisible();
  await expect(sidebar.locator('.side-profile-name')).toBeVisible();
  await expect(sidebar.getByRole('button', { name: 'Выйти' })).toBeVisible();
});

test('sidebar separates own/all sessions, displays zero and refreshes on focus', async ({ page }) => {
  await sidebarFixture(page);
  const admin = page.getByRole('navigation', { name: 'Администрирование' });
  await expect(admin.getByRole('link', { name: 'Все сессии' }).locator('small')).toHaveText('17');
  await expect(admin.getByRole('link', { name: 'Образы', exact: true }).locator('small')).toHaveText('8');
  await expect(page.getByRole('link', { name: 'API-токены', exact: true }).locator('small')).toHaveText('0');
  await page.route('**/api/navigation-counts', route => route.fulfill({ json: { counts: { ...counts, sessions: 0, users: 9, images: 0 } } }));
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(admin.getByRole('link', { name: 'Пользователи' }).locator('small')).toHaveText('9');
  await expect(admin.getByRole('link', { name: 'Образы', exact: true }).locator('small')).toHaveText('0');
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
