import { readFileSync } from 'node:fs';
import { expect, test, type Locator, type Page } from '@playwright/test';

const sessionUrl = '/#/session/cbd55091-aaaa-bbbb-cccc-000000000001';
type WindowKind = 'device' | 'tools';
type Label = (russian: string) => string;
const russian: Label = text => text;

function workspace(page: Page, label: Label = russian) {
  const layout = page.locator('.session-layout');
  const canvas = layout.locator('.session-floating-canvas');
  const button = (name: string) => layout.getByRole('button', { name: label(name), exact: true });
  return {
    layout, canvas, button,
    viewport: layout.locator('.workspace-grid'),
    window: (kind: WindowKind) => canvas.locator(`[data-window=${kind}]`),
    move: (kind: WindowKind) => canvas.locator(`button[data-window-move=${kind}]`),
    resize: (kind: WindowKind) => canvas.locator(`[data-window-resize=${kind}][data-direction=se]`),
    sizeButton: (kind: WindowKind) => canvas.locator(`[data-size-window=${kind}]`),
    media: layout.locator('.device-screen canvas'),
    command: layout.locator('.terminal-input input'),
  };
}

async function openSession(page: Page, label: Label = russian) {
  await page.route('**/api/me/notifications', route => route.fulfill({ json: { notifications: [] } }));
  await page.goto(sessionUrl);
  const view = workspace(page, label);
  await expect(view.layout.locator('.session-media-badge[data-media=video]')).toHaveAttribute('data-state', 'live');
  await page.evaluate(() => document.fonts.ready);
  return view;
}

function bounds(window: Locator) {
  return window.evaluate(element => {
    const frame = element.getBoundingClientRect();
    const canvas = element.closest('.session-floating-canvas')!.getBoundingClientRect();
    return { x: frame.x - canvas.x, y: frame.y - canvas.y, width: frame.width, height: frame.height };
  });
}

function scrollOffset(viewport: Locator) {
  return viewport.evaluate(element => ({ x: element.scrollLeft, y: element.scrollTop }));
}

function stackPosition(window: Locator) {
  return window.evaluate(element => Number.parseInt(getComputedStyle(element).zIndex, 10) || 0);
}

async function drag(page: Page, handle: Locator, dx: number, dy: number) {
  await handle.scrollIntoViewIfNeeded();
  const { x, y, width, height } = (await handle.boundingBox())!;
  const startX = x + width / 2;
  const startY = y + height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + dx, startY + dy, { steps: 8 });
  await page.mouse.up();
}

async function useSize(page: Page, view: ReturnType<typeof workspace>, kind: WindowKind, width: number, height: number, label: Label = russian) {
  await view.sizeButton(kind).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel(label('Ширина, px')).fill(String(width));
  await dialog.getByLabel(label('Высота, px')).fill(String(height));
  await dialog.getByRole('button', { name: label('Применить'), exact: true }).click();
  await expect(dialog).toBeHidden();
}

test('floating device and tools move and resize independently with persistent geometry', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 940 });
  const view = await openSession(page);
  await view.media.evaluate(element => { element.setAttribute('data-test-retained-canvas', 'true'); });
  await view.button('Поверх кадра').click();
  await expect(view.layout).toHaveAttribute('data-workspace-mode', 'float');
  await expect(view.media).toHaveAttribute('data-test-retained-canvas', 'true');
  const device = view.window('device');
  const tools = view.window('tools');
  const initialDevice = await bounds(device);
  const initialTools = await bounds(tools);

  await view.button('К эмулятору').click();
  await expect.poll(async () => (await stackPosition(device)) - (await stackPosition(tools))).toBeGreaterThan(0);
  await drag(page, view.move('device'), 66, 46);
  await expect.poll(async () => (await bounds(device)).x - initialDevice.x).toBeGreaterThan(40);
  const movedDevice = await bounds(device);
  expect(movedDevice.y - initialDevice.y).toBeGreaterThan(30);
  expect(movedDevice.width).toBe(initialDevice.width);
  expect(movedDevice.height).toBe(initialDevice.height);
  expect(await bounds(tools)).toEqual(initialTools);

  const corner = view.resize('device');
  await expect(view.canvas.locator('[data-window-resize=device]')).toHaveCount(4);
  await expect(view.canvas.locator('[data-window-resize=tools]')).toHaveCount(4);
  await drag(page, corner, -72, -72);
  await expect.poll(async () => movedDevice.width - (await bounds(device)).width).toBeGreaterThan(40);
  const resizedDevice = await bounds(device);
  expect(resizedDevice.x).toBe(movedDevice.x);
  expect(resizedDevice.y).toBe(movedDevice.y);
  expect(resizedDevice.height).toBeLessThan(movedDevice.height - 40);
  expect(await bounds(tools)).toEqual(initialTools);
  await expect(view.media).toHaveAttribute('data-test-retained-canvas', 'true');

  await view.button('К инструментам').click();
  await expect.poll(async () => (await stackPosition(tools)) - (await stackPosition(device))).toBeGreaterThan(0);
  await useSize(page, view, 'tools', 620, 540);
  await expect.poll(async () => (await bounds(tools)).width).toBeCloseTo(620, 0);
  await expect.poll(async () => (await bounds(tools)).height).toBeCloseTo(540, 0);
  expect(await bounds(device)).toEqual(resizedDevice);
  const sizedTools = await bounds(tools);

  await view.button('Экран').click();
  await expect(view.layout).toHaveAttribute('data-workspace-mode', 'screen');
  await expect(view.media).toHaveAttribute('data-test-retained-canvas', 'true');
  await view.button('Поверх кадра').click();
  await expect.poll(() => bounds(device)).toEqual(resizedDevice);
  await expect.poll(() => bounds(tools)).toEqual(sizedTools);
  const defaultView = view.layout.locator('.workspace-default-view');
  await defaultView.click();
  await expect(defaultView).toHaveAttribute('aria-pressed', 'true');
  await page.reload();
  await expect(view.layout).toHaveAttribute('data-workspace-mode', 'float');
  await expect.poll(() => bounds(device)).toEqual(resizedDevice);
  await expect.poll(() => bounds(tools)).toEqual(sizedTools);
  await view.button('Сбросить раскладку').click();
  await expect.poll(() => bounds(device)).toEqual(initialDevice);
  await expect.poll(() => bounds(tools)).toEqual(initialTools);
});

test('oversized floating tools keep page overflow, Logcat scrolling and command focus separate in RTL', async ({ page }) => {
  const localize = (path: string) => JSON.parse(readFileSync(new URL('../../shared/' + path, import.meta.url), 'utf8'));
  const messages = localize('messages.json') as Record<string, { ru: string; en: string }>;
  const arabic = localize('locales/ar.json') as Record<string, string>;
  const label: Label = text => {
    const entry = Object.entries(messages).find(([, message]) => message.ru === text);
    if (!entry || !arabic[entry[0]]) throw new Error('Missing Arabic copy for ' + text);
    return arabic[entry[0]];
  };
  const logEntries = Array.from({ length: 600 }, (_, index) => ({
    ts: '10-08 02:12:00.' + String(index).padStart(6, '0'), pid: 301, tid: 302,
    level: 'I', tag: 'WorkspaceTest', message: `Android log entry ${index}`,
  }));
  await page.setViewportSize({ width: 1536, height: 740 });
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
  const view = await openSession(page, label);
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await view.button('Поверх кадра').click();
  await expect(view.layout).toHaveAttribute('data-workspace-mode', 'float');
  await view.button('К инструментам').click();
  await useSize(page, view, 'tools', 1800, 1100, label);

  const overflow = await view.viewport.evaluate(element => ({
    x: element.scrollWidth - element.clientWidth,
    y: element.scrollHeight - element.clientHeight,
    doc: document.documentElement.scrollWidth - innerWidth,
  }));
  expect(overflow.x).toBeGreaterThan(100);
  expect(overflow.y).toBeGreaterThan(100);
  expect(overflow.doc).toBeLessThanOrEqual(1);
  const pan = view.button('Панорама');
  await view.viewport.evaluate(element => { element.scrollLeft = 0; element.scrollTop = 0; });
  await pan.click();
  await expect(pan).toHaveAttribute('aria-pressed', 'true');
  const area = await view.viewport.boundingBox();
  expect(area).toBeTruthy();
  const zoom = await view.viewport.evaluate(element => element.getBoundingClientRect().width / element.offsetWidth);
  const start = { x: area!.x + area!.width / 2, y: area!.y + area!.height / 2 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x - 125, start.y - 100, { steps: 6 });
  await page.mouse.up();
  await expect.poll(async () => Math.abs((await scrollOffset(view.viewport)).x - 125 / zoom)).toBeLessThanOrEqual(2);
  await expect.poll(async () => Math.abs((await scrollOffset(view.viewport)).y - 100 / zoom)).toBeLessThanOrEqual(2);
  await pan.click();
  await expect(pan).toHaveAttribute('aria-pressed', 'false');

  await view.viewport.evaluate(element => {
    element.scrollLeft = -element.scrollWidth;
    if (element.scrollLeft === 0) element.scrollLeft = element.scrollWidth;
    element.scrollTop = element.scrollHeight;
  });
  const far = await scrollOffset(view.viewport);
  expect(Math.abs(far.x)).toBeGreaterThan(100);
  expect(far.y).toBeGreaterThan(100);
  await view.button('К инструментам').click();
  await expect(view.sizeButton('tools')).toBeInViewport();
  await expect.poll(async () => (await scrollOffset(view.viewport)).y).toBeLessThan(far.y);

  const logcat = view.layout.locator('#tool-tab-logs');
  await logcat.click();
  const log = view.layout.locator('.log-viewport');
  await expect(log.locator('.log-row')).toHaveCount(logEntries.length);
  await log.hover({ position: { x: 35, y: 35 } });
  const logTop = await log.evaluate(element => element.scrollTop);
  const workspaceOffset = await scrollOffset(view.viewport);
  const documentOffset = await page.evaluate(() => window.scrollY);
  await page.mouse.wheel(0, -200);
  await expect.poll(() => log.evaluate(element => element.scrollTop)).toBeLessThan(logTop);
  expect(await scrollOffset(view.viewport)).toEqual(workspaceOffset);
  expect(await page.evaluate(() => window.scrollY)).toBe(documentOffset);

  await view.button('К команде').click();
  await expect(view.command).toBeFocused();
  await expect(view.command).toBeInViewport();
  await view.command.fill('getprop ro.product.model');
  await view.command.press('Enter');
  await expect(view.layout.locator('.terminal-output')).toContainText(label('Код выхода: {p0}').replace('{p0}', '0'));
  await view.button('К эмулятору').click();
  await expect(view.sizeButton('device')).toBeInViewport();
  await expect.poll(async () => (await stackPosition(view.window('device'))) - (await stackPosition(view.window('tools')))).toBeGreaterThan(0);
});
