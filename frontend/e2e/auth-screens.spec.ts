import { expect, test } from '@playwright/test';
import { fileURLToPath } from 'node:url';

for (const language of ['ru', 'en'] as const) for (const theme of ['light', 'dark'] as const) {
  test(`sign-in form alignment ${language} ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.emulateMedia({ colorScheme: theme });
    await page.addInitScript(({ language, theme }) => {
      localStorage.setItem('rdf.language', language); localStorage.setItem('rdf.theme', theme);
    }, { language, theme });
    await page.route('**/api/me', route => route.fulfill({ json: { user: null } }));
    await page.goto('/');
    const languageControl = page.getByRole('button', { name: language === 'ru' ? 'Язык интерфейса: Русский' : 'Interface language: English' });
    await expect(languageControl).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('data-effective-theme', theme);
    await page.evaluate(() => document.fonts.ready);
    for (const scale of [1, 1.5]) {
      await page.evaluate(scale => document.documentElement.style.fontSize = `${16 * scale}px`, scale);
      const geometry = await page.locator('.login-card').evaluate(card => {
        const controls = [...card.querySelectorAll('.login-form input,.login-submit')].map(el => el.getBoundingClientRect());
        const brand = card.querySelector('.brand')!.getBoundingClientRect();
        const lang = card.querySelector('.language-trigger')!.getBoundingClientRect();
        return { lefts: controls.map(r => r.left), rights: controls.map(r => r.right), heights: controls.map(r => r.height), brandGap: lang.left - brand.right, centerGap: Math.abs((lang.top + lang.bottom - brand.top - brand.bottom) / 2), overflow: card.scrollWidth - card.clientWidth };
      });
      expect(Math.max(...geometry.lefts) - Math.min(...geometry.lefts)).toBeLessThanOrEqual(1);
      expect(Math.max(...geometry.rights) - Math.min(...geometry.rights)).toBeLessThanOrEqual(1);
      expect(Math.max(...geometry.heights) - Math.min(...geometry.heights)).toBeLessThanOrEqual(1);
      expect(geometry.brandGap).toBeGreaterThanOrEqual(12);
      expect(geometry.centerGap).toBeLessThanOrEqual(1);
      expect(geometry.overflow).toBeLessThanOrEqual(1);
    }
    await page.screenshot({ path: fileURLToPath(new URL(`../../.tmp-ui/public-readiness/login-${language}-${theme}.png`, import.meta.url)), fullPage: true });
  });
}

test('logout requires confirmation, cancellation restores focus and does not stop sessions', async ({ page }) => {
  let logouts = 0, stops = 0, signedOut = false;
  await page.route('**/api/me', async route => {
    if (signedOut) return route.fulfill({ json: { user: null } });
    await route.continue();
  });
  await page.route('**/api/logout', route => { logouts++; signedOut = true; return route.fulfill({ json: { ok: true } }); });
  await page.route('**/api/sessions/*', route => { if (route.request().method() === 'DELETE') stops++; return route.continue(); });
  await page.goto('/');
  const trigger = page.getByRole('button', { name: 'Выйти', exact: true });
  await trigger.click();
  const dialog = page.getByRole('alertdialog', { name: 'Выйти из аккаунта?' });
  await expect(dialog).toBeVisible(); expect(logouts).toBe(0);
  await expect(dialog.getByRole('button', { name: 'Отмена' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0); await expect(trigger).toBeFocused(); expect(logouts).toBe(0);
  await trigger.click(); await dialog.getByRole('button', { name: 'Отмена' }).click();
  expect(logouts).toBe(0);
  await trigger.click(); await dialog.getByRole('button', { name: 'Выйти', exact: true }).click();
  await expect(page.locator('.login-card')).toBeVisible(); expect(logouts).toBe(1); expect(stops).toBe(0);
});

test('failed logout keeps the account and supports retry, with a single in-flight request', async ({ page }) => {
  let attempts = 0;
  let finish: (() => void) | undefined;
  await page.route('**/api/logout', async route => {
    attempts++;
    if (attempts === 1) return route.fulfill({ status: 503, json: { error: { message: 'Service unavailable' } } });
    await new Promise<void>(resolve => { finish = resolve; });
    await route.fulfill({ json: { ok: true } });
  });
  await page.goto('/'); await page.getByRole('button', { name: 'Выйти', exact: true }).click();
  const dialog = page.getByRole('alertdialog');
  await dialog.getByRole('button', { name: 'Выйти', exact: true }).click();
  await expect(dialog.getByRole('alert')).toHaveText(/\S+/);
  await expect(page.locator('.sidebar')).toBeVisible();
  await dialog.getByRole('button', { name: 'Выйти', exact: true }).click();
  await expect(dialog).toHaveAttribute('aria-busy', 'true');
  await expect(dialog.getByRole('button', { name: 'Отмена' })).toBeDisabled();
  await page.keyboard.press('Escape'); await expect(dialog).toBeVisible();
  expect(attempts).toBe(2); finish!();
  await expect(page.locator('.login-card')).toBeVisible();
});

test('inventory refresh checks the current account and keeps retry available for an ordinary error', async ({ page }) => {
  let switched = false;
  let hostsUnavailable = true;
  const requestsAfterSwitch: string[] = [];
  page.on('request', request => {
    const path = new URL(request.url()).pathname;
    if (switched && /^\/api\/(hosts|profiles|sessions|admin\/profiles|navigation-counts)$/.test(path)) {
      requestsAfterSwitch.push(path);
    }
  });
  await page.route('**/api/me', route => switched
    ? route.fulfill({ json: { user: { id: 'another-account', username: 'another-user', role: 'admin' } } })
    : route.continue());
  await page.route('**/api/hosts', route => hostsUnavailable
    ? route.fulfill({ status: 503, json: { error: { message: 'Service unavailable' } } })
    : route.continue());

  await page.goto('/');
  const error = page.locator('main .banner-error');
  await expect(error).toBeVisible();
  await expect(page.locator('.sidebar')).toBeVisible();
  hostsUnavailable = false;
  const retry = page.waitForResponse(response => new URL(response.url()).pathname === '/api/hosts' && response.ok());
  await error.getByRole('button').click();
  await retry;
  await expect(error).toHaveCount(0);

  switched = true;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.locator('.login-card')).toBeVisible();
  await expect(page.locator('.sidebar')).toHaveCount(0);
  expect(requestsAfterSwitch).toHaveLength(0);
});

test('a replaced anonymous account opens a fresh guest view', async ({ page }) => {
  let guest = 'guest-one';
  await page.route('**/api/config', route => route.fulfill({ json: { authMode: 'none' } }));
  await page.route('**/api/me', route => route.fulfill({ json: { user: { id: guest, username: guest, role: 'user' } } }));
  await page.goto('/');
  const account = page.locator('.side-profile');
  await expect(account).toContainText('guest-one');
  guest = 'guest-two';
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(account).toContainText('guest-two');
});

test('session failure notifications use the current journal permission', async ({ page }) => {
  await page.clock.install();
  const sessionId = 'cbd55091-aaaa-bbbb-cccc-000000000001';
  const user = { id: 'u1', username: 'reviewer', role: 'user', roleName: 'Session reviewer' };
  let canReadLogs = false;
  let latestFailure: string | null = null;
  await page.route('**/api/me', route => route.fulfill({ json: { user: {
    ...user, permissions: canReadLogs ? ['sessions.view', 'logs.view'] : ['sessions.view'],
  } } }));
  await page.route('**/api/me/notifications', route => route.fulfill({ json: { notifications: latestFailure ? [{
    id: latestFailure, kind: 'session.failed', title: latestFailure, body: 'Session startup failed', sessionId,
    createdAt: new Date().toISOString(),
  }] : [] } }));
  await page.goto('/');
  await expect(page.locator('.side-profile')).toContainText(user.username);
  await expect(page.getByRole('link', { name: 'Журнал', exact: true })).toHaveCount(0);

  const failure = (title: string) => page.locator('.notification-toast').filter({ hasText: title });
  const journalAction = { name: 'Открыть лог сессии', exact: true };
  latestFailure = 'First startup failure';
  await page.clock.runFor(10000);
  await expect(failure(latestFailure)).toBeVisible();
  await expect(failure(latestFailure).getByRole('link', journalAction)).toHaveCount(0);

  canReadLogs = true;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByRole('link', { name: 'Журнал', exact: true })).toBeVisible();
  latestFailure = 'Second startup failure';
  await page.clock.runFor(10000);
  await expect(failure(latestFailure).getByRole('link', journalAction)).toBeVisible();
});

test('signing out clears current notifications and drops a late result from the signed-out account', async ({ page }) => {
  const sessionId = 'cbd55091-aaaa-bbbb-cccc-000000000001';
  const sessionPath = '/api/sessions/' + sessionId;
  const title = 'Previous account notification';
  let allowResult!: () => void;
  const waitForSignOut = new Promise<void>(resolve => { allowResult = resolve; });
  await page.route('**/api/me/notifications', route => route.fulfill({ json: { notifications: [{
    id: 'previous-account-notification', kind: 'session.failed', title, body: 'Previous session details', createdAt: new Date().toISOString(),
  }] } }));
  await page.route('**' + sessionPath, async route => {
    if (route.request().method() !== 'PATCH') return route.continue();
    await waitForSignOut;
    return route.fulfill({ status: 503, json: { error: { message: 'Previous account late result' } } });
  });
  await page.route('**/api/logout', route => route.fulfill({ json: { ok: true } }));
  await page.goto('/#/session/' + sessionId);
  await expect(page.locator('.notification-title').filter({ hasText: title })).toBeVisible();

  await page.getByRole('button', { name: 'Переименовать сессию' }).click();
  const pending = page.waitForRequest(request => request.url().endsWith(sessionPath) && request.method() === 'PATCH');
  await page.getByRole('textbox', { name: 'Название сессии', exact: true }).press('Enter');
  await pending;
  await page.getByRole('button', { name: 'Выйти', exact: true }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Выйти', exact: true }).click();
  await expect(page.locator('.login-card')).toBeVisible();
  await expect.soft(page.locator('.notification-toast')).toHaveCount(0);

  const response = page.waitForResponse(result => result.url().endsWith(sessionPath) && result.request().method() === 'PATCH');
  allowResult();
  await (await response).finished();
  await expect(page.locator('.notification-toast')).toHaveCount(0);
});

test('an action from the previous account cannot refresh the newly signed-in inventory', async ({ page }) => {
  const sessionId = 'cbd55091-aaaa-bbbb-cccc-000000000001';
  const sessionPath = '/api/sessions/' + sessionId;
  const next = { id: 'another-account', username: 'another-user', role: 'admin' };
  let signedIn = false;
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/me', route => signedIn ? route.fulfill({ json: { user: next } }) : route.continue());
  await page.route('**/api/login', route => { signedIn = true; return route.fulfill({ json: { user: next } }); });
  await page.route('**/api/logout', route => route.fulfill({ json: { ok: true } }));
  await page.route('**' + sessionPath, async route => {
    if (route.request().method() !== 'PATCH') return route.continue();
    await held;
    return route.fulfill({ json: { session: { id: sessionId, state: 'running', ownerId: 'u1' } } });
  });
  await page.goto('/#/session/' + sessionId);
  await page.getByRole('button', { name: 'Переименовать сессию' }).click();
  const pending = page.waitForRequest(request => request.url().endsWith(sessionPath) && request.method() === 'PATCH');
  await page.getByRole('textbox', { name: 'Название сессии', exact: true }).press('Enter');
  await pending;
  await page.getByRole('button', { name: 'Выйти', exact: true }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Выйти', exact: true }).click();

  await page.getByLabel('Логин', { exact: true }).fill(next.username);
  await page.getByLabel('Пароль', { exact: true }).fill('test-password');
  const freshInventory = page.waitForResponse(response => response.url().endsWith('/api/hosts') && response.ok());
  await page.locator('.login-submit').click();
  await freshInventory;
  const staleRefresh = page.waitForRequest(request => request.url().endsWith('/api/me'), { timeout: 1000 }).then(() => true, () => false);
  release();
  expect(await staleRefresh).toBe(false);
  await expect(page.locator('.side-profile')).toContainText(next.username);
});
