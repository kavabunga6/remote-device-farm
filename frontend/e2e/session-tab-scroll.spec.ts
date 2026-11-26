import { expect, test, type Locator } from '@playwright/test';

const sessionId = 'cbd55091-aaaa-bbbb-cccc-000000000001';

// Include the actual scrollbar in screenshots from headless Chrome.
test.use({ launchOptions: { ignoreDefaultArgs: ['--hide-scrollbars'] } });

const clippedWidth = (tab: Locator) => tab.evaluate(element => {
  const tabBounds = element.getBoundingClientRect();
  const stripBounds = element.closest('[role=tablist]')!.getBoundingClientRect();
  return Math.max(0, stripBounds.left - tabBounds.left, tabBounds.right - stripBounds.right);
});

for (const { theme, language, direction, horizontal } of [
  { theme: 'light', language: 'ru', direction: 'ltr', horizontal: 1600 },
  { theme: 'dark', language: 'ar', direction: 'rtl', horizontal: -1600 },
] as const) {
  test(`narrow Desk tools scroll to the last tab in ${direction}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1366, height: 768 });
    await page.addInitScript(value => {
      const profile = encodeURIComponent('profile:a11-gpu');
      localStorage.setItem('rdf.language', value);
      localStorage.setItem('rdf-session-default-view:u1', 'desk');
      localStorage.setItem(`rdf-session-floating-v3:u1:${profile}:initial:base`, JSON.stringify({ front: 'tools', windows: {
        device: { left: 24, top: 112, width: 320, height: 500 },
        tools: { left: 420, top: 112, width: 540, height: 500 },
      } }));
    }, language);
    await page.route('**/api/me/preferences*', route => route.fulfill({ json: {
      preferences: { theme, fontFamily: 'system', fontScale: 1.25, defaultAdbKeyId: null },
    } }));
    await page.route('**/api/me/notifications', route => route.fulfill({ json: { notifications: [] } }));
    await page.goto('/#/session/' + sessionId);
    await expect(page.locator('html')).toHaveAttribute('data-effective-theme', theme);
    await expect(page.locator('html')).toHaveAttribute('dir', direction);
    const viewport = page.locator('.workspace-grid[data-desk]');
    await expect(viewport).toHaveAttribute('data-desk-zoom', '1');
    const tools = viewport.locator('[data-window=tools]');
    const strip = tools.getByRole('tablist');
    const first = strip.locator('#tool-tab-console');
    const last = strip.locator('#tool-tab-performance');
    const cameraOffset = () => viewport.evaluate(element => ({ left: element.scrollLeft, top: element.scrollTop }));
    await expect(first).toHaveAttribute('aria-selected', 'true');
    await page.evaluate(() => document.fonts.ready);
    await expect(strip).toHaveCSS('direction', direction);
    await expect(strip).toHaveCSS('scrollbar-width', 'thin');
    expect(await strip.evaluate(element => element.scrollWidth - element.clientWidth)).toBeGreaterThan(100);
    const toolbar = tools.locator('.session-tool-tabs-strip');
    const buttonCenters = await toolbar.evaluate(element => Array.from(element.querySelectorAll(
      'button.floating-window-move svg, #tool-tab-console, .floating-desk-default svg',
    )).map(control => {
      const { top, height } = control.getBoundingClientRect();
      return top + height / 2;
    }));
    expect(buttonCenters).toHaveLength(3);
    expect(Math.max(...buttonCenters) - Math.min(...buttonCenters)).toBeLessThanOrEqual(1);
    expect(await clippedWidth(last)).toBeGreaterThan(10);
    await strip.hover();
    const cameraStart = await cameraOffset();

    await page.mouse.wheel(0, 1600);
    await expect.poll(() => clippedWidth(last)).toBeLessThanOrEqual(1);
    expect(await cameraOffset()).toEqual(cameraStart);
    // A locator click could auto-scroll the hidden tab and accidentally hide the regression.
    const { x, y, width, height } = (await last.boundingBox())!;
    await page.mouse.click(x + width / 2, y + height / 2);
    await expect(last).toHaveAttribute('aria-selected', 'true');
    await expect(tools.locator('#tool-panel-performance')).toBeVisible();
    await toolbar.screenshot({ path: testInfo.outputPath(`tool-tabs-${theme}.png`) });

    await page.keyboard.press('Home');
    await expect(first).toBeFocused();
    await expect.poll(() => clippedWidth(first)).toBeLessThanOrEqual(1);
    await page.keyboard.press('End');
    await expect(last).toBeFocused();
    await expect.poll(() => clippedWidth(last)).toBeLessThanOrEqual(1);
    await page.keyboard.press('Home');

    const scrollbar = await strip.evaluate((element: HTMLElement) => {
      const { left, right, bottom } = element.getBoundingClientRect();
      const borderBottom = Number.parseFloat(getComputedStyle(element).borderBottomWidth);
      const height = element.offsetHeight - element.clientHeight - element.clientTop - borderBottom;
      return { left, right, y: bottom - borderBottom - height / 2, height };
    });
    if (scrollbar.height >= 3) {
      // Non-overlay scrollbars reserve space and expose a thumb that the mouse can drag.
      const start = direction === 'ltr' ? scrollbar.left + 30 : scrollbar.right - 30;
      const end = direction === 'ltr' ? scrollbar.right - 30 : scrollbar.left + 30;
      await page.mouse.move(start, scrollbar.y);
      await page.mouse.down();
      await page.mouse.move(end, scrollbar.y, { steps: 6 });
      await page.mouse.up();
      await expect.poll(() => clippedWidth(last)).toBeLessThanOrEqual(1);
      expect(await cameraOffset()).toEqual(cameraStart);
      await strip.evaluate(element => { element.scrollLeft = 0; });
    }
    await strip.hover();
    await page.mouse.wheel(horizontal, 0);
    await expect.poll(() => clippedWidth(last)).toBeLessThanOrEqual(1);
    expect(await cameraOffset()).toEqual(cameraStart);
    const tabScroll = await strip.evaluate(element => element.scrollLeft);
    await page.keyboard.down('Control');
    await page.mouse.wheel(0, -80);
    await page.keyboard.up('Control');
    await expect.poll(async () => Number(await viewport.getAttribute('data-desk-zoom'))).toBeGreaterThan(1);
    expect(await strip.evaluate(element => element.scrollLeft)).toBe(tabScroll);
  });
}
