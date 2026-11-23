import { readFileSync } from 'node:fs';
import { expect, test, type Locator, type Page } from '@playwright/test';

const sessionId = 'cbd55091-aaaa-bbbb-cccc-000000000001';
const sessionUrl = '/#/session/' + sessionId;
type WindowKind = 'device' | 'tools';
const directions = ['n', 'e', 's', 'w', 'nw', 'ne', 'sw', 'se'] as const;
type ResizeDirection = typeof directions[number];
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
    resize: (kind: WindowKind, direction: ResizeDirection) => canvas.locator(`[data-window-resize=${kind}][data-direction=${direction}]`),
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

async function expectAlignedDeskLabels(commandBar: Locator) {
  const labels = await commandBar.evaluate(element => {
    const selectors = ['.desk-overview-trigger-label', '.desk-command-exit-label', 'kbd'];
    return selectors.map(selector => {
      const label = element.querySelector(selector)!;
      const marker = document.createElement('span');
      marker.style.cssText = 'display:inline-block;width:0;height:0;vertical-align:baseline';
      label.append(marker);
      const { fontFamily, fontSize, lineHeight } = getComputedStyle(label);
      const baseline = marker.getBoundingClientRect().top;
      marker.remove();
      return { font: { fontFamily, fontSize, lineHeight }, baseline };
    });
  });
  expect(labels.slice(1).map(label => label.font)).toEqual([labels[0].font, labels[0].font]);
  const baselines = labels.map(label => label.baseline);
  expect(Math.max(...baselines) - Math.min(...baselines)).toBeLessThanOrEqual(0.5);
}

async function margins(canvas: Locator) {
  return canvas.evaluate(element => {
    const outer = element.getBoundingClientRect();
    const device = element.querySelector('[data-window=device]')!.getBoundingClientRect();
    const tools = element.querySelector('[data-window=tools]')!.getBoundingClientRect();
    return [device.left - outer.left, device.top - outer.top, outer.bottom - device.bottom,
      tools.left - device.right, tools.top - outer.top, outer.right - tools.right, outer.bottom - tools.bottom];
  });
}

async function startDrag(page: Page, handle: Locator) {
  await handle.scrollIntoViewIfNeeded();
  const { x, y, width, height } = (await handle.boundingBox())!;
  const origin = { x: x + width / 2, y: y + height / 2 };
  await page.mouse.move(origin.x, origin.y);
  await page.mouse.down();
  return origin;
}

async function drag(page: Page, handle: Locator, dx: number, dy: number) {
  const origin = await startDrag(page, handle);
  await page.mouse.move(origin.x + dx, origin.y + dy, { steps: 8 });
  await page.mouse.up();
}

test('floating device and tools move and resize independently with persistent geometry', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 940 });
  const view = await openSession(page);
  await view.media.evaluate(element => { element.setAttribute('data-test-retained-canvas', 'true'); });
  await view.button('Поверх кадра').click();
  await expect(view.layout).toHaveAttribute('data-workspace-mode', 'float');
  const modes = view.layout.getByRole('group', { name: 'Компоновка сессии' });
  await expect(modes.getByRole('button', { name: 'Стол', exact: true })).toBeVisible();
  await expect(modes.getByRole('button', { name: 'Сбросить раскладку', exact: true })).toBeVisible();
  for (const name of ['К эмулятору', 'К инструментам', 'К команде', 'Панорама']) {
    await expect(view.button(name)).toHaveCount(0);
  }
  await expect(view.media).toHaveAttribute('data-test-retained-canvas', 'true');
  await expect(view.canvas.locator('.floating-window-bar, [data-size-window]')).toHaveCount(0);
  await expect(view.move('device')).toBeVisible();
  await expect(view.move('tools')).toBeVisible();
  for (const kind of ['device', 'tools'] as const) {
    await expect(view.canvas.locator(`[data-window-resize=${kind}]`)).toHaveCount(directions.length);
    for (const direction of directions) await expect(view.resize(kind, direction)).toHaveCount(1);
  }
  const device = view.window('device');
  const tools = view.window('tools');
  const initialDevice = await bounds(device);
  const initialTools = await bounds(tools);
  const initialMargins = await margins(view.canvas);
  expect(Math.min(...initialMargins)).toBeGreaterThan(0);
  expect(Math.max(...initialMargins) - Math.min(...initialMargins)).toBeLessThanOrEqual(1);

  await view.move('device').focus();
  await expect.poll(async () => (await stackPosition(device)) - (await stackPosition(tools))).toBeGreaterThan(0);
  await drag(page, view.move('device'), 66, 46);
  await expect.poll(async () => (await bounds(device)).x - initialDevice.x).toBeGreaterThan(40);
  const movedDevice = await bounds(device);
  expect(movedDevice.y - initialDevice.y).toBeGreaterThan(30);
  expect(movedDevice.width).toBe(initialDevice.width);
  expect(movedDevice.height).toBe(initialDevice.height);
  expect(await bounds(tools)).toEqual(initialTools);

  await drag(page, view.resize('device', 'e'), 64, 30);
  await expect.poll(async () => (await bounds(device)).width - movedDevice.width).toBeGreaterThan(40);
  const wider = await bounds(device);
  expect(wider.x).toBe(movedDevice.x);
  expect(wider.y).toBe(movedDevice.y);
  expect(wider.height).toBe(movedDevice.height);

  await drag(page, view.resize('device', 'w'), 48, -25);
  await expect.poll(async () => (await bounds(device)).x - wider.x).toBeGreaterThan(30);
  const fromWest = await bounds(device);
  expect(fromWest.x + fromWest.width).toBe(wider.x + wider.width);
  expect(fromWest.y).toBe(wider.y);
  expect(fromWest.height).toBe(wider.height);

  await drag(page, view.resize('device', 'n'), 35, 48);
  await expect.poll(async () => (await bounds(device)).y - fromWest.y).toBeGreaterThan(30);
  const fromNorth = await bounds(device);
  expect(fromNorth.y + fromNorth.height).toBe(fromWest.y + fromWest.height);
  expect(fromNorth.x).toBe(fromWest.x);
  expect(fromNorth.width).toBe(fromWest.width);

  await drag(page, view.resize('device', 'se'), -72, -72);
  await expect.poll(async () => fromNorth.width - (await bounds(device)).width).toBeGreaterThan(40);
  const resizedDevice = await bounds(device);
  expect(resizedDevice.x).toBe(fromNorth.x);
  expect(resizedDevice.y).toBe(fromNorth.y);
  expect(resizedDevice.height).toBeLessThan(fromNorth.height - 40);
  expect(await bounds(tools)).toEqual(initialTools);
  await expect(view.media).toHaveAttribute('data-test-retained-canvas', 'true');

  await view.move('tools').focus();
  await expect.poll(async () => (await stackPosition(tools)) - (await stackPosition(device))).toBeGreaterThan(0);
  await drag(page, view.resize('tools', 's'), -40, -80);
  await expect.poll(async () => initialTools.height - (await bounds(tools)).height).toBeGreaterThan(45);
  const sizedTools = await bounds(tools);
  expect(sizedTools.x).toBe(initialTools.x);
  expect(sizedTools.y).toBe(initialTools.y);
  expect(sizedTools.width).toBe(initialTools.width);
  expect(await bounds(device)).toEqual(resizedDevice);

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

test('floating device and tools snap together outside Desk and restore their positions', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 940 });
  await page.addInitScript(() => {
    localStorage.setItem('rdf-session-floating-v3:u1:profile%3Aa11-gpu:initial:base', JSON.stringify({ front: 'tools', windows: {
      device: { left: 80, top: 100, width: 350, height: 550 },
      tools: { left: 640, top: 145, width: 640, height: 480 },
    } }));
  });
  const view = await openSession(page);
  await view.button('Поверх кадра').click();
  await expect(view.layout).toHaveAttribute('data-workspace-mode', 'float');
  await expect(view.viewport).not.toHaveAttribute('data-desk');
  const device = view.window('device');
  const tools = view.window('tools');
  const initialDevice = await bounds(device);
  const initialTools = await bounds(tools);
  const snappedTools = { ...initialTools, x: initialDevice.x + initialDevice.width };
  const snappedDevice = { ...initialDevice, x: snappedTools.x + snappedTools.width };

  const grip = (await view.move('tools').boundingBox())!;
  const startX = grip.x + grip.width / 2;
  const startY = grip.y + grip.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + snappedTools.x - initialTools.x + 14, startY, { steps: 8 });
  await expect.poll(() => bounds(tools)).toEqual(snappedTools);
  await expect(view.layout.locator('[data-window-snap-guide]')).toHaveCount(0);
  await page.mouse.up();
  expect(await bounds(tools)).toEqual(snappedTools);
  expect(await bounds(device)).toEqual(initialDevice);

  await drag(page, view.move('device'), snappedDevice.x - initialDevice.x - 14, 0);
  await expect.poll(() => bounds(device)).toEqual(snappedDevice);
  const west = view.resize('device', 'w');
  await drag(page, west, 56, 0);
  await expect.poll(() => bounds(device)).toEqual({ ...snappedDevice, x: snappedDevice.x + 56, width: snappedDevice.width - 56 });
  await drag(page, west, 14 - 56, 0);
  await expect.poll(() => bounds(device)).toEqual(snappedDevice);
  expect(await bounds(tools)).toEqual(snappedTools);

  await page.reload();
  await expect(view.layout).toHaveAttribute('data-workspace-mode', 'float');
  await expect(view.viewport).not.toHaveAttribute('data-desk');
  await expect.poll(() => bounds(device)).toEqual(snappedDevice);
  await expect.poll(() => bounds(tools)).toEqual(snappedTools);
});

test('floating stacked windows align at the left, center, and right with a temporary guide', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.addInitScript(() => {
    localStorage.setItem('rdf-session-floating-v3:u1:profile%3Aa11-gpu:initial:base', JSON.stringify({ front: 'tools', windows: {
      device: { left: 590, top: 85, width: 390, height: 360 },
      tools: { left: 1030, top: 480, width: 490, height: 370 },
    } }));
  });
  const view = await openSession(page);
  await view.button('Поверх кадра').click();
  await expect(view.viewport).not.toHaveAttribute('data-desk');
  const device = view.window('device');
  const tools = view.window('tools');
  const guides = view.canvas.locator('[data-window-alignment-guide]');
  const guide = view.canvas.locator('[data-window-alignment-guide=x]');
  const neighbor = await bounds(device);
  const initial = await bounds(tools);
  const origin = await startDrag(page, view.move('tools'));
  const moveTo = (x: number, y = initial.y) => page.mouse.move(origin.x + x - initial.x, origin.y + y - initial.y, { steps: 6 });

  for (const anchor of [0, 0.5, 1]) {
    const alignedX = neighbor.x + (neighbor.width - initial.width) * anchor;
    await moveTo(alignedX + 6);
    await expect.poll(() => bounds(tools)).toEqual({ ...initial, x: alignedX });
    await expect(guides).toHaveCount(1);
    await expect(guide).toHaveCSS('pointer-events', 'none');
    await expect(guide).toHaveCSS('border-left-style', 'dashed');
    const line = await bounds(guide);
    expect(Math.abs(line.x - (neighbor.x + neighbor.width * anchor))).toBeLessThanOrEqual(1);
    expect(line).toMatchObject({ y: neighbor.y, width: 1, height: initial.y + initial.height - neighbor.y });

    if (anchor === 0) {
      const freeX = neighbor.x + 110;
      await moveTo(freeX);
      await expect.poll(() => bounds(tools)).toEqual({ ...initial, x: freeX });
      await expect(guides).toHaveCount(0);
    }
    if (anchor === 0.5) await page.screenshot({ path: testInfo.outputPath('vertical-alignment.png') });
  }

  const saved = { ...initial, x: neighbor.x + neighbor.width - initial.width, y: neighbor.y + neighbor.height };
  await moveTo(saved.x + 6, saved.y + 12);
  await expect.poll(() => bounds(tools)).toEqual(saved);
  await expect(guides).toHaveCount(1);
  await expect(guide).toBeVisible();
  await page.mouse.up();
  await expect(guides).toHaveCount(0);
  expect(await bounds(tools)).toEqual(saved);
  expect(await bounds(device)).toEqual(neighbor);
  await page.reload();
  await expect.poll(() => bounds(tools)).toEqual(saved);
});

test('Desk draws keyboard resize focus on the rounded window and keeps pointer resize targets invisible', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 940 });
  const view = await openSession(page);
  await view.button('Стол').click();
  const device = view.window('device');
  const corner = view.resize('device', 'se');
  const edge = view.resize('device', 'w');
  const initial = await bounds(device);
  const radius = await device.evaluate(element => getComputedStyle(element).borderTopLeftRadius);
  expect(Number.parseFloat(radius)).toBeGreaterThan(0);

  await expect(view.viewport).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(corner).toBeFocused();
  await expect(corner).toHaveCSS('outline-style', 'none');
  await expect(device).toHaveCSS('outline-style', 'solid');
  await expect(device).toHaveCSS('outline-width', '2px');
  await expect(device).toHaveCSS('outline-offset', '-2px');
  await expect(device).toHaveCSS('border-top-left-radius', radius);
  expect(await corner.boundingBox()).toMatchObject({ width: 16, height: 16 });
  await page.keyboard.press('Shift+ArrowLeft');
  const keyboardBounds = { ...initial, width: initial.width - 32 };
  await expect.poll(() => bounds(device)).toEqual(keyboardBounds);
  await expect(corner).toBeFocused();

  const hit = (await edge.boundingBox())!;
  expect(hit.width).toBe(8);
  const x = hit.x + hit.width / 2;
  const y = hit.y + hit.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await expect(view.viewport).toHaveAttribute('data-window-drag', 'resize');
  await expect(edge).toBeFocused();
  await expect(edge).toHaveCSS('outline-style', 'none');
  await expect(edge).toHaveCSS('border-left-width', '0px');
  await expect(device).toHaveCSS('outline-style', 'none');
  await expect(device).toHaveCSS('border-left-width', '1px');
  await expect(device).toHaveCSS('border-top-left-radius', radius);
  await page.mouse.move(x + 36, y, { steps: 6 });
  const pointerBounds = { ...keyboardBounds, x: keyboardBounds.x + 36, width: keyboardBounds.width - 36 };
  await expect.poll(() => bounds(device)).toEqual(pointerBounds);
  expect((await edge.boundingBox())?.width).toBe(hit.width);
  await page.mouse.up();
  await expect(view.viewport).not.toHaveAttribute('data-window-drag');
  await expect(device).toHaveCSS('outline-style', 'none');
  expect(await bounds(device)).toEqual(pointerBounds);

  await page.keyboard.press('ArrowLeft');
  await expect.poll(() => bounds(device)).toEqual({ ...pointerBounds, x: pointerBounds.x - 16, width: pointerBounds.width + 16 });
  await expect(edge).toHaveCSS('outline-style', 'none');
  await expect(device).toHaveCSS('outline-width', '2px');
});

test('floating geometry is saved before pointerup and survives frame size changes', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 940 });
  await page.clock.install();
  await page.addInitScript(() => {
    const native = window.WebSocket;
    let mock = native;
    let stream: WebSocket | undefined;
    const captureSocket = Object.assign(function (url: string | URL, protocols?: string | string[]) {
      const socket = new mock(url, protocols);
      if (/\/api\/sessions\/.+\/stream/.test(String(url))) stream = socket;
      return socket;
    }, { OPEN: 1, CONNECTING: 0, CLOSED: 3, CLOSING: 2 });
    Object.defineProperty(window, 'WebSocket', { configurable: true,
      get: () => mock === native ? native : captureSocket,
      set: (socket: typeof WebSocket) => { mock = socket; },
    });
    Object.assign(window, { sendWorkspaceFrame(width: number, height: number) {
      const frame = document.createElement('canvas');
      frame.width = width;
      frame.height = height;
      const data = frame.toDataURL('image/jpeg').split(',')[1];
      // The Vite mock delivers received frames through onmessage.
      stream!.onmessage?.(new MessageEvent('message', { data: JSON.stringify({ type: 'frame', mime: 'image/jpeg', width, height, data }) }));
    } });
  });
  const view = await openSession(page);
  await view.button('Поверх кадра').click();
  await view.layout.locator('.workspace-default-view').click();
  const device = view.window('device');
  const tools = view.window('tools');
  const before = await bounds(device);
  const toolBounds = await bounds(tools);
  const dragGrip = await view.move('device').boundingBox();
  expect(dragGrip).not.toBeNull();
  const x = dragGrip!.x + dragGrip!.width / 2;
  const y = dragGrip!.y + dragGrip!.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 68, y + 45, { steps: 8 });
  const moved = await bounds(device);
  expect(moved.x - before.x).toBeGreaterThan(40);
  expect(moved.y - before.y).toBeGreaterThan(25);
  const stored = await page.evaluate(() => Object.entries(localStorage)
    .filter(([key]) => key.startsWith('rdf-session-floating-'))
    .map(([, value]) => JSON.parse(value).windows.device));
  expect.soft(stored).toContainEqual({ left: moved.x, top: moved.y, width: moved.width, height: moved.height });
  await page.mouse.up();

  await page.evaluate(() => {
    const target = window as Window & { sendWorkspaceFrame: (width: number, height: number) => void };
    target.sendWorkspaceFrame(1280, 720);
  });
  await expect.poll(() => view.viewport.evaluate(element => Number(element.style.getPropertyValue('--device-aspect')))).toBeCloseTo(1280 / 720);
  expect.soft(await bounds(device)).toEqual(moved);
  expect.soft(await bounds(tools)).toEqual(toolBounds);

  const poll = page.waitForResponse(response => response.ok() && response.url().endsWith('/api/sessions/' + sessionId));
  await page.clock.runFor(35_000);
  await poll;
  expect.soft(await bounds(device)).toEqual(moved);
  expect.soft(await bounds(tools)).toEqual(toolBounds);
  await page.reload();
  await expect(view.layout).toHaveAttribute('data-workspace-mode', 'float');
  await expect(view.layout.locator('.session-media-badge[data-media=video]')).toHaveAttribute('data-state', 'live');
  await expect.poll(() => bounds(device)).toEqual(moved);
  await expect.poll(() => bounds(tools)).toEqual(toolBounds);
});

test('previously saved floating windows are restored and stay reset after reopening', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 940 });
  const legacy = {
    device: { left: 75, top: 65, width: 365, height: 525 },
    tools: { left: 505, top: 25, width: 820, height: 700 },
  };
  await page.addInitScript(windows => {
    localStorage.setItem('rdf-session-floating-v1:u1:0.5625', JSON.stringify({ windows, front: 'device' }));
  }, legacy);
  const view = await openSession(page);
  const device = view.window('device');
  const tools = view.window('tools');
  await view.button('Поверх кадра').click();
  await expect.poll(() => bounds(device)).toEqual({ x: 75, y: 65, width: 365, height: 525 });
  await expect.poll(() => bounds(tools)).toEqual({ x: 505, y: 25, width: 820, height: 700 });
  await view.button('Сбросить раскладку').click();
  await expect.poll(async () => (await bounds(device)).x).toBe(12);
  await view.button('Экран').click();
  await view.button('Поверх кадра').click();
  await expect.poll(async () => (await bounds(device)).x).toBe(12);
  await expect.poll(async () => (await bounds(tools)).y).toBe(12);
});

test('separate tabs keep both window edits and respect a reset in another tab', async ({ page, context }) => {
  await page.setViewportSize({ width: 1920, height: 940 });
  const first = await openSession(page);
  await first.button('Поверх кадра').click();
  await first.layout.locator('.workspace-default-view').click();

  const prefix = 'rdf-session-floating-v3:u1:profile%3Aa11-gpu:';
  const resetKey = prefix + 'reset';
  const otherPage = await context.newPage();
  await otherPage.setViewportSize({ width: 1920, height: 940 });
  await otherPage.addInitScript(resetKey => {
    // Allow edits with a stale generation by pausing reset delivery to this tab.
    window.addEventListener('storage', event => {
      if (event.key === resetKey && document.documentElement.hasAttribute('data-test-pause-reset')) event.stopImmediatePropagation();
    }, { capture: true });
  }, resetKey);
  const second = await openSession(otherPage);
  await expect(second.layout).toHaveAttribute('data-workspace-mode', 'float');
  await drag(page, first.move('device'), 60, 55);
  const device = await bounds(first.window('device'));
  expect(device.x).toBeGreaterThan(50);
  await drag(otherPage, second.move('tools'), -85, 60);
  const tools = await bounds(second.window('tools'));
  expect(tools.y).toBeGreaterThan(40);

  await otherPage.reload();
  await expect.poll(() => bounds(second.window('device'))).toEqual(device);
  await expect.poll(() => bounds(second.window('tools'))).toEqual(tools);
  await first.button('Сбросить раскладку').click();
  await expect.poll(async () => (await bounds(second.window('device'))).x).toBe(12);
  await expect.poll(async () => (await bounds(second.window('tools'))).y).toBe(12);

  const generation = await otherPage.evaluate(({ prefix, resetKey }) => {
    localStorage.setItem(prefix + '1-2-3-4:device', '{}');
    document.documentElement.setAttribute('data-test-pause-reset', '');
    return localStorage.getItem(resetKey);
  }, { prefix, resetKey });
  await first.button('Сбросить раскладку').click();
  await expect.poll(() => otherPage.evaluate(key => localStorage.getItem(key), resetKey)).not.toBe(generation);
  await drag(otherPage, second.move('device'), 60, 55);
  await expect.poll(async () => (await bounds(second.window('device'))).x).toBeGreaterThan(50);
  expect(await otherPage.evaluate(prefix => Object.keys(localStorage).filter(key => key.startsWith(prefix)), prefix)).toEqual([resetKey]);
  await otherPage.reload();
  await expect.poll(async () => (await bounds(second.window('device'))).x).toBe(12);
  await otherPage.close();
});

test('a physical device remembers geometry without retaining its serial in storage', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 940 });
  const serial = 'fixture-usb-serial';
  const legacyKey = `rdf-session-floating-v2:u1:${encodeURIComponent('device:' + serial)}`;
  await page.addInitScript(key => {
    localStorage.setItem(key, JSON.stringify({ front: 'device', windows: {
      device: { left: 82, top: 65, width: 365, height: 525 },
      tools: { left: 505, top: 25, width: 820, height: 700 },
    } }));
  }, legacyKey);
  await page.route(`**/api/sessions/${sessionId}`, async route => {
    const response = await route.fetch();
    const body = await response.json();
    Object.assign(body.session, { deviceId: serial, deviceKind: 'usb-android', deviceType: 'mobile' });
    await route.fulfill({ response, json: body });
  });
  const view = await openSession(page);
  await view.button('Поверх кадра').click();
  await expect.poll(async () => (await bounds(view.window('device'))).x).toBe(82);
  await drag(page, view.move('device'), 40, 30);
  const stored = await page.evaluate(() => Object.entries(localStorage).filter(([key]) => key.startsWith('rdf-session-floating-')));
  expect(stored.some(([key]) => key.includes('physical%3Amobile'))).toBe(true);
  expect(JSON.stringify(stored)).not.toContain(serial);
});

test('the device text popover stays interactive in the floating workspace', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 940 });
  const view = await openSession(page);
  await view.button('Поверх кадра').click();
  await view.button('Отправить текст на устройство').click();
  const dialog = view.layout.getByRole('dialog', { name: 'Отправить текст на устройство' });
  await dialog.getByRole('textbox').fill('test input');
  await dialog.getByRole('button', { name: 'Отправить', exact: true }).click();
  await expect(dialog).toBeHidden();
});

test('Desk fills the viewport and keeps the live canvas and floating layout', async ({ page }) => {
  const viewportSize = { width: 1920, height: 940 };
  await page.setViewportSize(viewportSize);
  const view = await openSession(page);
  const enterDesk = view.button('Стол');
  await view.button('Рядом').click();
  await expect(enterDesk).toHaveCount(0);
  await expect(view.button('Сбросить раскладку')).toHaveCount(0);
  await view.button('Поверх кадра').click();
  await expect(enterDesk).toBeVisible();

  await view.media.evaluate(element => { element.setAttribute('data-test-retained-canvas', 'true'); });
  await drag(page, view.move('device'), 54, 38);
  await drag(page, view.resize('tools', 's'), 0, -90);
  const deviceBounds = await bounds(view.window('device'));
  const toolBounds = await bounds(view.window('tools'));
  const logs = view.layout.getByRole('tab', { name: 'Логкат', exact: true });
  await logs.click();
  await expect(logs).toHaveAttribute('aria-selected', 'true');

  await enterDesk.click();
  await expect(view.layout.locator('.workspace-grid[data-desk]')).toBeVisible();
  const area = (await view.viewport.boundingBox())!;
  expect(Math.abs(area.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(area.y)).toBeLessThanOrEqual(1);
  expect(area.width).toBeGreaterThanOrEqual(viewportSize.width - 1);
  expect(area.height).toBeGreaterThanOrEqual(viewportSize.height - 1);
  await expect(page.locator('.sidebar')).toBeHidden();
  await expect(page.locator('.topbar')).toBeHidden();
  await expect(view.layout.locator('.session-heading')).toBeHidden();
  await expect.poll(() => bounds(view.window('device'))).toEqual(deviceBounds);
  await expect.poll(() => bounds(view.window('tools'))).toEqual(toolBounds);
  await expect(view.media).toHaveAttribute('data-test-retained-canvas', 'true');
  await expect(logs).toHaveAttribute('aria-selected', 'true');

  await view.button('Отправить текст на устройство').press('Enter');
  const dialog = view.layout.getByRole('dialog', { name: 'Отправить текст на устройство' });
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(view.layout.locator('.workspace-grid[data-desk]')).toBeVisible();

  const commandBar = view.layout.locator('.desk-command-bar');
  const exitDesk = commandBar.getByRole('button', { name: 'Выйти из режима «Стол»', exact: true });
  await expect(exitDesk.locator('kbd')).toHaveText('Esc');
  await exitDesk.click();
  await expect(enterDesk).toBeFocused();
  await expect(view.layout).toHaveAttribute('data-workspace-mode', 'float');
  await expect(page.locator('.sidebar')).toBeVisible();
  await expect(view.layout.locator('.session-heading')).toBeVisible();

  await enterDesk.press('Enter');
  await expect(exitDesk).toBeVisible();
  await view.window('device').locator('.touch-layer').press('Escape');
  await expect(enterDesk).toBeFocused();
  await expect(exitDesk).toBeHidden();
  await expect.poll(() => bounds(view.window('device'))).toEqual(deviceBounds);
  await expect.poll(() => bounds(view.window('tools'))).toEqual(toolBounds);
  await expect(view.media).toHaveAttribute('data-test-retained-canvas', 'true');
  await expect(logs).toHaveAttribute('aria-selected', 'true');
});

test('Desk can be closed from its command bar without any tool tabs', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.route(`**/api/sessions/${sessionId}`, async route => {
    const response = await route.fetch();
    const body = await response.json();
    body.session.capabilities = ['video'];
    await route.fulfill({ response, json: body });
  });
  const view = await openSession(page);
  const enterDesk = view.button('Стол');
  await enterDesk.click();
  await expect(view.window('tools').getByRole('tab')).toHaveCount(0);
  const commandBar = view.layout.locator('.desk-command-bar');
  await commandBar.getByRole('button', { name: 'Выйти из режима «Стол»', exact: true }).click();
  await expect(commandBar).toBeHidden();
  await expect(enterDesk).toBeFocused();
});

test('Desk can be saved as the startup view, left temporarily, and cleared', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 940 });
  const view = await openSession(page);
  const enterDesk = view.button('Стол');
  const floatingDefault = view.layout.locator('.workspace-default-view');
  const deskDefault = view.layout.locator('.floating-desk-default');
  const desk = view.layout.locator('.workspace-grid[data-desk]');
  const savedView = () => page.evaluate(() => localStorage.getItem('rdf-session-default-view:u1'));

  await expect(view.layout).toHaveAttribute('data-workspace-mode', 'float');
  await expect(floatingDefault).toHaveAttribute('aria-pressed', 'false');
  expect(await savedView()).toBeNull();
  await enterDesk.click();
  await expect(deskDefault).toHaveAttribute('aria-pressed', 'false');
  await deskDefault.click();
  await expect(deskDefault).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(savedView).toBe('desk');

  await page.reload();
  await expect(desk).toBeVisible();
  await expect(deskDefault).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Escape');
  await expect(desk).toBeHidden();
  await expect(view.layout).toHaveAttribute('data-workspace-mode', 'float');
  await expect(floatingDefault).toHaveAttribute('aria-pressed', 'false');
  expect(await savedView()).toBe('desk');

  const nextSessionId = 'cbd55091-aaaa-bbbb-cccc-000000000002';
  await page.route(`**/api/sessions/${nextSessionId}`, async route => {
    const url = new URL(`/api/sessions/${sessionId}`, route.request().url());
    const response = await route.fetch({ url: url.href });
    const body = await response.json();
    body.session.id = nextSessionId;
    await route.fulfill({ response, json: body });
  });
  await page.goto(`/#/session/${nextSessionId}`);
  await expect(desk).toBeVisible();
  await expect(deskDefault).toHaveAttribute('aria-pressed', 'true');
  await expect(deskDefault).toHaveAttribute('title', 'Сбросить вид по умолчанию');
  await deskDefault.click();
  await expect(deskDefault).toHaveAttribute('aria-pressed', 'false');
  await expect(desk).toBeVisible();
  await expect.poll(savedView).toBeNull();

  await page.reload();
  await expect(enterDesk).toBeVisible();
  await expect(desk).toBeHidden();
  await expect(view.layout).toHaveAttribute('data-workspace-mode', 'float');
  await expect(floatingDefault).toHaveAttribute('aria-pressed', 'false');

  await view.button('Рядом').click();
  await floatingDefault.click();
  await expect.poll(savedView).toBe('split');
  await expect(floatingDefault).toHaveAttribute('aria-pressed', 'true');
  await expect(floatingDefault).toHaveAttribute('title', 'Сбросить вид по умолчанию');
  await floatingDefault.click();
  await expect(floatingDefault).toHaveAttribute('aria-pressed', 'false');
  await expect(view.layout).toHaveAttribute('data-workspace-mode', 'split');
  await expect.poll(savedView).toBeNull();

  await page.reload();
  await expect(enterDesk).toBeVisible();
  await expect(desk).toBeHidden();
  await expect(view.layout).toHaveAttribute('data-workspace-mode', 'float');
  await expect(floatingDefault).toHaveAttribute('aria-pressed', 'false');
});

test('Desk tabs detach by drag, retain tool state and return when dropped on the tab strip', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 940 });
  const nativeDragImages: Record<string, unknown>[] = [];
  await page.exposeFunction('recordDeskDragImage', (image: Record<string, unknown>) => { nativeDragImages.push(image); });
  await page.addInitScript(() => {
    localStorage.setItem('rdf-session-floating-v3:u1:profile%3Aa11-gpu:initial:base', JSON.stringify({ front: 'tools', windows: {
      device: { left: 800, top: 12, width: 395, height: 800 },
      tools: { left: 1220, top: 12, width: 688, height: 800 },
    } }));
    const setDragImage = DataTransfer.prototype.setDragImage;
    DataTransfer.prototype.setDragImage = function (element, x, y) {
      setDragImage.call(this, element, x, y);
      const image = element instanceof HTMLImageElement ? element : null;
      let alpha: number | null = null;
      if (image?.complete && image.naturalWidth === 1 && image.naturalHeight === 1) {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 1;
        const context = canvas.getContext('2d')!;
        context.fillRect(0, 0, 1, 1);
        context.globalCompositeOperation = 'copy';
        context.drawImage(image, 0, 0);
        alpha = context.getImageData(0, 0, 1, 1).data[3];
      }
      void (window as unknown as { recordDeskDragImage: (value: unknown) => Promise<void> }).recordDeskDragImage({
        tag: element.tagName, connected: element.isConnected, complete: image?.complete ?? false,
        width: image?.naturalWidth ?? null, height: image?.naturalHeight ?? null, alpha, x, y,
      });
    };
  });
  const transparentDragImage = { tag: 'IMG', connected: false, complete: true, width: 1, height: 1, alpha: 0, x: 0, y: 0 };
  const view = await openSession(page);
  await view.button('Стол').click();
  const logs = view.layout.getByRole('tab', { name: 'Логкат', exact: true });
  const filter = view.layout.getByRole('textbox', { name: 'Поиск по журналу' });
  const widget = view.canvas.locator('[data-window="widget:logs"]');
  const preview = view.canvas.locator('[data-widget-preview]');
  const grip = widget.locator('button[data-window-move="widget:logs"]');
  const dock = view.window('tools').locator('[data-widget-dock]');
  const guide = view.layout.locator('[data-window-snap-guide]');

  await logs.click();
  await filter.fill('ActivityManager');
  const tabBox = (await logs.boundingBox())!;
  const deviceBox = (await view.window('device').boundingBox())!;
  // A new widget is 680px wide here, with its drag anchor 32px from the left.
  const dropPoint = { x: deviceBox.x - 680 + 32 + 14, y: deviceBox.y + 100 };
  await page.mouse.move(tabBox.x + tabBox.width / 2, tabBox.y + tabBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(dropPoint.x, dropPoint.y, { steps: 12 });
  await expect(view.viewport).toHaveAttribute('data-tab-drag', '');
  await expect.poll(() => nativeDragImages).toEqual([transparentDragImage]);
  await page.mouse.move(dropPoint.x, dropPoint.y + 1);
  await expect(preview).toBeVisible();
  expect(await preview.evaluate(element => element.closest('[inert]') !== null)).toBe(true);
  await expect(preview.locator('.desk-widget-title')).toHaveText('Логкат');
  await expect(preview.locator('.log-search-field input')).toHaveValue('ActivityManager');
  await expect(preview.locator('.log-viewport')).toBeVisible();
  await expect(widget).toHaveCount(0);
  const previewBounds = await bounds(preview);
  expect(previewBounds.width).toBeGreaterThan(400);
  expect(previewBounds.height).toBeGreaterThan(300);
  const deviceEdge = await bounds(view.window('device'));
  expect(previewBounds.x + previewBounds.width).toBe(deviceEdge.x);
  await expect(guide).toHaveCount(0);
  await page.mouse.up();
  await expect(widget).toBeVisible();
  await expect(preview).toHaveCount(0);
  await expect(guide).toHaveCount(0);
  await expect.poll(() => bounds(widget)).toEqual(previewBounds);
  await expect(logs).toHaveCount(0);
  await expect(widget.getByRole('textbox', { name: 'Поиск по журналу' })).toHaveValue('ActivityManager');

  await view.layout.getByRole('tab', { name: 'Консоль', exact: true }).click();
  await view.command.fill('getprop ro.product.model');
  await expect(view.command).toHaveValue('getprop ro.product.model');
  await expect(filter).toHaveValue('ActivityManager');
  const initial = await bounds(widget);
  const tools = await bounds(view.window('tools'));
  const device = await bounds(view.window('device'));
  await drag(page, grip, 54, 66);
  await expect.poll(async () => (await bounds(widget)).x - initial.x).toBeGreaterThan(40);
  const moved = await bounds(widget);
  expect(moved.y - initial.y).toBeGreaterThan(50);
  await expect(widget.locator('[data-window-resize="widget:logs"]')).toHaveCount(directions.length);
  await drag(page, widget.locator('[data-window-resize="widget:logs"][data-direction="e"]'), 66, 0);
  await expect.poll(async () => (await bounds(widget)).width - moved.width).toBeGreaterThan(50);
  const resized = await bounds(widget);
  expect(resized.height).toBe(moved.height);
  expect(await bounds(view.window('tools'))).toEqual(tools);
  expect(await bounds(view.window('device'))).toEqual(device);

  await view.layout.locator('.floating-desk-default').click();
  await page.reload();
  await expect(view.layout.locator('.workspace-grid[data-desk]')).toBeVisible();
  await expect.poll(() => bounds(widget)).toEqual(resized);
  await filter.fill('AudioFlinger');
  const dockBox = (await dock.boundingBox())!;
  const dockPoint = { x: dockBox.x + dockBox.width / 2, y: dockBox.y + dockBox.height / 2 };
  const moveIntoDock = async () => {
    const gripBox = (await grip.boundingBox())!;
    await page.mouse.move(gripBox.x + gripBox.width / 2, gripBox.y + gripBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(dockPoint.x, dockPoint.y, { steps: 12 });
  };

  await drag(page, view.move('device'), 620, 0);
  await expect.poll(() => page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('[data-window]')?.getAttribute('data-window'), dockPoint)).toBe('device');
  await moveIntoDock();
  await expect(dock).not.toHaveAttribute('data-dock-target', '');
  await page.mouse.up();
  await expect(widget).toBeVisible();
  await expect(logs).toHaveCount(0);

  await drag(page, view.move('device'), -620, 0);
  await drag(page, grip, -160, 80);
  await moveIntoDock();
  await expect(dock).toHaveAttribute('data-dock-target', '');
  await page.mouse.up();
  await expect(widget).toHaveCount(0);
  await expect(dock).not.toHaveAttribute('data-dock-target', '');
  await expect(logs).toHaveAttribute('aria-selected', 'true');
  await expect(view.window('tools').getByRole('textbox', { name: 'Поиск по журналу' })).toHaveValue('AudioFlinger');
  await page.reload();
  await expect(logs).toBeVisible();
  await expect(widget).toHaveCount(0);

  await logs.click();
  const info = view.layout.getByRole('tab', { name: 'Сведения', exact: true });
  await expect(info).toHaveAttribute('aria-selected', 'false');
  const dockedTab = (await info.boundingBox())!;
  await page.mouse.move(dockedTab.x + dockedTab.width / 2, dockedTab.y + dockedTab.height / 2);
  await page.mouse.down();
  await page.mouse.move(dropPoint.x, dropPoint.y, { steps: 12 });
  await expect(preview).toBeVisible();
  await expect.poll(() => nativeDragImages).toEqual([transparentDragImage, transparentDragImage]);
  await expect(preview).toHaveAttribute('data-widget-preview', 'info');
  await expect(preview.locator('.info-panel')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(preview).toHaveCount(0);
  await page.mouse.up();
  await expect(view.viewport).not.toHaveAttribute('data-tab-drag');
  await expect(info).toBeVisible();
  await expect(logs).toHaveAttribute('aria-selected', 'true');
  await expect(view.canvas.locator('[data-window="widget:info"]')).toHaveCount(0);
});

test('Desk can detach and return a tool with the keyboard', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const view = await openSession(page);
  await view.button('Стол').click();
  const logs = view.layout.getByRole('tab', { name: 'Логкат', exact: true });
  const widget = view.canvas.locator('[data-window="widget:logs"]');
  const grip = widget.locator('button[data-window-move="widget:logs"]');

  await logs.press('Alt+Enter');
  await expect(logs).toHaveCount(0);
  await expect(grip).toBeFocused();
  const start = await bounds(widget);
  await grip.press('Shift+ArrowRight');
  await expect.poll(async () => (await bounds(widget)).x).toBe(start.x + 32);
  await widget.getByRole('button', { name: 'Вернуть во вкладки' }).press('Enter');
  await expect(widget).toHaveCount(0);
  await expect(logs).toHaveAttribute('aria-selected', 'true');
  await expect(logs).toBeFocused();
});

test('Desk snaps moving widgets to nearby edges without blocking deliberate overlap', async ({ page }) => {
  await page.setViewportSize({ width: 1536, height: 900 });
  await page.addInitScript(() => {
    const profile = encodeURIComponent('profile:a11-gpu');
    localStorage.setItem('rdf-session-default-view:u1', 'desk');
    localStorage.setItem(`rdf-session-floating-v3:u1:${profile}:initial:base`, JSON.stringify({ front: 'tools', windows: {
      device: { left: 80, top: 100, width: 350, height: 550 },
      tools: { left: 970, top: 24, width: 490, height: 650 },
    } }));
    const widgetKey = `rdf-session-desk-widget-v1:u1:${profile}:logs`;
    if (localStorage.getItem(widgetKey) === null) {
      localStorage.setItem(widgetKey, JSON.stringify({ left: 460, top: 165, width: 435, height: 400 }));
    }
  });
  const view = await openSession(page);
  const device = view.window('device');
  const widget = view.canvas.locator('[data-window="widget:logs"]');
  const grip = widget.locator('button[data-window-move="widget:logs"]');
  const guide = view.layout.locator('[data-window-snap-guide]');
  await expect(grip).toBeVisible();
  const initial = await bounds(widget);
  const neighbor = await bounds(device);
  const edge = neighbor.x + neighbor.width;
  const start = (await grip.boundingBox())!;
  const x = start.x + start.width / 2;
  const y = start.y + start.height / 2;

  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + edge + 14 - initial.x, y, { steps: 6 });
  await expect.poll(() => bounds(widget)).toEqual({ ...initial, x: edge });
  await expect(guide).toHaveCount(0);

  await page.mouse.move(x + edge - 65 - initial.x, y, { steps: 6 });
  await expect.poll(() => bounds(widget)).toEqual({ ...initial, x: edge - 65 });
  await expect(guide).toHaveCount(0);
  await page.mouse.up();
  expect(await bounds(widget)).toEqual({ ...initial, x: edge - 65 });

  const overlapGrip = (await grip.boundingBox())!;
  const overlapX = overlapGrip.x + overlapGrip.width / 2 + 3;
  const overlapY = overlapGrip.y + overlapGrip.height / 2 + 1;
  await page.mouse.move(overlapX, overlapY);
  expect(await grip.evaluate((element, point) => element.contains(document.elementFromPoint(point.x, point.y)),
    { x: overlapX, y: overlapY })).toBe(true);
  await page.mouse.down();
  await expect(view.viewport).toHaveAttribute('data-window-drag', 'move');
  await page.mouse.move(overlapX + 51, overlapY, { steps: 6 });
  const attached = { ...initial, x: edge };
  await expect.poll(() => bounds(widget)).toEqual(attached);
  await expect(guide).toHaveCount(0);
  await page.mouse.up();
  await expect(guide).toHaveCount(0);
  expect(await bounds(widget)).toEqual(attached);
  expect(await bounds(device)).toEqual(neighbor);

  await page.reload();
  await expect(grip).toBeVisible();
  await expect.poll(() => bounds(widget)).toEqual(attached);
});

test('Desk widgets align at the top, center, and bottom with a temporary guide', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1536, height: 900 });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.addInitScript(() => {
    const profile = encodeURIComponent('profile:a11-gpu');
    localStorage.setItem('rdf-session-default-view:u1', 'desk');
    localStorage.setItem(`rdf-session-floating-v3:u1:${profile}:initial:base`, JSON.stringify({ front: 'tools', windows: {
      device: { left: 90, top: 180, width: 390, height: 410 },
      tools: { left: 1060, top: 600, width: 440, height: 360 },
    } }));
    const widgetKey = `rdf-session-desk-widget-v1:u1:${profile}:logs`;
    if (localStorage.getItem(widgetKey) === null) {
      localStorage.setItem(widgetKey, JSON.stringify({ left: 560, top: 390, width: 420, height: 360 }));
    }
  });
  const view = await openSession(page);
  await expect(view.viewport).toHaveAttribute('data-desk', 'true');
  const device = view.window('device');
  const widget = view.canvas.locator('[data-window="widget:logs"]');
  const grip = widget.locator('button[data-window-move="widget:logs"]');
  const guides = view.canvas.locator('[data-window-alignment-guide]');
  const guide = view.canvas.locator('[data-window-alignment-guide=y]');
  const neighbor = await bounds(device);
  const initial = await bounds(widget);
  const origin = await startDrag(page, grip);
  const moveTo = (y: number) => page.mouse.move(origin.x, origin.y + y - initial.y, { steps: 6 });

  for (const anchor of [0, 0.5, 1]) {
    const alignedY = neighbor.y + (neighbor.height - initial.height) * anchor;
    await moveTo(alignedY + 6);
    await expect.poll(() => bounds(widget)).toEqual({ ...initial, y: alignedY });
    await expect(guides).toHaveCount(1);
    await expect(guide).toHaveCSS('pointer-events', 'none');
    await expect(guide).toHaveCSS('border-top-style', 'dashed');
    const line = await bounds(guide);
    expect(Math.abs(line.y - (neighbor.y + neighbor.height * anchor))).toBeLessThanOrEqual(1);
    expect(line).toMatchObject({ x: neighbor.x, width: initial.x + initial.width - neighbor.x, height: 1 });

    if (anchor === 0) {
      const freeY = neighbor.y + 145;
      await moveTo(freeY);
      await expect.poll(() => bounds(widget)).toEqual({ ...initial, y: freeY });
      await expect(guides).toHaveCount(0);
    }
    if (anchor === 0.5) await page.screenshot({ path: testInfo.outputPath('horizontal-alignment.png') });
  }

  await page.mouse.up();
  await expect(guides).toHaveCount(0);
  const saved = { ...initial, y: neighbor.y + neighbor.height - initial.height };
  expect(await bounds(widget)).toEqual(saved);
  expect(await bounds(device)).toEqual(neighbor);
  await page.reload();
  await expect(view.viewport).toHaveAttribute('data-desk', 'true');
  await expect.poll(() => bounds(widget)).toEqual(saved);
});

test('Desk snaps a resized edge and commits the release position', async ({ page }) => {
  await page.setViewportSize({ width: 1536, height: 900 });
  await page.addInitScript(() => {
    const profile = encodeURIComponent('profile:a11-gpu');
    localStorage.setItem('rdf-session-default-view:u1', 'desk');
    localStorage.setItem(`rdf-session-floating-v3:u1:${profile}:initial:base`, JSON.stringify({ front: 'tools', windows: {
      device: { left: 80, top: 100, width: 350, height: 550 },
      tools: { left: 100, top: 485, width: 400, height: 360 },
    } }));
    const widgetKey = `rdf-session-desk-widget-v1:u1:${profile}:logs`;
    if (localStorage.getItem(widgetKey) === null) {
      localStorage.setItem(widgetKey, JSON.stringify({ left: 460, top: 165, width: 435, height: 400 }));
    }
  });

  const view = await openSession(page);
  const device = view.window('device');
  const widget = view.canvas.locator('[data-window="widget:logs"]');
  const handle = widget.locator('[data-window-resize="widget:logs"][data-direction="w"]');
  await expect(handle).toBeVisible();
  const initial = await bounds(widget);
  const neighbor = await bounds(device);
  const edge = neighbor.x + neighbor.width;
  const fixedRight = initial.x + initial.width;
  const snapped = { ...initial, x: edge, width: fixedRight - edge };
  const guide = view.layout.locator('[data-window-snap-guide]');
  const start = (await handle.boundingBox())!;
  const x = start.x + start.width / 2;
  const y = start.y + start.height / 2;

  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + edge + 14 - initial.x, y, { steps: 6 });
  await expect.poll(() => bounds(widget)).toEqual(snapped);
  await expect(guide).toHaveCount(0);
  await page.mouse.move(x + edge - 14 - initial.x, y, { steps: 6 });
  await expect.poll(() => bounds(widget)).toEqual(snapped);
  await expect(guide).toHaveCount(0);
  await page.mouse.move(x + 100, y, { steps: 6 });
  const minimum = { ...initial, x: fixedRight - 400, width: 400 };
  await expect.poll(() => bounds(widget)).toEqual(minimum);
  await page.mouse.up();
  expect(await bounds(widget)).toEqual(minimum);

  const releaseStart = (await handle.boundingBox())!;
  const releaseX = Math.round(releaseStart.x + releaseStart.width / 2);
  const releaseY = Math.round(releaseStart.y + releaseStart.height / 2);
  await page.mouse.move(releaseX, releaseY);
  const pointerEvents = await view.viewport.evaluateHandle(element => {
    const events: { type: string; x: number }[] = [];
    for (const type of ['pointermove', 'pointerup']) {
      element.addEventListener(type, event => events.push({ type, x: (event as PointerEvent).clientX }), { capture: true });
    }
    return events;
  });
  const cdp = await page.context().newCDPSession(page);
  const moveX = releaseX + edge + 32 - minimum.x;
  const endX = releaseX + edge + 14 - minimum.x;
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: releaseX, y: releaseY, button: 'left', buttons: 1, clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: moveX, y: releaseY, buttons: 1 });
  await expect.poll(() => bounds(widget)).toEqual({ ...initial, x: edge + 32, width: fixedRight - edge - 32 });
  // The final coordinate reaches the snap zone without another move event.
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: endX, y: releaseY, button: 'left', buttons: 0, clickCount: 1 });
  await cdp.detach();
  expect(await pointerEvents.jsonValue()).toEqual([{ type: 'pointermove', x: moveX }, { type: 'pointerup', x: endX }]);
  await pointerEvents.dispose();
  await expect.poll(() => bounds(widget)).toEqual(snapped);
  expect(await bounds(device)).toEqual(neighbor);

  await page.reload();
  await expect(handle).toBeVisible();
  await expect.poll(() => bounds(widget)).toEqual(snapped);
});

test('Desk overview reveals covered and offscreen windows without changing the layout', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => {
    const profile = encodeURIComponent('profile:a11-gpu');
    localStorage.setItem(`rdf-session-floating-v3:u1:${profile}:initial:base`, JSON.stringify({ front: 'tools', windows: {
      device: { left: 42, top: 36, width: 300, height: 430 },
      tools: { left: 20, top: 16, width: 900, height: 560 },
    } }));
    localStorage.setItem(`rdf-session-desk-widget-v1:u1:${profile}:logs`, JSON.stringify({
      left: 1750, top: 1120, width: 1600, height: 1050,
    }));
  });
  const view = await openSession(page);
  const overview = view.button('Обзор окон');
  await expect(overview).toBeHidden();
  await view.button('Стол').click();
  const dialog = view.layout.getByRole('dialog', { name: 'Обзор окон' });
  const device = view.window('device');
  const tools = view.window('tools');
  const widget = view.canvas.locator('[data-window="widget:logs"]');
  const widgetMove = widget.locator('button[data-window-move="widget:logs"]');
  const selectWindow = (name: string) => dialog.locator(`[data-overview-window="${name}"]`);
  const nativeBounds = { device: await bounds(device), tools: await bounds(tools), logs: await bounds(widget) };
  const desk = view.layout.locator('.workspace-grid[data-desk]');
  const previews = view.canvas.locator('[data-window-preview]');

  await expect(widget).not.toBeInViewport();
  expect(await device.evaluate(element => {
    const rect = element.getBoundingClientRect();
    return document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
      ?.closest('[data-window]')?.getAttribute('data-window');
  })).toBe('tools');

  await overview.click();
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('[data-overview-window]')).toHaveCount(3);
  await expect(previews).toHaveCount(3);
  await expect(device).toBeInViewport();
  await expect(widget).toBeInViewport();
  await selectWindow('device').click();
  await expect(dialog).toBeHidden();
  await expect(previews).toHaveCount(0);
  await expect(device).toHaveAttribute('data-front', '');
  expect(await bounds(device)).toEqual(nativeBounds.device);
  expect(await bounds(tools)).toEqual(nativeBounds.tools);
  expect(await bounds(widget)).toEqual(nativeBounds.logs);

  await page.keyboard.press('Alt+Shift+W');
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Alt+Shift+W');
  await expect(dialog).toBeHidden();
  await page.keyboard.press('Alt+Shift+W');
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(desk).toBeVisible();

  const empty = { x: 130, y: 720 };
  expect(await view.canvas.evaluate((element, point) => document.elementFromPoint(point.x, point.y) === element, empty)).toBe(true);
  await page.mouse.dblclick(empty.x, empty.y);
  await expect(dialog).toBeVisible();
  await selectWindow('widget:logs').click();
  await expect(dialog).toBeHidden();
  await expect(widget).toHaveAttribute('data-front', '');
  await expect(widgetMove).toBeInViewport();
  const offset = await scrollOffset(view.viewport);
  expect(offset.x).toBeGreaterThan(500);
  expect(offset.y).toBeGreaterThan(500);
  expect(await bounds(widget)).toEqual(nativeBounds.logs);
  expect(await bounds(device)).toEqual(nativeBounds.device);
  expect(await bounds(tools)).toEqual(nativeBounds.tools);

  await widget.getByRole('textbox', { name: 'Поиск по журналу' }).fill('ActivityManager');
  await expect(overview).toBeInViewport();
  await overview.click();
  await expect(dialog).toBeVisible();
  await expect(widget.locator('.log-search-field input')).toHaveValue('ActivityManager');
  const dock = dialog.locator('[data-overview-dock="widget:logs"]');
  await expect(dock).toHaveAccessibleName('Вернуть «Логкат» во вкладки');
  await dock.click();
  await expect(dialog).toBeVisible();
  await expect(selectWindow('widget:logs')).toHaveCount(0);
  await expect(selectWindow('tools')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(desk).toBeVisible();
  await expect(widget).toHaveCount(0);
  await expect(tools.getByRole('tab', { name: 'Логкат', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(tools.getByRole('textbox', { name: 'Поиск по журналу' })).toHaveValue('ActivityManager');
});

test('Desk pans oversized layouts by dragging empty canvas', async ({ page }) => {
  await page.setViewportSize({ width: 1536, height: 800 });
  await page.addInitScript(() => {
    localStorage.setItem('rdf-session-floating-v1:u1:0.5625', JSON.stringify({ front: 'tools', windows: {
      device: { left: 12, top: 12, width: 300, height: 430 },
      tools: { left: 460, top: 40, width: 1400, height: 1020 },
    } }));
  });
  const view = await openSession(page);
  await view.button('Поверх кадра').click();
  await view.button('Стол').click();
  await expect(view.layout.locator('.workspace-grid[data-desk]')).toBeVisible();
  const commandBar = view.layout.locator('.desk-command-bar');
  await expect(commandBar).toBeInViewport({ ratio: 1 });
  await expect(commandBar.getByRole('button')).toHaveCount(2);
  await expect(commandBar.getByRole('button', { name: 'Обзор окон', exact: true })).toBeVisible();
  const exit = commandBar.getByRole('button', { name: 'Выйти из режима «Стол»', exact: true });
  await expect(exit.locator('.desk-command-exit-label')).toHaveText('Выйти');
  await expect(exit.locator('kbd')).toHaveText('Esc');
  await expect(exit).toHaveAttribute('aria-keyshortcuts', 'Escape');
  await expectAlignedDeskLabels(commandBar);
  await expect(view.viewport).toHaveAccessibleDescription('Нажмите Esc, чтобы выйти из режима «Стол».');
  expect(await view.layout.locator('#desk-exit-hint').evaluate(element => {
    const { width, height } = element.getBoundingClientRect();
    return Math.max(width, height);
  })).toBeLessThanOrEqual(1);
  const commandPosition = (await commandBar.boundingBox())!;
  expect(Math.abs(commandPosition.x + commandPosition.width / 2 - 1536 / 2)).toBeLessThanOrEqual(1);
  const empty = { x: 250, y: 650 };
  expect(await view.canvas.evaluate((element, point) => document.elementFromPoint(point.x, point.y) === element, empty)).toBe(true);
  const tools = await bounds(view.window('tools'));
  await page.mouse.move(empty.x, empty.y);
  await page.mouse.down();
  await page.mouse.move(empty.x - 120, empty.y - 90, { steps: 6 });
  await page.mouse.up();
  await expect.poll(() => scrollOffset(view.viewport)).toEqual({ x: 120, y: 90 });
  expect(await page.evaluate(() => ({ x: window.scrollX, y: window.scrollY }))).toEqual({ x: 0, y: 0 });
  expect(await bounds(view.window('tools'))).toEqual(tools);
  await expect(commandBar).toBeInViewport({ ratio: 1 });
  expect(await commandBar.boundingBox()).toEqual(commandPosition);
  await page.keyboard.press('Escape');
  await expect(commandBar).toBeHidden();
  await expect(view.button('Стол')).toBeFocused();
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
  const before = await bounds(view.window('tools'));
  const grip = view.resize('tools', 'se');
  await grip.focus();
  for (let step = 0; step < 10; step++) await grip.press('Shift+ArrowRight');
  for (let step = 0; step < 8; step++) await grip.press('Shift+ArrowDown');
  const after = await bounds(view.window('tools'));
  expect(after.width - before.width).toBeGreaterThan(250);
  expect(after.height - before.height).toBeGreaterThan(200);
  expect(after.x).toBe(before.x);
  expect(after.y).toBe(before.y);

  const overflow = await view.viewport.evaluate(element => ({
    x: element.scrollWidth - element.clientWidth,
    y: element.scrollHeight - element.clientHeight,
    doc: document.documentElement.scrollWidth - innerWidth,
  }));
  expect(overflow.x).toBeGreaterThan(100);
  expect(overflow.y).toBeGreaterThan(100);
  expect(overflow.doc).toBeLessThanOrEqual(1);
  await view.viewport.evaluate(element => { element.scrollLeft = 0; element.scrollTop = 0; });
  const area = (await view.viewport.boundingBox())!;
  await page.mouse.move(area.x + area.width / 2, area.y + 4);
  await page.mouse.wheel(125, 100);
  await expect.poll(async () => (await scrollOffset(view.viewport)).x).toBeGreaterThan(0);
  await expect.poll(async () => (await scrollOffset(view.viewport)).y).toBeGreaterThan(0);

  await view.viewport.evaluate(element => {
    element.scrollLeft = -element.scrollWidth;
    if (element.scrollLeft === 0) element.scrollLeft = element.scrollWidth;
    element.scrollTop = element.scrollHeight;
  });
  const far = await scrollOffset(view.viewport);
  expect(Math.abs(far.x)).toBeGreaterThan(100);
  expect(far.y).toBeGreaterThan(100);
  await view.move('tools').focus();
  await expect(view.move('tools')).toBeInViewport();
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

  await view.layout.locator('#tool-tab-console').click();
  await view.command.click();
  await expect(view.command).toBeFocused();
  await expect(view.command).toBeInViewport();
  await view.command.fill('getprop ro.product.model');
  await view.command.press('Enter');
  await expect(view.layout.locator('.terminal-output')).toContainText(label('Код выхода: {p0}').replace('{p0}', '0'));
  await view.move('device').focus();
  await expect(view.move('device')).toBeInViewport();
  await expect.poll(async () => (await stackPosition(view.window('device'))) - (await stackPosition(view.window('tools')))).toBeGreaterThan(0);
  await view.button('Стол').click();
  const commandBar = view.layout.locator('.desk-command-bar');
  await expect(commandBar).toBeInViewport({ ratio: 1 });
  await expect(commandBar.getByRole('button', { name: label('Обзор окон'), exact: true })).toBeVisible();
  const exit = commandBar.getByRole('button', { name: label('Выйти из режима «Стол»'), exact: true });
  await expect(exit.locator('.desk-command-exit-label')).toHaveText(arabic['session.workspace.exitDeskShort']);
  await expect(exit.locator('kbd')).toHaveText('Esc');
  await expectAlignedDeskLabels(commandBar);
  await expect(view.viewport).toHaveAccessibleDescription(label('Нажмите Esc, чтобы выйти из режима «Стол».'));
  const centerOffset = await commandBar.evaluate(element => {
    const { x, width } = element.getBoundingClientRect();
    return Math.abs(x + width / 2 - innerWidth / 2);
  });
  expect(centerOffset).toBeLessThanOrEqual(1);
});
