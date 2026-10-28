import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const source = JSON.parse(readFileSync(new URL('../../shared/messages.json', import.meta.url), 'utf8')) as Record<string, { ru: string; en: string }>;
const languages = JSON.parse(readFileSync(new URL('../../shared/languages.json', import.meta.url), 'utf8')) as Array<{ id: string; name: string; direction: string }>;
const copy = (language: string): Record<string, string> => language === 'ru' || language === 'en'
  ? Object.fromEntries(Object.entries(source).map(([key, value]) => [key, value[language]]))
  : JSON.parse(readFileSync(new URL('../../shared/locales/' + language + '.json', import.meta.url), 'utf8'));
const englishKey = (text: string) => Object.keys(source).find(key => source[key].en === text)!;

async function choose(page: Page, id: string) {
  await page.locator('.language-trigger').click();
  await page.getByRole('menuitemradio', { name: languages.find(language => language.id === id)!.name, exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('lang', id);
}
async function signedOut(page: Page) {
  await page.route('**/api/me', route => route.fulfill({ json: { user: null } }));
  await page.route('**/api/config', route => route.fulfill({ json: { authMethods: ['local'], registrationEnabled: true } }));
}
async function noHorizontalOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
}

for (const language of languages) for (const theme of ['light', 'dark'] as const) {
  test('sign-in layout: ' + language.id + ' / ' + theme, async ({ page }) => {
    const messages = copy(language.id), errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.emulateMedia({ colorScheme: theme });
    await page.addInitScript(id => localStorage.setItem('rdf.language', id), language.id);
    await signedOut(page); await page.goto('/');
    await expect(page.locator('html')).toHaveAttribute('lang', language.id);
    await expect(page.locator('html')).toHaveAttribute('dir', language.direction);
    await page.evaluate(() => { document.documentElement.style.fontSize = '20px'; });
    await expect(page.getByRole('heading', { name: messages['auth.signIn'], exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: messages['auth.register'], exact: true })).toBeVisible();
    const inputs = page.locator('.login-form input');
    const first = await inputs.nth(0).boundingBox(), second = await inputs.nth(1).boundingBox();
    expect(first && second).toBeTruthy();
    expect(Math.abs(first!.x - second!.x)).toBeLessThan(1);
    expect(Math.abs(first!.width - second!.width)).toBeLessThan(1);
    expect(Math.abs(first!.height - second!.height)).toBeLessThan(1);
    const brand = await page.locator('.login-brand-row .brand').boundingBox(), languageButton = await page.locator('.language-trigger').boundingBox();
    expect(brand && languageButton).toBeTruthy();
    expect(language.direction === 'rtl' ? languageButton!.x + languageButton!.width <= brand!.x : brand!.x + brand!.width <= languageButton!.x).toBe(true);
    await noHorizontalOverflow(page);
    await expect(page.locator('.brand-name')).toContainText('DeviceFarm');
    await page.locator('.language-trigger').click();
    await expect(page.getByRole('menuitemradio')).toHaveCount(12);
    await expect(page.getByRole('searchbox')).toBeFocused();
    const popover = await page.locator('.language-popover').boundingBox();
    expect(popover!.x).toBeGreaterThanOrEqual(0);
    expect(popover!.x + popover!.width).toBeLessThanOrEqual(1441);
    await page.keyboard.press('Escape');
    await page.screenshot({ path: fileURLToPath(new URL('../../.tmp-ui/language-' + language.id + '-' + theme + '.png', import.meta.url)), fullPage: true });
    expect(errors).toEqual([]);
  });
}

test('language search, keyboard navigation and persistence preserve entered credentials', async ({ page }) => {
  await signedOut(page); await page.goto('/');
  await page.locator('.login-form input').nth(0).fill('example-user');
  await page.locator('.login-form input').nth(1).fill('example-password');
  await page.locator('.language-trigger').click();
  await page.getByRole('searchbox').fill('francais');
  await expect(page.getByRole('menuitemradio')).toHaveCount(1);
  await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter');
  await expect(page.locator('html')).toHaveAttribute('lang', 'fr');
  await expect(page.locator('.login-form input').nth(0)).toHaveValue('example-user');
  await expect(page.locator('.login-form input').nth(1)).toHaveValue('example-password');
  await expect(page.locator('.language-trigger')).toBeFocused();
  await page.reload(); await expect(page.locator('html')).toHaveAttribute('lang', 'fr');
  await page.locator('.language-trigger').click();
  await page.getByRole('searchbox').fill('中文');
  await expect(page.getByRole('menuitemradio', { name: '简体中文' })).toBeVisible();
  await page.getByRole('searchbox').fill('no-such-language');
  await expect(page.getByRole('status')).toHaveText(copy('fr')['language.noResults']);
});

test('a failed dictionary download keeps the current language and can be retried', async ({ page }) => {
  let attempts = 0;
  await signedOut(page);
  await page.route(/\/shared\/locales\/fr\.json/, route => {
    attempts++;
    return attempts === 1 ? route.abort('failed') : route.continue();
  });
  await page.goto('/');
  await page.locator('.language-trigger').click();
  await page.getByRole('menuitemradio', { name: 'Français', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText(copy('ru')['language.loadFailed']);
  await expect(page.locator('html')).toHaveAttribute('lang', 'ru');
  await expect(page.getByRole('menuitemradio', { name: 'Français', exact: true })).toBeEnabled();
  await page.getByRole('menuitemradio', { name: 'Français', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'fr');
  expect(attempts).toBe(2);
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('an unavailable saved language leaves the login form usable', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('rdf.language', 'de'));
  await page.route(/\/shared\/locales\/de\.json/, route => route.fulfill({ status: 503, body: '' }));
  await signedOut(page); await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Вход', exact: true })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveText(copy('ru')['language.loadFailed']);
  await choose(page, 'en'); await expect(page.getByRole('alert')).toHaveCount(0);
});

for (const id of ['en', 'ar', 'de', 'zh-Hans']) {
  test('administration and catalog layout: ' + id, async ({ page }) => {
    const messages = copy(id);
    await page.setViewportSize({ width: 1600, height: 1100 });
    await page.addInitScript(language => localStorage.setItem('rdf.language', language), id);
    await page.route('**/api/me/preferences', route => route.fulfill({ json: { preferences: { theme: 'dark', fontScale: 1.25, fontFamily: 'system', defaultAdbKeyId: null } } }));
    for (const [route, heading] of [['nodes', 'Nodes'], ['profiles', 'Device profiles'], ['users', 'Users'], ['journal', 'Journal']]) {
      await page.goto('/#/admin/' + route);
      await expect(page.getByRole('heading', { name: messages[englishKey(heading)], level: 1, exact: true })).toBeVisible();
      await noHorizontalOverflow(page);
    }
    await page.goto('/#/admin/profiles');
    await page.getByRole('button', { name: messages[englishKey('Image catalog')], exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: messages[englishKey('Google image catalog')], exact: true })).toBeVisible();
    await expect(dialog.locator('.emulator-catalog-filters')).toBeVisible();
    expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    await page.screenshot({ path: fileURLToPath(new URL('../../.tmp-ui/catalog-language-' + id + '.png', import.meta.url)), fullPage: true });
  });
}

test('cross-tab language changes preserve the running device and physical screen direction', async ({ page, context }) => {
  let stopped = 0;
  await page.route('**/api/sessions/*', async route => { if (route.request().method() === 'DELETE') stopped++; await route.continue(); });
  await page.goto('/');
  await page.locator('.session-card').first().getByRole('link', { name: /Открыть сессию:/ }).click();
  await expect(page.locator('.touch-layer')).toBeVisible();
  const url = page.url();
  const settings = await context.newPage(); await settings.goto('/#/account/appearance');
  await expect(settings.locator('.sidebar .language-control')).toHaveCount(0);
  for (const id of ['ar', 'en']) {
    await choose(settings, id);
    await expect(page.locator('html')).toHaveAttribute('lang', id);
    await expect(page.getByRole('tab', { name: copy(id)[englishKey('Environment')], exact: true })).toBeVisible();
    expect(await page.locator('.touch-layer').evaluate(element => getComputedStyle(element).direction)).toBe('ltr');
    expect(await page.locator('.tool-panel').evaluate(element => getComputedStyle(element).direction)).toBe(id === 'ar' ? 'rtl' : 'ltr');
    expect(page.url()).toBe(url); expect(stopped).toBe(0);
  }
  await page.reload(); await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await settings.close();
});

test('persisted server notices change language with the interface', async ({ page }) => {
  await page.clock.install();
  await page.addInitScript(() => localStorage.setItem('rdf.language', 'en'));
  await page.route('**/api/me/notifications', route => route.fulfill({ json: { notifications: [{
    id: 'i18n-failure', sessionId: 'language-session', kind: 'session.failed',
    title: 'Не удалось запустить устройство',
    body: 'Эмулятор завершился до загрузки Android. Проверьте образ и параметры запуска.',
    createdAt: new Date().toISOString(),
  }] } }));
  await page.route('**/api/me/notifications/read', route => route.fulfill({ json: { marked: 1 } }));
  await page.goto('/#/overview');
  const toast = page.locator('.notification-error');
  await expect(toast.locator('.notification-title')).toHaveText('Could not start device');
  await page.evaluate(() => { window.location.hash = '/account/appearance'; });
  await choose(page, 'ru');
  await expect(toast.locator('.notification-title')).toHaveText('Не удалось запустить устройство');
  await expect(toast.locator('.notification-message')).toHaveText('Сессия #language. Эмулятор завершился до загрузки Android. Проверьте образ и параметры запуска.');
});
