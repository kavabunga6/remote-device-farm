import { expect, test } from '@playwright/test';

const sessionId = 'cbd55091-aaaa-bbbb-cccc-000000000001';

test('Desk batches a burst of pan input without rebuilding the scene', async ({ page }) => {
  await page.setViewportSize({ width: 1536, height: 900 });
  await page.goto('/#/session/' + sessionId);
  const layout = page.locator('.session-layout');
  await layout.locator('.workspace-enter-desk').click();
  const viewport = layout.locator('.workspace-grid[data-desk]');
  await layout.locator('.desk-zoom-in').click();
  await expect(viewport).toHaveAttribute('data-desk-zoom', '1.1');
  const pointerId = await viewport.evaluateHandle(element => {
    const pointer = { id: -1 };
    element.addEventListener('pointerdown', event => { pointer.id = event.pointerId; }, { capture: true, once: true });
    return pointer;
  });
  const start = { x: 740, y: 480 };
  const delta = { x: 270, y: 180 };
  const final = { x: delta.x + 17, y: delta.y - 11 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down({ button: 'right' });
  await expect(viewport).toHaveAttribute('data-panning', '');

  const result = await viewport.evaluate(async (element, { pointer, start, delta, final }) => {
    const plane = element.querySelector('.session-floating-plane')!;
    const canvas = element.querySelector<HTMLElement>('.session-floating-canvas')!;
    const grid = element.parentElement!.querySelector('.desk-grid-pattern')!;
    const cell = parseFloat(getComputedStyle(grid).getPropertyValue('--desk-grid-cell'));
    const snapshot = () => {
      const { left, top } = canvas.getBoundingClientRect();
      const gridPosition = new DOMMatrixReadOnly(getComputedStyle(grid).transform);
      return {
        visible: { left, top },
        scroll: { left: element.scrollLeft, top: element.scrollTop },
        translate: canvas.style.translate,
        transform: canvas.style.transform,
        grid: { left: gridPosition.m41, top: gridPosition.m42 },
      };
    };
    const style = document.createElement('div').style;
    const withoutVisualOffset = (value: string | null) => {
      style.cssText = value ?? '';
      style.removeProperty('translate');
      style.removeProperty('transform');
      return style.cssText;
    };
    const canvasStyle = withoutVisualOffset(canvas.getAttribute('style'));
    let geometryMutations = 0;
    const checkMutations = (records: MutationRecord[]) => {
      for (const record of records) {
        if (record.target !== canvas || withoutVisualOffset(record.oldValue) !== canvasStyle) geometryMutations++;
      }
    };
    const observer = new MutationObserver(checkMutations);
    observer.observe(plane, { attributeFilter: ['style'] });
    observer.observe(canvas, { attributeFilter: ['style'], attributeOldValue: true });
    observer.observe(element, { attributeFilter: ['data-desk-zoom'] });
    try {
      const before = snapshot();
      // Deliver high-frequency device samples without allowing a paint between them.
      for (let index = 1; index <= 96; index++) {
        element.dispatchEvent(new PointerEvent('pointermove', {
          pointerType: 'mouse', pointerId: pointer.id, isPrimary: true, buttons: 2, bubbles: true,
          clientX: start.x + Math.round(delta.x * index / 96),
          clientY: start.y + Math.round(delta.y * index / 96),
        }));
      }
      const beforePaint = snapshot();
      await new Promise<void>(resolve => { requestAnimationFrame(() => resolve()); });
      const afterPaint = snapshot();
      // Finish the gesture before the frame scheduled by its last move can run.
      element.dispatchEvent(new PointerEvent('pointermove', {
        pointerType: 'mouse', pointerId: pointer.id, isPrimary: true, buttons: 2, bubbles: true,
        clientX: start.x + final.x - 1, clientY: start.y + final.y,
      }));
      element.dispatchEvent(new PointerEvent('pointerup', {
        pointerType: 'mouse', pointerId: pointer.id, isPrimary: true, button: 2, bubbles: true,
        clientX: start.x + final.x, clientY: start.y + final.y,
      }));
      checkMutations(observer.takeRecords());
      const canvasGeometryChanged = withoutVisualOffset(canvas.getAttribute('style')) !== canvasStyle;
      return { before, beforePaint, afterPaint, released: snapshot(), cell, geometryMutations, canvasGeometryChanged };
    } finally {
      observer.disconnect();
    }
  }, { pointer: pointerId, start, delta, final });
  await page.mouse.up({ button: 'right' });
  await pointerId.dispose();

  expect(result.beforePaint).toEqual(result.before);
  const { before, afterPaint, released } = result;
  expect(afterPaint.visible).toEqual({ left: before.visible.left + delta.x, top: before.visible.top + delta.y });
  expect(afterPaint.scroll).toEqual(before.scroll);
  expect([afterPaint.translate, afterPaint.transform]).not.toEqual([before.translate, before.transform]);
  expect(released.visible).toEqual({ left: before.visible.left + final.x, top: before.visible.top + final.y });
  expect(released.scroll).toEqual({ left: before.scroll.left - final.x, top: before.scroll.top - final.y });
  expect([released.translate, released.transform]).toEqual([before.translate, before.transform]);
  const phase = (offset: number) => ((offset % result.cell) + result.cell) % result.cell;
  expect(result.cell).toBeCloseTo(32 * 1.1);
  expect(afterPaint.grid.left).toBeCloseTo(phase(before.grid.left + delta.x));
  expect(afterPaint.grid.top).toBeCloseTo(phase(before.grid.top + delta.y));
  expect(released.grid.left).toBeCloseTo(phase(afterPaint.grid.left + final.x - delta.x));
  expect(released.grid.top).toBeCloseTo(phase(afterPaint.grid.top + final.y - delta.y));
  expect(result.geometryMutations).toBe(0);
  expect(result.canvasGeometryChanged).toBe(false);
  await expect(viewport).not.toHaveAttribute('data-panning');
});

test('Desk applies the latest widget drag per frame and saves the exact release position', async ({ page }) => {
  const initial = { left: 418, top: 116, width: 412, height: 366 };
  const profile = encodeURIComponent('profile:a11-gpu');
  const widgetKey = `rdf-session-desk-widget-v1:u1:${profile}:logs`;
  await page.setViewportSize({ width: 1536, height: 950 });
  await page.addInitScript(({ initial, profile, widgetKey }) => {
    localStorage.setItem('rdf-session-default-view:u1', 'desk');
    localStorage.setItem(`rdf-session-floating-v3:u1:${profile}:initial:base`, JSON.stringify({
      front: 'tools',
      windows: {
        device: { left: 40, top: 490, width: 260, height: 390 },
        tools: { left: 970, top: 560, width: 400, height: 360 },
      },
    }));
    localStorage.setItem(widgetKey, JSON.stringify(initial));
  }, { initial, profile, widgetKey });
  await page.goto('/#/session/' + sessionId);
  const viewport = page.locator('.session-layout .workspace-grid[data-desk]');
  await expect(viewport).toHaveAttribute('data-desk-zoom', '1');
  const handle = viewport.locator('button[data-window-move="widget:logs"]');
  await expect(handle).toBeVisible();
  const box = (await handle.boundingBox())!;
  const start = { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
  const delta = { x: 96, y: 57 };
  const final = { x: 114, y: 43 };
  const pointerId = await viewport.evaluateHandle(element => {
    const pointer = { id: -1 };
    element.addEventListener('pointerdown', event => { pointer.id = event.pointerId; }, { capture: true, once: true });
    return pointer;
  });
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await expect(viewport).toHaveAttribute('data-window-drag', 'move');

  const result = await viewport.evaluate(async (element, { pointer, start, delta, final, widgetKey }) => {
    const widget = element.querySelector<HTMLElement>('[data-window="widget:logs"]')!;
    const snapshot = () => ({
      displayed: { left: parseFloat(widget.style.left), top: parseFloat(widget.style.top) },
      saved: JSON.parse(window.localStorage.getItem(widgetKey) ?? 'null'),
    });
    const send = (type: 'pointermove' | 'pointerup', x: number, y: number) => {
      element.dispatchEvent(new PointerEvent(type, {
        pointerType: 'mouse', pointerId: pointer.id, isPrimary: true, buttons: type === 'pointermove' ? 1 : 0,
        bubbles: true, clientX: start.x + x, clientY: start.y + y,
      }));
    };

    for (let index = 1; index <= 96; index++) {
      send('pointermove', Math.round(delta.x * index / 96), Math.round(delta.y * index / 96));
    }
    const beforePaint = snapshot();
    await new Promise<void>(resolve => { requestAnimationFrame(() => resolve()); });
    const afterPaint = snapshot();
    send('pointermove', final.x - 2, final.y + 3);
    const beforeRelease = snapshot();
    send('pointerup', final.x, final.y);
    return { beforePaint, afterPaint, beforeRelease, released: snapshot() };
  }, { pointer: pointerId, start, delta, final, widgetKey });
  await page.mouse.up();
  await pointerId.dispose();

  const expected = ({ x, y }: typeof delta) => {
    const displayed = { left: initial.left + x, top: initial.top + y };
    return { displayed, saved: { ...initial, ...displayed } };
  };
  expect(result.beforePaint).toEqual(expected({ x: 0, y: 0 }));
  expect(result.afterPaint).toEqual(expected(delta));
  expect(result.beforeRelease).toEqual(expected(delta));
  expect(result.released).toEqual(expected(final));
  await expect(viewport).not.toHaveAttribute('data-window-drag');
});
