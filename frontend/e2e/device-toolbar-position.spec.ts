import { expect, test, type Locator, type Page } from '@playwright/test';

const sessionId = 'cbd55091-aaaa-bbbb-cccc-000000000001';
type Edge = 'top' | 'right' | 'bottom' | 'left';

test.use({ launchOptions: { ignoreDefaultArgs: ['--hide-scrollbars'] } });

async function openDevice(page: Page, theme: 'light' | 'dark', resolution?: string, language: 'en' | 'ar' = 'en') {
  await page.setViewportSize({ width: 1536, height: 900 });
  await page.addInitScript(({ sessionId, language }) => {
    localStorage.setItem('rdf.language', language);
    sessionStorage.setItem(`rdf-session-view:u1:${sessionId}`, 'screen');
    const NativeSocket = window.WebSocket;
    let mock = NativeSocket;
    let stream: WebSocket | undefined;
    const captureSocket = Object.assign(function (url: string | URL, protocols?: string | string[]) {
      const socket = new mock(url, protocols);
      if (/\/api\/sessions\/.+\/stream/.test(String(url))) stream = socket;
      return socket;
    }, { OPEN: 1, CONNECTING: 0, CLOSING: 2, CLOSED: 3 });
    Object.defineProperty(window, 'WebSocket', { configurable: true,
      get: () => mock === NativeSocket ? NativeSocket : captureSocket,
      set: (socket: typeof WebSocket) => { mock = socket; },
    });
    Object.assign(window, { sendToolbarFrame(width: number, height: number) {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d')!;
      context.fillStyle = '#23435d';
      context.fillRect(0, 0, width, height);
      const data = canvas.toDataURL('image/jpeg').split(',')[1];
      stream!.onmessage?.(new MessageEvent('message', { data: JSON.stringify({ type: 'frame', mime: 'image/jpeg', width, height, data }) }));
    } });
  }, { sessionId, language });
  if (resolution) {
    await page.route('**/api/profiles', async route => {
      const response = await route.fetch();
      const data = await response.json();
      await route.fulfill({ response, json: { profiles: data.profiles.map((profile: { id: string }) =>
        profile.id === 'a11-gpu' ? { ...profile, resolution } : profile) } });
    });
  }
  await page.route('**/api/me/preferences', route => route.fulfill({ json: { preferences: {
    theme, fontFamily: 'system', fontScale: 1.25, defaultAdbKeyId: null,
  } } }));
  await page.route('**/api/me/notifications', route => route.fulfill({ json: { notifications: [] } }));
  await page.goto('/#/session/' + sessionId);
  await expect(page.locator('html')).toHaveAttribute('data-effective-theme', theme);
  await expect(page.locator('html')).toHaveAttribute('dir', language === 'ar' ? 'rtl' : 'ltr');
  await expect(page.locator('.device-screen img.active-frame')).toHaveJSProperty('naturalWidth', 720);
  await page.evaluate(() => document.fonts.ready);
  return page.locator('section.viewer-panel');
}

async function sendFrame(page: Page, width: number, height: number) {
  await page.evaluate(({ width, height }) => {
    const target = window as Window & { sendToolbarFrame(width: number, height: number): void };
    target.sendToolbarFrame(width, height);
  }, { width, height });
  await expect(page.locator('.device-screen img.active-frame')).toHaveJSProperty('naturalWidth', width);
}

async function expectAligned(panel: Locator, edge: Edge) {
  await expect(panel).toHaveAttribute('data-controls-edge', edge);
  await expect.poll(() => panel.locator('.device-controls button.device-control:visible').count()).toBeGreaterThanOrEqual(10);
  await expect.poll(() => panel.evaluate((element, edge) => {
    const toolbar = element.querySelector('.device-controls')!;
    const rail = toolbar.getBoundingClientRect();
    const stage = element.querySelector('.viewer-stage')!.getBoundingClientRect();
    const horizontal = edge === 'top' || edge === 'bottom';
    const gap = {
      top: stage.top - rail.bottom, right: rail.left - stage.right,
      bottom: rail.top - stage.bottom, left: stage.left - rail.right,
    }[edge];
    const controls = [...toolbar.querySelectorAll('button.device-control')].filter(button => button.getClientRects().length);
    const spread = (values: number[]) => Math.max(...values) - Math.min(...values);
    const starts: number[] = [];
    const ends: number[] = [];
    const iconOffsets: [string, number][] = [];
    const sizeMismatches: [string, string][] = [];
    for (const control of controls) {
      const button = control.getBoundingClientRect();
      const label = control.getAttribute('aria-label') ?? '';
      const iconElement = control.querySelector('svg');
      const icon = iconElement?.getBoundingClientRect();
      const controlStyle = getComputedStyle(control);
      if (controlStyle.width !== '46px' || controlStyle.height !== '46px') {
        sizeMismatches.push([label, `button ${controlStyle.width} × ${controlStyle.height}`]);
      }
      if (iconElement) {
        const iconStyle = getComputedStyle(iconElement);
        if (iconStyle.width !== '23px' || iconStyle.height !== '23px') {
          sizeMismatches.push([label, `icon ${iconStyle.width} × ${iconStyle.height}`]);
        }
      }
      starts.push(horizontal ? button.top : button.left);
      ends.push(horizontal ? button.bottom : button.right);
      if (icon) iconOffsets.push([label, Math.max(
        Math.abs(button.left + button.width / 2 - icon.left - icon.width / 2),
        Math.abs(button.top + button.height / 2 - icon.top - icon.height / 2))]);
    }
    const edgeOffset = horizontal
      ? Math.max(Math.abs(rail.left - stage.left), Math.abs(rail.right - stage.right))
      : Math.max(Math.abs(rail.top - stage.top), Math.abs(rail.bottom - stage.bottom));
    const alignmentMismatches = [['toolbar gap', Math.abs(gap)], ['toolbar edge', edgeOffset], ['button starts', spread(starts)],
      ['button ends', spread(ends)], ...iconOffsets].filter(([, difference]) => Number(difference) > 1);
    return [...sizeMismatches, ...alignmentMismatches];
  }, edge)).toEqual([]);
}

test.afterEach(async ({ page }) => { await page.unrouteAll({ behavior: 'wait' }); });

test('a wide profile gets aligned top controls in RTL light theme, including at compact width', async ({ page }, info) => {
  const panel = await openDevice(page, 'light', '1280x800', 'ar');
  // The selected profile already supplies the orientation while the live frame is still portrait.
  await expectAligned(panel, 'top');
  await sendFrame(page, 1280, 800);
  await expectAligned(panel, 'top');
  await panel.screenshot({ path: info.outputPath('wide-light.png'), animations: 'disabled' });
  await page.setViewportSize({ width: 900, height: 700 });
  await expectAligned(panel, 'top');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(901);
  await panel.screenshot({ path: info.outputPath('compact-light.png'), animations: 'disabled' });
  const rail = panel.locator('.device-controls');
  const enabledControls = rail.locator('button.device-control:enabled');
  const firstControl = enabledControls.first();
  const lastControl = enabledControls.last();
  const clipping = (control: Locator) => control.evaluate(element => {
    const rail = element.closest('.device-controls')!.getBoundingClientRect();
    const button = element.getBoundingClientRect();
    return Math.max(rail.left - button.left, button.right - rail.right, 0);
  });
  expect(await clipping(firstControl)).toBeLessThanOrEqual(1);
  expect(await clipping(lastControl)).toBeGreaterThan(10);
  await rail.hover();
  await page.mouse.wheel(0, 500);
  await expect.poll(() => rail.evaluate(element => element.scrollLeft)).toBeLessThan(-10);
  await expect.poll(() => clipping(lastControl)).toBeLessThanOrEqual(1);
  expect(await clipping(firstControl)).toBeLessThanOrEqual(1);
  await panel.screenshot({ path: info.outputPath('compact-light-scrolled.png'), animations: 'disabled' });
  await rail.evaluate(element => { element.scrollLeft = 0; });
  await lastControl.focus();
  await expect(lastControl).toBeFocused();
  await expect.poll(() => clipping(lastControl)).toBeLessThanOrEqual(1);
  const trigger = panel.getByRole('button', { name: 'موضع شريط الأدوات' });
  const popup = panel.getByRole('dialog', { name: 'موضع شريط الأدوات' });
  for (const [label, edge] of [['على اليسار', 'left'], ['على اليمين', 'right']] as const) {
    await trigger.click();
    await popup.getByRole('button', { name: label, exact: true }).click();
    await expectAligned(panel, edge);
  }
  await page.setViewportSize({ width: 1536, height: 900 });
  await trigger.click();
  await popup.getByRole('button', { name: 'تلقائي', exact: true }).click();
  await page.locator('.workspace-enter-desk').click();
  await page.locator('.desk-zoom-out').click();
  const desk = page.locator('.workspace-grid[data-desk]');
  await expect(desk).toHaveAttribute('data-desk-zoom', '0.9');
  await expectAligned(panel, 'top');
  await trigger.click();
  await expect(popup).toBeInViewport({ ratio: .99 });
  await expect(popup.getByRole('button', { name: 'تلقائي', exact: true })).toBeFocused();
  await page.screenshot({ path: info.outputPath('desk-toolbar-popover-light.png'), animations: 'disabled' });
  await page.keyboard.press('Escape');
  await expect(popup).toBeHidden();
  await expect(desk).toBeVisible();
});

test('manual toolbar edges stay aligned and persist in dark theme until Automatic is selected', async ({ page }, info) => {
  const panel = await openDevice(page, 'dark');
  const trigger = panel.getByRole('button', { name: 'Toolbar position' });
  const popup = panel.getByRole('dialog', { name: 'Toolbar position' });
  const select = async (option: string) => {
    await trigger.click();
    await popup.getByRole('button', { name: option, exact: true }).click();
    await expect(popup).toBeHidden();
  };
  await expectAligned(panel, 'left');
  await sendFrame(page, 1280, 720);
  await expectAligned(panel, 'left');
  for (const [label, edge] of [['Top', 'top'], ['Left', 'left'], ['Bottom', 'bottom'], ['Right', 'right']] as const) {
    await select(label);
    await expectAligned(panel, edge);
  }
  await page.reload();
  await expectAligned(panel, 'right');
  await panel.screenshot({ path: info.outputPath('manual-right-dark.png'), animations: 'disabled' });
  await select('Automatic');
  await expectAligned(panel, 'left');
  await page.reload();
  await expectAligned(panel, 'left');
});
