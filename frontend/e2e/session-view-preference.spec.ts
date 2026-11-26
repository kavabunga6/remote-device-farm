import { expect, test } from '@playwright/test';

const sessionId = 'cbd55091-aaaa-bbbb-cccc-000000000001';
const sessionUrl = '/#/session/' + sessionId;
const desktop = { width: 1680, height: 940 };

test('selected workspace views survive reload in the same tab', async ({ page, context }) => {
  await page.setViewportSize(desktop);
  await page.goto(sessionUrl);
  const layout = page.locator('.session-layout');
  await expect(layout).toHaveAttribute('data-workspace-mode', 'split');

  for (const mode of ['screen', 'tools', 'split']) {
    await layout.locator(`[data-workspace-choice=${mode}]`).click();
    await page.reload();
    await expect(layout.locator('.workspace-grid')).toBeVisible();
    await expect(layout).toHaveAttribute('data-workspace-mode', mode);
  }

  await layout.locator('.workspace-enter-desk').click();
  await expect(layout).toHaveAttribute('data-workspace-mode', 'desk');
  await page.reload();
  await expect(layout.locator('.workspace-grid[data-desk]')).toBeVisible();
  await expect(layout).toHaveAttribute('data-workspace-mode', 'desk');

  const otherTab = await context.newPage();
  try {
    await otherTab.setViewportSize(desktop);
    await otherTab.goto(sessionUrl);
    await expect(otherTab.locator('.session-layout .workspace-grid')).toBeVisible();
    await expect(otherTab.locator('.session-layout')).toHaveAttribute('data-workspace-mode', 'split');
  } finally {
    await otherTab.close();
  }

  await page.keyboard.press('Escape');
  await expect(layout.locator('.workspace-enter-desk')).toBeVisible();
  await page.reload();
  await expect(layout.locator('.workspace-enter-desk')).toBeVisible();
  await expect(layout).toHaveAttribute('data-workspace-mode', 'split');
});

test('Desk camera zoom and pan survive exit, reentry and reload until reset', async ({ page }) => {
  await page.setViewportSize(desktop);
  await page.addInitScript(() => {
    localStorage.setItem('rdf-session-floating-v3:u1:profile%3Aa11-gpu:initial:base', JSON.stringify({
      front: 'tools',
      windows: {
        device: { left: 60, top: 80, width: 320, height: 510 },
        tools: { left: 500, top: 140, width: 530, height: 370 },
      },
    }));
  });
  await page.goto(sessionUrl);
  const layout = page.locator('.session-layout');
  const desk = layout.locator('.workspace-grid[data-desk]');
  const canvas = desk.locator('.session-floating-canvas');
  const viewOrigin = () => canvas.evaluate(element => {
    const { left, top } = element.getBoundingClientRect();
    return { x: Math.round(left), y: Math.round(top) };
  });

  await layout.locator('.workspace-enter-desk').click();
  await expect(desk).toHaveAttribute('data-desk-zoom', '1');
  const initialOrigin = await viewOrigin();

  const zoomIn = layout.locator('.desk-zoom-in');
  await zoomIn.click();
  await zoomIn.click();
  await expect(desk).toHaveAttribute('data-desk-zoom', '1.2');
  const zoomedOrigin = await viewOrigin();

  await page.mouse.move(1260, 620);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(1502, 773, { steps: 4 });
  await page.mouse.up({ button: 'right' });
  const pannedOrigin = { x: zoomedOrigin.x + 242, y: zoomedOrigin.y + 153 };
  await expect.poll(viewOrigin).toEqual(pannedOrigin);

  await layout.locator('.desk-command-exit').click();
  await expect(layout).toHaveAttribute('data-workspace-mode', 'split');
  await layout.locator('.workspace-enter-desk').click();
  await expect(desk).toHaveAttribute('data-desk-zoom', '1.2');
  await expect.poll(viewOrigin).toEqual(pannedOrigin);

  await page.reload();
  await expect(desk).toHaveAttribute('data-desk-zoom', '1.2');
  await expect.poll(viewOrigin).toEqual(pannedOrigin);

  await layout.getByRole('button', { name: 'Обзор окон', exact: true }).click();
  await page.getByRole('dialog', { name: 'Обзор окон' }).locator('[data-overview-window=tools]').click();
  await expect.poll(viewOrigin).not.toEqual(pannedOrigin);
  const toolsOrigin = await viewOrigin();
  await page.goto('/#/overview');
  await expect(desk).toHaveCount(0);
  await page.goBack();
  await expect(desk).toHaveAttribute('data-desk-zoom', '1.2');
  await expect.poll(viewOrigin).toEqual(toolsOrigin);

  await layout.locator('.desk-zoom-reset').click();
  await expect(desk).toHaveAttribute('data-desk-zoom', '1');
  await expect.poll(viewOrigin).toEqual(initialOrigin);

  await page.reload();
  await expect(desk).toHaveAttribute('data-desk-zoom', '1');
  await expect.poll(viewOrigin).toEqual(initialOrigin);
});

test('Side by Side keeps both panels accessible at compact and desktop widths', async ({ page }) => {
  await page.setViewportSize({ width: 1030, height: 900 });
  await page.goto(sessionUrl);
  const layout = page.locator('.session-layout');
  const grid = layout.locator('.workspace-grid');
  const separation = () => grid.evaluate(element => {
    const viewer = element.querySelector('.viewer-panel')!.getBoundingClientRect();
    const tools = element.querySelector('.terminal-panel')!.getBoundingClientRect();
    return { across: tools.left - viewer.right, down: tools.top - viewer.bottom };
  });

  await page.reload();
  await expect(layout).toHaveAttribute('data-workspace-mode', 'split');
  await expect(grid.locator('.viewer-panel')).toBeVisible();
  await expect(grid.locator('.terminal-panel')).toBeVisible();
  await expect.poll(async () => (await separation()).down).toBeGreaterThanOrEqual(0);
  await page.setViewportSize(desktop);
  await expect(layout).toHaveAttribute('data-workspace-mode', 'split');
  await expect.poll(async () => (await separation()).across).toBeGreaterThanOrEqual(0);
});

test('an old floating view opens Side by Side', async ({ page, context }) => {
  await page.setViewportSize(desktop);
  await page.addInitScript(id => {
    localStorage.setItem('rdf-session-default-view:u1', 'float');
    sessionStorage.setItem(`rdf-session-view:u1:${id}`, 'float');
  }, sessionId);
  await page.goto(sessionUrl);
  await expect(page.locator('.session-layout')).toHaveAttribute('data-workspace-mode', 'split');

  const otherTab = await context.newPage();
  try {
    await otherTab.setViewportSize(desktop);
    await otherTab.goto(sessionUrl);
    await expect(otherTab.locator('.session-layout')).toHaveAttribute('data-workspace-mode', 'split');
  } finally {
    await otherTab.close();
  }
});

test('shared access ignores the saved owner view', async ({ page }) => {
  await page.setViewportSize(desktop);
  await page.goto(sessionUrl);
  const layout = page.locator('.session-layout');
  const desk = layout.locator('.workspace-grid[data-desk]');
  await layout.locator('.workspace-enter-desk').click();
  await expect(desk).toBeVisible();

  const sessionApi = '**/api/sessions/' + sessionId;
  await page.route(sessionApi, async route => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({ response, json: { session: { ...body.session, access: 'view' } } });
  });
  await page.reload();
  await expect(layout).toHaveAttribute('data-shared', 'view');
  await expect(layout).toHaveAttribute('data-workspace-mode', 'split');
  await expect(desk).toHaveCount(0);

  await page.unroute(sessionApi);
  await page.reload();
  await expect(desk).toBeVisible();
});
