import { readFileSync } from 'node:fs';
import { expect, test, type Locator, type Page } from '@playwright/test';

const sessionId = 'cbd55091-aaaa-bbbb-cccc-000000000001';
const sessionUrl = '/#/session/' + sessionId;
const layout = '.session-layout';
const panel = '.terminal-panel';
const stage = '.viewer-stage';
const device = '.device-screen';

function documentRect(locator: Locator) {
  return locator.evaluate(element => {
    const { x, y, width, height } = element.getBoundingClientRect();
    return { x: x + window.scrollX, y: y + window.scrollY, width, height };
  });
}

async function drag(page: Page, handle: Locator, dx: number, dy: number) {
  await handle.scrollIntoViewIfNeeded();
  const box = (await handle.boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps: 8 });
  await page.mouse.up();
}

async function openSession(page: Page) {
  await page.route('**/api/me/notifications', route => route.fulfill({ json: { notifications: [] } }));
  await page.goto(sessionUrl);
  await expect(page.locator('.session-media-badge[data-media=video]')).toHaveAttribute('data-state', 'live');
  await page.evaluate(() => document.fonts.ready);
}

test('bottom dock resizes independently of the live device and can be the default', async ({ page }) => {
  await page.setViewportSize({ width: 1500, height: 960 });
  await openSession(page);
  const workspace = page.locator(layout);
  const modes = workspace.locator('.workspace-mode-bar');
  const dock = modes.getByRole('button', { name: 'Док снизу', exact: true });
  const defaultView = modes.locator('.workspace-default-view');
  const tools = workspace.locator(panel);
  const viewerStage = workspace.locator(stage);
  const frame = workspace.locator(device);
  const canvas = frame.locator('canvas');
  const corner = viewerStage.locator('.device-resize-handle[data-corner=se]');
  const dockResize = workspace.locator('.dock-height-handle');

  await canvas.evaluate(element => { element.setAttribute('data-test-retained-canvas', 'true'); });
  await dock.click();
  await expect(workspace).toHaveAttribute('data-workspace-mode', 'dock');
  await expect(dock).toHaveAttribute('aria-pressed', 'true');
  await expect(defaultView).toHaveAttribute('aria-pressed', 'false');
  await expect(canvas).toHaveAttribute('data-test-retained-canvas', 'true');
  await expect(corner).toHaveRole('slider');
  await expect(viewerStage.locator('.device-resize-handle')).toHaveCount(4);
  await expect(dockResize).toHaveRole('separator');
  await expect(dockResize).toHaveAttribute('aria-orientation', 'horizontal');

  const gridBounds = await documentRect(workspace.locator('.workspace-grid'));
  const toolsBefore = await documentRect(tools);
  const stageBefore = await documentRect(viewerStage);
  const frameBefore = await documentRect(frame);
  expect(toolsBefore.width).toBeCloseTo(gridBounds.width, 0);
  expect(toolsBefore.x).toBeCloseTo(gridBounds.x, 0);
  expect(toolsBefore.y).toBeGreaterThan(stageBefore.y + stageBefore.height - 1);

  await drag(page, corner, -90, -90);
  await expect.poll(async () => (await documentRect(frame)).height).toBeLessThan(frameBefore.height - 20);
  const frameAfter = await documentRect(frame);
  expect(frameAfter.width / frameAfter.height).toBeCloseTo(frameBefore.width / frameBefore.height, 2);
  expect(await documentRect(viewerStage)).toEqual(stageBefore);
  expect(await documentRect(tools)).toEqual(toolsBefore);
  await expect(canvas).toHaveAttribute('data-test-retained-canvas', 'true');
  await corner.press('ArrowUp');
  await expect.poll(async () => (await documentRect(frame)).height).toBeGreaterThan(frameAfter.height);
  expect(await documentRect(tools)).toEqual(toolsBefore);

  for (const [name, dx, dy] of [['nw', 60, 60], ['ne', -60, 60], ['sw', 60, -60]] as const) {
    await corner.press('End');
    const fullHeight = (await documentRect(frame)).height;
    await drag(page, viewerStage.locator(`.device-resize-handle[data-corner=${name}]`), dx, dy);
    await expect.poll(async () => (await documentRect(frame)).height).toBeLessThan(fullHeight - 20);
    expect(await documentRect(tools)).toEqual(toolsBefore);
  }

  await drag(page, dockResize, 0, 64);
  await expect.poll(async () => Math.abs((await documentRect(tools)).height - toolsBefore.height - 64)).toBeLessThanOrEqual(1);
  const pointerHeight = (await documentRect(tools)).height;
  await dockResize.press('ArrowDown');
  await expect.poll(async () => (await documentRect(tools)).height).toBe(pointerHeight + 32);
  expect(await documentRect(viewerStage)).toEqual(stageBefore);
  await expect(canvas).toHaveAttribute('data-test-retained-canvas', 'true');
  await expect(workspace.locator('.session-media-badge[data-media=video]')).toHaveAttribute('data-state', 'live');

  await defaultView.click();
  await expect(defaultView).toHaveAttribute('aria-pressed', 'true');
  await modes.getByRole('button', { name: 'Экран', exact: true }).click();
  await expect(workspace).toHaveAttribute('data-workspace-mode', 'screen');
  await expect(defaultView).toHaveAttribute('aria-pressed', 'false');
  await expect(canvas).toHaveAttribute('data-test-retained-canvas', 'true');
  await page.reload();
  await expect(workspace).toHaveAttribute('data-workspace-mode', 'dock');
  await expect(defaultView).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(async () => (await documentRect(tools)).height).toBe(pointerHeight + 32);
});

test('the RTL phone-width dock keeps Logcat scrolling inside its own viewport', async ({ page }) => {
  const arabic = JSON.parse(readFileSync(new URL('../../shared/locales/ar.json', import.meta.url), 'utf8')) as Record<string, string>;
  const logEntries = Array.from({ length: 600 }, (_, index) => ({
    ts: '10-08 02:12:00.' + String(index).padStart(6, '0'), pid: 301, tid: 302,
    level: 'I', tag: 'DockTest', message: `Android log entry ${index}`,
  }));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => localStorage.setItem('rdf.language', 'ar'));
  await page.route('**/api/me/preferences*', route => route.fulfill({ json: {
    preferences: { theme: 'dark', fontFamily: 'system', fontScale: 1.25, defaultAdbKeyId: null },
  } }));
  await page.route('**/api/sessions/*/logcat?*', route => {
    const since = new URL(route.request().url()).searchParams.get('since');
    return route.fulfill({ json: {
      entries: since ? [] : logEntries, cursor: { since: logEntries.at(-1)!.ts, skip: logEntries.length },
    } });
  });
  await openSession(page);
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  const workspace = page.locator(layout);
  await workspace.getByRole('button', { name: arabic['session.workspace.dock'], exact: true }).click();
  await expect(workspace).toHaveAttribute('data-workspace-mode', 'dock');
  await expect(workspace.locator(device)).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);

  const logcatTab = workspace.locator('#tool-tab-logs');
  await logcatTab.click();
  await expect(logcatTab).toHaveAttribute('aria-selected', 'true');
  const logViewport = workspace.locator('.log-viewport');
  await expect(logViewport.locator('.log-row')).toHaveCount(logEntries.length);

  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  await expect(logcatTab).toBeInViewport();
  await expect(workspace.locator('.log-panel .log-head')).toBeInViewport();
  const logScrollSize = () => logViewport.evaluate(element => element.scrollHeight - element.clientHeight);
  expect(await logScrollSize()).toBeGreaterThan(200);
  await logViewport.hover();
  const pageOffset = await page.evaluate(() => window.scrollY);
  const logOffset = await logViewport.evaluate(element => element.scrollTop);
  await page.mouse.wheel(0, -200);
  await expect.poll(() => logViewport.evaluate(element => element.scrollTop)).toBeLessThan(logOffset);
  expect(await page.evaluate(() => window.scrollY)).toBe(pageOffset);
});
