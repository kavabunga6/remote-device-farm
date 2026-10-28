import { expect, test, type Page } from '@playwright/test';
import catalog from '../../shared/permissions.json' with { type: 'json' };
import messages from '../../shared/messages.json' with { type: 'json' };

const grants = catalog.groups.flatMap(group => group.actions.map(action => action.id));
const baseRoles = [
  { id: 'admin-role', name: 'Administrator', builtin: 'admin', permissions: grants, userCount: 1 },
  { id: 'user-role', name: 'User', builtin: 'user', permissions: catalog.user, userCount: 0 },
];
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function fixture(page: Page, { theme = 'light', scale = 1, language = 'en', permissions = grants } = {}) {
  const roles = structuredClone(baseRoles);
  await page.addInitScript(language => localStorage.setItem('rdf.language', language), language);
  await page.route('**/api/me', route => route.fulfill({ json: { user: { id: 'u1', username: 'admin', role: 'user', roleId: 'test-role', permissions } } }));
  await page.route('**/api/me/preferences', route => route.fulfill({ json: { preferences: { theme, fontScale: scale, fontFamily: 'system', defaultAdbKeyId: null } } }));
  await page.route('**/api/admin/roles', route => route.fulfill({ json: { roles } }));
  return roles;
}
const floating = (page: Page) => page.locator('.floating-form-save');
const nativeSave = (page: Page) => page.locator('.role-editor-actions button');
async function draft(page: Page) {
  await page.goto('/#/admin/roles');
  await expect(page.locator('.role-list button')).toHaveCount(2);
  await page.locator('#page-heading-actions button').click();
  await page.locator('.role-name input').fill('Observer');
  await expect(floating(page)).toBeVisible();
}

test('save appears on first change, follows native action and disappears on revert or navigation', async ({ page }) => {
  await fixture(page); await page.goto('/#/admin/roles');
  await expect(floating(page)).toHaveCount(0);
  await page.locator('.role-list button').nth(1).click();
  await expect(nativeSave(page)).toBeDisabled();
  const grant = page.getByRole('checkbox', { name: messages['permissions.sessions.stop'].en, exact: true });
  await grant.uncheck(); await expect(floating(page)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toHaveCount(1);
  await nativeSave(page).scrollIntoViewIfNeeded(); await expect(floating(page)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
  await grant.scrollIntoViewIfNeeded(); await expect(floating(page)).toBeVisible();
  await grant.check(); await expect(floating(page)).toHaveCount(0); await expect(nativeSave(page)).toBeDisabled();
  await grant.uncheck(); await expect(floating(page)).toBeVisible();
  await page.evaluate(() => { location.hash = '/admin/users'; });
  await expect(floating(page)).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => document.documentElement.style.getPropertyValue('--form-save-offset'))).toBe('0px');
});

test('floating save submits once, preserves failed changes and keeps retry clear of notifications', async ({ page }) => {
  const roles = await fixture(page), reply = deferred();
  let writes = 0, submitted: { name: string; permissions: string[] } | null = null;
  await page.route('**/api/admin/roles', async route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: { roles } });
    writes++; submitted = route.request().postDataJSON();
    if (writes === 1) { await reply.promise; return route.fulfill({ status: 503, json: { error: { message: 'Unavailable' } } }); }
    roles.push({ id: 'custom-role', builtin: null as never, userCount: 0, ...submitted! });
    return route.fulfill({ status: 201, json: { role: roles.at(-1) } });
  });
  try {
    await draft(page);
    await page.getByRole('checkbox', { name: 'Configure, sanitize devices and remove nodes', exact: true }).check();
    const action = floating(page).getByRole('button');
    await action.click(); await expect.poll(() => writes).toBe(1);
    await expect(action).toBeDisabled(); await expect(action).toHaveText('Saving…');
    await page.keyboard.press('Enter'); expect(writes).toBe(1); reply.resolve();
    await expect(action).toBeEnabled(); await expect(page.locator('.notification-error')).toBeVisible();
    const saveBounds = (await floating(page).boundingBox())!, toastBounds = (await page.locator('.notification-stack').boundingBox())!;
    expect(toastBounds.y + toastBounds.height).toBeLessThanOrEqual(saveBounds.y - 8);
    await expect(page.locator('.role-name input')).toHaveValue('Observer');
    expect(submitted).toEqual({ name: 'Observer', permissions: expect.arrayContaining(['nodes.manage', 'nodes.view']) });
    await action.click(); await expect(floating(page)).toHaveCount(0);
    await expect(page.locator('.role-editor-heading h3')).toHaveText('Observer');
    await expect(nativeSave(page)).toBeDisabled(); expect(writes).toBe(2);
  } finally { reply.resolve(); }
});

test('keyboard save returns focus to edited field without scrolling after success', async ({ page }) => {
  const roles = await fixture(page);
  await page.route('**/api/admin/roles', route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: { roles } });
    roles.push({ id: 'custom-role', builtin: null as never, userCount: 0, ...route.request().postDataJSON() });
    return route.fulfill({ status: 201, json: { role: roles.at(-1) } });
  });
  await draft(page);
  const field = page.locator('.role-name input'); await field.focus(); await floating(page).getByRole('button').focus();
  const scroll = await page.evaluate(() => window.scrollY); await page.keyboard.press('Enter');
  await expect(floating(page)).toHaveCount(0); await expect(field).toBeFocused();
  expect(await page.evaluate(() => window.scrollY)).toBe(scroll);
});

test('read-only roles and registration do not expose floating mutation controls', async ({ page }) => {
  await fixture(page, { permissions: ['roles.view', 'users.view', 'sessions.view'] });
  await page.goto('/#/admin/roles'); await page.locator('.role-list button').nth(1).click();
  await expect(page.locator('.permission-choice input').first()).toBeDisabled();
  await expect(nativeSave(page)).toHaveCount(0); await expect(floating(page)).toHaveCount(0);
  await page.goto('/#/admin/users'); await page.locator('.registration-settings summary').click();
  await expect(page.locator('.registration-settings select')).toBeDisabled();
  await expect(page.locator('.registration-settings button[type=submit]')).toHaveCount(0);
});

test('profile save accepts normalized response and hidden account sections release dock', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 280 }); await fixture(page, { scale: 1.5 });
  let profile = { id: 'u1', username: 'admin', displayName: 'Example', role: 'user', provider: 'local', firstName: 'Alex', lastName: '', company: '', jobTitle: '', managedByProvider: false }, writes = 0;
  await page.route('**/api/me/profile', route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: { profile } });
    writes++; const patch = route.request().postDataJSON(); profile = { ...profile, ...patch, firstName: patch.firstName.trim() };
    return route.fulfill({ json: { profile } });
  });
  await page.goto('/#/account/profile'); const firstName = page.locator('#account-profile-form input').first();
  await firstName.fill(' Alex updated '); await firstName.evaluate(input => input.scrollIntoView({ block: 'start' })); await expect(floating(page)).toBeVisible();
  await page.evaluate(() => { location.hash = '/account/appearance'; }); await expect(floating(page)).toHaveCount(0);
  await page.evaluate(() => { location.hash = '/account/profile'; }); await firstName.evaluate(input => input.scrollIntoView({ block: 'start' })); await expect(floating(page)).toBeVisible();
  await floating(page).getByRole('button').click(); await expect(floating(page)).toHaveCount(0);
  await expect(firstName).toHaveValue('Alex updated');
  await expect(page.locator('#account-profile-form button[type=submit]')).toBeDisabled(); expect(writes).toBe(1);
});

test('retention policy uses same floating save and preserves native input validation', async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 650 }); await fixture(page, { scale: 1.5 });
  let policy = { registryEnabled: true, registryKeep: 3, registryDays: 30, cacheEnabled: true, cacheDays: 30, cacheMaxGb: 0, intervalHours: 24 }, writes = 0;
  await page.route('**/api/admin/image-management/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/policy')) {
      if (route.request().method() === 'PUT') { writes++; policy = route.request().postDataJSON(); }
      return route.fulfill({ json: { policy } });
    }
    return route.fulfill({ json: { supported: true, repository: 'registry.example.test/emulator', items: [] } });
  });
  await page.goto('/#/admin/images'); await page.getByRole('button', { name: 'Retention policies', exact: true }).click();
  const keep = page.locator('.image-policy-field input').first();
  await keep.fill('0'); await page.evaluate(() => window.scrollTo(0, 0));
  await expect(floating(page)).toBeVisible(); await floating(page).getByRole('button').click();
  expect(writes).toBe(0); expect(await keep.evaluate(input => (input as HTMLInputElement).validity.rangeUnderflow)).toBe(true);
  await keep.fill('4'); await page.evaluate(() => window.scrollTo(0, 0));
  await floating(page).getByRole('button').click(); await expect(floating(page)).toHaveCount(0);
  expect(writes).toBe(1); expect(policy.registryKeep).toBe(4);
});

for (const [width, theme, scale, language] of [[1366, 'dark', 1, 'ru'], [1440, 'light', 1.5, 'en'], [1000, 'dark', 1.5, 'ar'], [390, 'light', 1.5, 'de']] as const) {
  test(`floating save fits ${width} ${theme} ${scale} ${language} without covering dialogs`, async ({ page }) => {
    await page.setViewportSize({ width, height: 850 }); await fixture(page, { theme, scale, language });
    await draft(page); await page.evaluate(() => document.fonts.ready);
    const panel = (await floating(page).boundingBox())!, action = (await floating(page).getByRole('button').boundingBox())!;
    expect(panel.x).toBeGreaterThanOrEqual(8); expect(panel.x + panel.width).toBeLessThanOrEqual(width - 8);
    if (width > 800) expect(panel.width).toBeLessThanOrEqual((await page.locator('.app-main').boundingBox())!.width - 31);
    expect(panel.y).toBeGreaterThanOrEqual(0); expect(panel.y + panel.height).toBeLessThanOrEqual(850);
    expect(action.height).toBeGreaterThanOrEqual(44); expect(action.x + action.width).toBeLessThanOrEqual(panel.x + panel.width - 8);
    await page.screenshot({ path: `../.tmp-ui/form-save/${width}-${theme}-${language}.png`, animations: 'disabled' });
    const overflow = await page.evaluate(() => Array.from(document.body.querySelectorAll('*')).flatMap(element => { const box = element.getBoundingClientRect(); return box.left < -1 || box.right > innerWidth + 1 ? [{ tag: element.tagName, className: element.className, left: box.left, right: box.right }] : []; }));
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), JSON.stringify(overflow.slice(0, 25))).toBe(true);
    await expect(page.locator('html')).toHaveAttribute('data-effective-theme', theme);
    if (language === 'ar') { await expect(page.locator('html')).toHaveAttribute('dir', 'rtl'); expect(panel.x).toBeLessThanOrEqual(24); }
    if (width < 800) await page.locator('.mobile-menu').click();
    await page.locator('.side-logout').click(); const dialog = page.getByRole('alertdialog'); await expect(dialog).toBeVisible();
    expect(await page.evaluate(({ x, y, width, height }) => Boolean(document.elementFromPoint(x + width / 2, y + height / 2)?.closest('.modal-backdrop')), panel)).toBe(true);
    await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0);
    if (width < 800) await page.locator('.mobile-close').click();
    await page.locator('.role-name input').scrollIntoViewIfNeeded(); await expect(floating(page)).toBeVisible();
  });
}
for (const theme of ['light', 'dark']) test(`registration settings belong to Users and stay aligned in ${theme}`, async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 900 }); await fixture(page, { theme, scale: 1.25, language: 'ru' });
  await page.goto('/#/admin/roles'); await expect(page.locator('.role-editor')).toBeVisible();
  await expect(page.locator('.registration-settings')).toHaveCount(0);
  await expect(page.locator('#page-heading-actions button')).toHaveText('Новая роль');
  await page.goto('/#/admin/users'); const settings = page.locator('.registration-settings');
  await settings.locator('summary').click(); await expect(settings.getByRole('combobox')).toBeVisible();
  await expect(settings.getByRole('button', { name: 'Сохранить', exact: true })).toBeDisabled();
  await page.evaluate(() => document.fonts.ready);
  const geometry = await settings.evaluate(element => {
    const toggle = element.querySelector('.registration-toggle')!.getBoundingClientRect(), role = element.querySelector('.registration-role')!.getBoundingClientRect(), input = element.querySelector('select')!.getBoundingClientRect();
    return { toggleLeft: toggle.left, roleLeft: role.left, toggleRight: toggle.right, roleRight: role.right, inputHeight: input.height, overflow: document.documentElement.scrollWidth > innerWidth };
  });
  expect(Math.abs(geometry.toggleLeft - geometry.roleLeft)).toBeLessThanOrEqual(1); expect(Math.abs(geometry.toggleRight - geometry.roleRight)).toBeLessThanOrEqual(1);
  expect(geometry.inputHeight).toBeGreaterThanOrEqual(44); expect(geometry.overflow).toBe(false);
  await page.screenshot({ path: `../.tmp-ui/form-save/registration-${theme}.png`, animations: 'disabled' });
});
