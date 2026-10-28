import { expect, test, type Page } from '@playwright/test';
import path from 'node:path';

const sessionId = 'cbd55091-aaaa-bbbb-cccc-000000000001';

async function openSession(page: Page, theme: 'light' | 'dark', scale: number, language: 'ru' | 'en', filtered = false) {
  await page.addInitScript(value => localStorage.setItem('rdf.language', value), language);
  await page.route('**/api/**', route => ['GET', 'HEAD', 'OPTIONS'].includes(route.request().method())
    ? route.continue()
    : route.fulfill({ status: 503, json: { error: 'Isolated keyboard test' } }));
  await page.route('**/api/me/preferences*', route => route.fulfill({ json: {
    preferences: { theme, fontFamily: 'system', fontScale: scale, defaultAdbKeyId: null },
  } }));
  await page.route('**/api/me/notifications', route => route.fulfill({ json: { notifications: [] } }));
  if (filtered) await page.route('**/api/me', async route => {
    const response = await route.fetch();
    const data = await response.json();
    data.user.permissions = ['sessions.view', 'sessions.logcat', 'sessions.env'];
    await route.fulfill({ response, json: data });
  });
  await page.route('**/api/sessions/' + sessionId, async route => {
    const response = await route.fetch();
    const data = await response.json();
    data.session.idleExpiresAt = new Date(Date.now() + 3600000).toISOString();
    if (filtered) data.session.capabilities = ['shell', 'device-info', 'env', 'install'];
    await route.fulfill({ response, json: data });
  });
  await page.goto('/#/session/' + sessionId);
  await expect(page.getByRole('tablist')).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await expect(page.locator('html')).toHaveAttribute('data-effective-theme', theme);
}

for (const { width, height, theme, scale, language, labels } of [
  { width: 1366, height: 768, theme: 'light', scale: 1.25, language: 'ru', labels: { share: /^Поделиться/, close: 'Закрыть', ttl: 'Срок действия', split: 'Рядом' } },
  { width: 1920, height: 1080, theme: 'dark', scale: 1.5, language: 'en', labels: { share: /^Share/, close: 'Close', ttl: 'Link expires in', split: 'Side by side' } },
] as const) {
  test(`session tabs support keyboard navigation and linked panels in ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await openSession(page, theme, scale, language);
    const tabs = page.getByRole('tablist').getByRole('tab');
    await expect(tabs).toHaveCount(7);
    for (const tab of await tabs.all()) {
      const tabId = await tab.getAttribute('id');
      const panelId = await tab.getAttribute('aria-controls');
      expect(panelId).toBeTruthy();
      await expect(page.locator('#' + panelId)).toHaveAttribute('role', 'tabpanel');
      await expect(page.locator('#' + panelId)).toHaveAttribute('aria-labelledby', tabId!);
    }
    await expect(page.locator('.tool-tabs [tabindex="0"]')).toHaveCount(1);
    await expect(page.locator('.tool-tabs [tabindex="-1"]')).toHaveCount(6);
    await page.locator('#tool-tab-console').focus();
    for (const [key, id] of [['ArrowRight', 'logs'], ['End', 'webviews'], ['ArrowRight', 'console'], ['ArrowLeft', 'webviews'], ['Home', 'console']] as const) {
      await page.keyboard.press(key);
      await expect(page.locator('#tool-tab-' + id)).toBeFocused();
      await expect(page.locator('#tool-tab-' + id)).toHaveAttribute('aria-selected', 'true');
      await expect(page.locator('#tool-tab-' + id)).toHaveAttribute('tabindex', '0');
      await expect(page.getByRole('tabpanel')).toHaveCount(1);
      await expect(page.locator('#tool-panel-' + id)).toBeVisible();
    }
    await page.keyboard.press('Tab');
    await expect(page.getByRole('tab', { selected: true })).not.toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(page.locator('#tool-tab-console')).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
    if (process.env.UI_CAPTURE_DIR) await page.screenshot({ path: path.join(process.env.UI_CAPTURE_DIR, 'tabs-fixed-' + theme + '.png') });
  });

  test(`share returns focus on Escape and Close while outside pointer keeps its target in ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await openSession(page, theme, scale, language);
    const trigger = page.getByRole('button', { name: labels.share });
    const dialog = page.getByRole('dialog');
    await trigger.click();
    await expect(dialog.getByRole('button', { name: labels.close, exact: true })).toBeFocused();
    const ttl = dialog.locator('select');
    await ttl.focus();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();

    await trigger.click();
    await dialog.getByRole('button', { name: labels.close, exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();

    await trigger.click();
    await expect(dialog.getByRole('button', { name: labels.close, exact: true })).toBeFocused();
    await page.evaluate(() => {
      const trigger = document.querySelector<HTMLButtonElement>('.share-button')!;
      trigger.dataset.outsideFocuses = '0';
      trigger.addEventListener('focus', () => { trigger.dataset.outsideFocuses = String(Number(trigger.dataset.outsideFocuses) + 1); });
    });
    if (process.env.UI_CAPTURE_DIR) await page.screenshot({ path: path.join(process.env.UI_CAPTURE_DIR, 'share-fixed-' + theme + '.png') });
    const outside = page.locator('.workspace-mode-bar button').first();
    await outside.click();
    await expect(dialog).toHaveCount(0);
    await expect(outside).toBeFocused();
    await expect(trigger).toHaveAttribute('data-outside-focuses', '0');
  });
}

test('tab navigation skips tools without a capability or permission', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  await openSession(page, 'light', 1, 'ru', true);
  const tabs = page.getByRole('tablist').getByRole('tab');
  await expect(tabs).toHaveCount(2);
  await expect(page.locator('#tool-tab-info')).toHaveAttribute('aria-selected', 'true');
  await page.locator('#tool-tab-info').focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('#tool-tab-env')).toBeFocused();
  await expect(page.locator('#tool-tab-env')).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('#tool-tab-info')).toBeFocused();
  await expect(page.locator('#tool-tab-info')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tabpanel')).toHaveCount(1);
  await expect(page.locator('.tool-tabs [tabindex="0"]')).toHaveCount(1);
});