import { expect, test, type Locator, type Page } from '@playwright/test';

const sessionId = 'cbd55091-aaaa-bbbb-cccc-000000000001';

async function size(locator: Locator, dimension: 'width' | 'height') {
  return locator.evaluate((element, key) => element.getBoundingClientRect()[key], dimension);
}

async function drag(page: Page, handle: Locator, dx: number, dy: number) {
  const box = await handle.boundingBox();
  expect(box).not.toBeNull();
  const x = box!.x + box!.width / 2;
  const y = box!.y + box!.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps: 8 });
  await page.mouse.up();
}

for (const viewport of [{ width: 1366, height: 768 }, { width: 1920, height: 1080 }]) {
  test(`desktop console supports drag, keyboard, saved sizes and reset at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    // The mock seeds an expiring-session toast over the bottom-right controls.
    await page.route('**/api/me/notifications', route => route.fulfill({ json: { notifications: [] } }));
    await page.goto('/#/session/' + sessionId);
    const widthHandle = page.getByRole('separator', { name: 'Изменить ширину консоли' });
    const heightHandle = page.getByRole('separator', { name: 'Изменить высоту консоли' });
    const reset = page.getByRole('button', { name: 'Сбросить размер консоли' });
    const panel = page.locator('.terminal-panel');
    const output = page.locator('.terminal-output');
    const input = page.getByRole('textbox', { name: 'Команда для выбранного устройства' });
    const phone = page.locator('.device-screen');
    await expect(widthHandle).toBeInViewport();
    await expect(heightHandle).toBeInViewport();
    await expect(input).toBeEnabled();
    await expect.poll(() => phone.evaluate(element => element.getBoundingClientRect().height)).toBeGreaterThan(250);
    await page.evaluate(() => document.fonts.ready);
    const initialWidth = await size(panel, 'width');
    const initialPhoneHeight = await size(phone, 'height');

    await drag(page, widthHandle, 64, 0);
    await expect.poll(() => size(panel, 'width')).toBeCloseTo(initialWidth - 64, 0);
    await widthHandle.press('ArrowLeft');
    await expect.poll(() => size(panel, 'width')).toBeCloseTo(initialWidth - 40, 0);
    await expect.poll(() => page.evaluate(() => Number(localStorage.getItem('rdf-console-width')))).toBeCloseTo(initialWidth - 40, 0);
    await expect(widthHandle).toHaveAttribute('aria-valuenow', String(Math.round(initialWidth - 40)));
    await expect(input).toBeInViewport();
    await page.reload();
    await expect(input).toBeEnabled();
    await expect.poll(() => size(panel, 'width')).toBeCloseTo(initialWidth - 40, 0);
    await reset.click();
    await expect.poll(() => size(panel, 'width')).toBeCloseTo(initialWidth, 0);
    await expect.poll(() => size(phone, 'height')).toBeCloseTo(initialPhoneHeight, 0);

    const initialHeight = await size(output, 'height');
    expect(initialHeight).toBeGreaterThan(210);
    await drag(page, heightHandle, 0, -48);
    const draggedHeight = Math.max(180, initialHeight - 48);
    await expect.poll(() => size(output, 'height')).toBeCloseTo(draggedHeight, 0);
    await expect.poll(() => size(phone, 'height')).toBeCloseTo(initialPhoneHeight, 0);
    await heightHandle.press('ArrowDown');
    const savedHeight = draggedHeight + 24;
    await expect.poll(() => size(output, 'height')).toBeCloseTo(savedHeight, 0);
    await expect.poll(() => page.evaluate(() => Number(localStorage.getItem('rdf-console-height')))).toBeCloseTo(savedHeight, 0);
    await expect(input).toBeInViewport();
    await page.reload();
    await expect(input).toBeEnabled();
    await expect.poll(() => size(output, 'height')).toBeCloseTo(savedHeight, 0);
    await expect(heightHandle).toHaveAttribute('aria-valuenow', String(Math.round(savedHeight)));

    await heightHandle.press('Home');
    await expect.poll(() => size(output, 'height')).toBeCloseTo(180, 0);
    await heightHandle.press('End');
    await expect.poll(() => size(output, 'height')).toBeGreaterThan(savedHeight);
    await expect(input).toBeInViewport();
    expect(await page.locator('.terminal-input').evaluate(element => element.getBoundingClientRect().bottom)).toBeLessThanOrEqual(viewport.height - 6);
    await reset.focus();
    await reset.press('Enter');
    await expect(reset).toBeDisabled();
    await expect.poll(() => size(output, 'height')).toBeCloseTo(initialHeight, 0);
    expect(await page.evaluate(() => [localStorage.getItem('rdf-console-width'), localStorage.getItem('rdf-console-height')])).toEqual([null, null]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
    await input.fill('getprop ro.product.model');
    await page.getByRole('button', { name: 'Выполнить команду', exact: true }).click();
    await expect(output).toContainText('Код выхода: 0');
  });
}


async function fittedWorkspace(page: Page) {
  return page.evaluate(() => {
    const rect = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
    const workspace = rect('.workspace-grid'), viewer = rect('.viewer-panel'), tools = rect('.terminal-panel');
    const stage = rect('.viewer-stage'), device = rect('.device-screen');
    const input = rect('.terminal-input'), controls = rect('.device-controls');
    const gap = Number.parseFloat(getComputedStyle(document.querySelector('.workspace-grid')!).columnGap);
    return {
      alignmentError: Math.max(
        Math.abs(viewer.left - workspace.left),
        Math.abs(tools.left - viewer.right - gap),
        Math.abs(viewer.top - tools.top),
        Math.abs(viewer.bottom - tools.bottom),
        Math.abs((device.left + device.right - stage.left - stage.right) / 2),
        Math.abs((device.top + device.bottom - stage.top - stage.bottom) / 2),
      ),
      bottom: Math.max(viewer.bottom, tools.bottom, device.bottom, input.bottom, controls.bottom),
      toolsWidth: tools.width,
      workspaceWidth: workspace.width,
      documentOverflow: document.documentElement.scrollWidth - innerWidth,
      verticalOverflow: document.documentElement.scrollHeight - innerHeight,
      rootFontSize: Number.parseFloat(getComputedStyle(document.documentElement).fontSize),
    };
  });
}

for (const [savedWidth, scale] of [[600, 1], [960, 1], [5000, 1], [960, 1.25]] as const) {
  test(`saved console width ${savedWidth} stays aligned and fitted at ${scale * 100}% text size`, async ({ page }) => {
    await page.setViewportSize({ width: 2240, height: 1324 });
    await page.addInitScript(width => {
      localStorage.setItem('rdf-console-width', String(width));
      localStorage.removeItem('rdf-console-height');
    }, savedWidth);
    await page.route('**/api/me/notifications', route => route.fulfill({ json: { notifications: [] } }));
    await page.route('**/api/me/preferences', route => route.fulfill({ json: { preferences: {
      theme: 'light', fontFamily: 'system', fontScale: scale, defaultAdbKeyId: null,
    } } }));
    const check = async (height: number) => {
      await expect(page.getByRole('textbox', { name: 'Команда для выбранного устройства' })).toBeEnabled();
      await page.evaluate(() => document.fonts.ready);
      await expect.poll(async () => (await fittedWorkspace(page)).rootFontSize).toBe(16 * scale);
      await expect.poll(async () => (await fittedWorkspace(page)).alignmentError).toBeLessThanOrEqual(1);
      await expect.poll(async () => (await fittedWorkspace(page)).bottom).toBeLessThanOrEqual(height - 16);
      const geometry = await fittedWorkspace(page);
      expect(geometry.documentOverflow).toBeLessThanOrEqual(1);
      expect(geometry.verticalOverflow).toBeLessThanOrEqual(1);
      expect(geometry.toolsWidth).toBeCloseTo(Math.min(savedWidth, geometry.workspaceWidth - 344), 0);
      expect(await page.evaluate(() => localStorage.getItem('rdf-console-width'))).toBe(String(savedWidth));
    };
    await page.goto('/#/session/' + sessionId);
    await check(1324);
    await page.screenshot({ path: `../.tmp-ui/session-layout/saved-${savedWidth}-scale-${scale}-2240.png`, fullPage: true });
    await page.reload();
    await check(1324);
    await page.setViewportSize({ width: 1366, height: 768 });
    await check(768);
    await page.screenshot({ path: `../.tmp-ui/session-layout/saved-${savedWidth}-scale-${scale}-1366.png`, fullPage: true });
  });
}
