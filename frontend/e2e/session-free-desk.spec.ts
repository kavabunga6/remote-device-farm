import { expect, test, type Locator, type Page } from '@playwright/test';

const sessionId = 'cbd55091-aaaa-bbbb-cccc-000000000001';
const sessionUrl = '/#/session/' + sessionId;
const viewport = { width: 1536, height: 900 };

function deskOn(page: Page) {
  const layout = page.locator('.session-layout');
  const canvas = layout.locator('.session-floating-canvas');
  return {
    layout,
    canvas,
    viewport: layout.locator('.workspace-grid[data-desk]'),
    device: canvas.locator('[data-window=device]'),
    tools: canvas.locator('[data-window=tools]'),
    logcat: canvas.locator('[data-window="widget:logs"]'),
  };
}

function logicalBounds(window: Locator) {
  return window.evaluate((element: HTMLElement) => ({
    left: Number.parseFloat(element.style.left),
    top: Number.parseFloat(element.style.top),
    width: Number.parseFloat(element.style.width),
    height: Number.parseFloat(element.style.height),
  }));
}

async function deskBounds(desk: ReturnType<typeof deskOn>) {
  const [device, tools, logcat] = await Promise.all([desk.device, desk.tools, desk.logcat].map(logicalBounds));
  return { device, tools, logcat };
}

function worldOrigin(canvas: Locator) {
  return canvas.evaluate(element => {
    const { left, top } = element.getBoundingClientRect();
    return { left, top };
  });
}

async function pan(page: Page, dx: number, dy: number) {
  await page.mouse.move(80, 100);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(80 + dx, 100 + dy, { steps: 8 });
  await page.mouse.up({ button: 'right' });
}

test('Desk pans past its initial area and keeps negative widget coordinates after reload', async ({ page }) => {
  await page.setViewportSize(viewport);
  await page.goto(sessionUrl);
  const desk = deskOn(page);
  await expect(desk.layout).toHaveAttribute('data-workspace-mode', 'split');
  await desk.layout.locator('.workspace-enter-desk').click();
  await expect(desk.layout).toHaveAttribute('data-workspace-mode', 'desk');
  await expect(desk.viewport).toHaveAttribute('data-desk-zoom', '1');

  await desk.tools.locator('#tool-tab-logs').press('Alt+Enter');
  const grip = desk.logcat.locator('button[data-window-move="widget:logs"]');
  await expect(grip).toBeFocused();
  const before = await deskBounds(desk);
  const origin = await worldOrigin(desk.canvas);
  await pan(page, 960, 550);
  await expect.poll(() => worldOrigin(desk.canvas)).toEqual({ left: origin.left + 960, top: origin.top + 550 });
  expect(await deskBounds(desk)).toEqual(before);

  await desk.layout.locator('.desk-zoom-reset').click();
  await desk.layout.locator('.desk-zoom-out').click();
  await desk.layout.locator('.desk-zoom-out').click();
  await expect(desk.viewport).toHaveAttribute('data-desk-zoom', '0.8');
  await pan(page, 340, 260);

  await expect(grip).toBeInViewport({ ratio: 0.99 });
  const { x, y, width, height } = (await grip.boundingBox())!;
  await page.mouse.move(x + width / 2, y + height / 2);
  await page.mouse.down();
  await expect(desk.viewport).toHaveAttribute('data-window-drag', 'move');
  await page.mouse.move(260, 190, { steps: 10 });
  await page.mouse.up();
  const after = await logicalBounds(desk.logcat);
  expect(after.left).toBeLessThan(-100);
  expect(after.top).toBeLessThan(-100);
  expect(after.width).toBe(before.logcat.width);
  expect(after.height).toBe(before.logcat.height);
  const movedGrip = (await grip.boundingBox())!;
  expect(Math.abs(movedGrip.x + movedGrip.width / 2 - 260)).toBeLessThanOrEqual(2);
  expect(Math.abs(movedGrip.y + movedGrip.height / 2 - 190)).toBeLessThanOrEqual(2);

  await page.reload();
  await expect(desk.layout).toHaveAttribute('data-workspace-mode', 'desk');
  await expect(desk.viewport).toBeVisible();
  await expect.poll(() => logicalBounds(desk.logcat)).toEqual(after);
  await desk.layout.getByRole('button', { name: 'Обзор окон', exact: true }).click();
  await page.getByRole('dialog', { name: 'Обзор окон' }).locator('[data-overview-window="widget:logs"]').click();
  await expect(grip).toBeFocused();
  await expect(grip).toBeInViewport({ ratio: 0.99 });
  expect(await logicalBounds(desk.logcat)).toEqual(after);
});

test('a saved Desk layout seeds new emulator sessions without sharing their changes', async ({ page }) => {
  await page.setViewportSize(viewport);
  await page.addInitScript(() => localStorage.setItem('rdf-session-default-view:u1', 'desk'));
  const nextIds = ['cbd55091-aaaa-bbbb-cccc-000000000002', 'cbd55091-aaaa-bbbb-cccc-000000000003'];
  for (const id of nextIds) {
    await page.route(`**/api/sessions/${id}`, async route => {
      const url = new URL(`/api/sessions/${sessionId}`, route.request().url());
      const response = await route.fetch({ url: url.href });
      const body = await response.json();
      await route.fulfill({ response, json: { session: { ...body.session, id, profileId: 'a13' } } });
    });
  }

  await page.goto(sessionUrl);
  const desk = deskOn(page);
  await expect(desk.layout).toHaveAttribute('data-workspace-mode', 'desk');
  const deviceGrip = desk.device.locator('button[data-window-move=device]');
  const logcatGrip = desk.logcat.locator('button[data-window-move="widget:logs"]');
  await expect(desk.viewport).toHaveAttribute('data-desk-zoom', '1');
  await desk.tools.locator('#tool-tab-logs').press('Alt+Enter');
  await expect(logcatGrip).toBeFocused();
  await deviceGrip.press('Shift+ArrowDown');
  const template = await deskBounds(desk);
  await desk.layout.getByRole('button', { name: 'Сохранить раскладку для новых эмуляторов', exact: true }).click();
  await expect(desk.layout.locator('.desk-save-status')).not.toBeEmpty();
  await expect(desk.layout.locator('.desk-save-status')).not.toHaveAttribute('data-error');

  await page.goto('/#/session/' + nextIds[0]);
  await expect(desk.viewport).toHaveAttribute('data-desk-zoom', '1');
  await expect.poll(() => deskBounds(desk)).toEqual(template);
  await logcatGrip.press('Shift+ArrowRight');
  await deviceGrip.press('Shift+ArrowDown');
  const customized = {
    ...template,
    device: { ...template.device, top: template.device.top + 32 },
    logcat: { ...template.logcat, left: template.logcat.left + 32 },
  };
  await expect.poll(() => deskBounds(desk)).toEqual(customized);
  await page.reload();
  await expect.poll(() => deskBounds(desk)).toEqual(customized);

  await page.goto('/#/session/' + nextIds[1]);
  await expect(desk.viewport).toHaveAttribute('data-desk-zoom', '1');
  await expect.poll(() => deskBounds(desk)).toEqual(template);
  await page.goto(sessionUrl);
  await expect.poll(() => deskBounds(desk)).toEqual(template);
});
