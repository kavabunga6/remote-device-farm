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
