import { expect, test, type Page } from '@playwright/test';
import { inspectCapture } from './support/capture-pixels';

const sessionId = 'cbd55091-aaaa-bbbb-cccc-000000000001';
const codec = { type: 'video-config', data: 'AAAAAWdCAAk=' };

// Extra trace screenshots compete with the renderer that supplies the real recording.
// Keep DOM traces and the downloaded media as the visual evidence.
test.use({ trace: { mode: 'retain-on-failure', screenshots: false } });

async function nextPaint(page: Page) {
  await page.evaluate(() => new Promise<void>(resolve => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
}

type FixtureOptions = { landscape?: boolean; native?: boolean; failReads?: number };
async function fixture(page: Page, options: FixtureOptions = {}) {
  const cpuRate = Number(process.env.CAPTURE_CPU_THROTTLE || 1);
  if (!Number.isFinite(cpuRate) || cpuRate < 1 || cpuRate > 8) throw new Error('Invalid capture CPU rate');
  if (cpuRate !== 1) {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpuRate });
  }
  let reads = 0;
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.addInitScript(({ landscape, native }) => {
    const target = window as any;
    const RealSocket = window.WebSocket;
    target.__sentInputs = [];
    target.__sourceNative = native;
    const source = () => {
      const canvas = document.createElement('canvas');
      canvas.width = landscape ? 1280 : 720; canvas.height = landscape ? 720 : 1280;
      const context = canvas.getContext('2d')!;
      context.fillStyle = '#161c22'; context.fillRect(0, 0, canvas.width, canvas.height);
      if (target.__sourceNative) {
        context.fillStyle = '#fff'; context.beginPath(); context.arc(canvas.width * .2, canvas.height * .3, 16, 0, Math.PI * 2); context.fill();
      }
      return canvas;
    };
    class Socket {
      readyState = 0;
      onopen: ((event: object) => void) | null = null;
      onmessage: ((event: { data: string }) => void) | null = null;
      onclose = null;
      onerror = null;
      constructor() {
        target.__touchSocket = this;
        setTimeout(() => {
          if (this.readyState === 3) return;
          this.readyState = 1; this.onopen?.({});
          this.onmessage?.({ data: JSON.stringify({ type: 'ready', inputEpoch: 'touch-test', serverTime: Date.now(), inputMaxAgeMs: 1500 }) });
          const canvas = source();
          this.onmessage?.({ data: JSON.stringify({ type: 'frame', nativeTouches: native, mime: 'image/png', width: canvas.width, height: canvas.height, data: canvas.toDataURL().split(',')[1] }) });
        }, 0);
      }
      send(payload: string) { const message = JSON.parse(payload); if (message.type === 'ping') queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ type: 'pong', id: message.id, serverTime: Date.now() }) })); else target.__sentInputs.push(message); }
      close() { this.readyState = 3; }
    }
    const ControlledSocket = function(url: string, protocols?: string | string[]) {
      return /\/api\/sessions\/.+\/stream/.test(String(url)) ? new Socket() : new RealSocket(url, protocols);
    };
    Object.assign(ControlledSocket, { OPEN: 1, CONNECTING: 0, CLOSED: 3, CLOSING: 2 });
    Object.defineProperty(window, 'WebSocket', { configurable: true, get: () => ControlledSocket, set: () => {} });
    target.__sendTouchMessage = (message: object) => target.__touchSocket.onmessage?.({ data: JSON.stringify(message) });
    target.VideoDecoder = class {
      state = 'unconfigured'; decodeQueueSize = 0;
      callbacks: { output: (frame: VideoFrame) => void };
      constructor(callbacks: { output: (frame: VideoFrame) => void }) { this.callbacks = callbacks; }
      configure() { this.state = 'configured'; }
      close() { this.state = 'closed'; }
      reset() { this.state = 'unconfigured'; }
      decode() { this.callbacks.output(new VideoFrame(source(), { timestamp: 0 })); }
    };
  }, { landscape: options.landscape ?? false, native: options.native ?? false });
  await page.route('**/api/me/notifications', route => route.fulfill({ json: { notifications: [] } }));
  await page.route('**/api/sessions/' + sessionId + '/env', route => {
    if (++reads <= (options.failReads ?? 0)) return route.fulfill({ status: 503, json: { error: 'temporarily_unavailable' } });
    return route.fulfill({ json: { env: {
      darkMode: 'no', fontScale: 1, animations: true, showTouches: true, pointerLocation: false, timezone: 'UTC',
      size: { physical: options.landscape ? '1280x720' : '720x1280', override: null }, density: { physical: 320, override: null }, battery: { level: 100, charging: 'ac' },
    } } });
  });
  await page.goto('/#/session/' + sessionId);
  await expect(page.locator('[data-media=video]')).toHaveAttribute('data-state', 'live');
  await expect.poll(() => reads).toBeGreaterThan(0);
  await expect(page.getByRole('button', { name: 'Начать запись экрана без звука', exact: true })).toBeEnabled();
  return { reads: () => reads };
}
async function send(page: Page, message: object) { await page.evaluate(value => (window as any).__sendTouchMessage(value), message); }

for (const landscape of [false, true]) {
  test(`fallback tap and drag are encoded in real PNG and WebM with ${landscape ? 'landscape' : 'portrait'} letterboxing`, async ({ page }, testInfo) => {
    test.setTimeout(60_000); // Decode the complete short recording at full resolution.
    await fixture(page, { landscape });
    const touch = page.getByRole('application', { name: 'Сенсорный экран устройства' });
    const marker = touch.locator('.session-touch-marker');
    await page.evaluate(() => document.fonts.ready);
    const position = async (x: number, y: number) => {
      const box = (await touch.boundingBox())!;
      return { x: box.x + box.width * x, y: box.y + box.height * y };
    };
    await page.getByRole('button', { name: 'Начать запись экрана без звука', exact: true }).click();
    await page.waitForTimeout(200);
    await nextPaint(page);
    let point = await position(.25, .3);
    const pngDownload = page.waitForEvent('download');
    await page.evaluate(() => {
      // Capture the real tap in its release event, after React has updated the marker.
      // Playwright/CI round trips can exceed the marker's 180 ms lifetime. Keep the
      // browser clock, actual input, capture button and PNG encoder unmodified.
      window.addEventListener('pointerup', () => {
        const marker = document.querySelector<HTMLElement>('.session-touch-marker')!;
        (window as any).__tapCapture = {
          visible: !marker.hidden,
        };
        document.querySelector<HTMLButtonElement>('[aria-label="Скачать PNG-снимок экрана устройства"]')!.click();
      }, { once: true });
    });
    await page.mouse.click(point.x, point.y);
    await (await pngDownload).saveAs(testInfo.outputPath('tap.png'));
    const tap = await page.evaluate(() => (window as any).__tapCapture);
    expect(tap.visible).toBe(true);
    const png = await inspectCapture(testInfo.outputPath('tap.png'), 'image/png', [0], landscape);
    expect(png.samples[0].count).toBeGreaterThan(100);
    expect(png.samples[0].x).toBeCloseTo(.25, 2); expect(png.samples[0].y).toBeCloseTo(.3, 2);
    await page.waitForTimeout(220);
    await expect(marker).toBeHidden();
    // Keep a clear interval in the real capture stream between gestures.
    await page.waitForTimeout(350);
    await nextPaint(page);
    point = await position(.3, .4); await page.mouse.move(point.x, point.y); await page.mouse.down();
    await page.waitForTimeout(250);
    await nextPaint(page);
    point = await position(.7, .6); await page.mouse.move(point.x, point.y, { steps: 5 });
    await page.waitForTimeout(250);
    await nextPaint(page);
    await page.mouse.up();
    // Stop as soon as the marker clears: finalization must encode the new frame
    // without relying on an extra delay in the caller.
    await expect(marker).toBeHidden();
    const webmDownload = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Остановить запись экрана', exact: true }).click();
    await (await webmDownload).saveAs(testInfo.outputPath('touches.webm'));
    const webm = await inspectCapture(testInfo.outputPath('touches.webm'), 'video/webm', 'timeline', landscape);
    await testInfo.attach('decoded-pixel-results', { body: JSON.stringify({ png, webm }), contentType: 'application/json' });
    expect(webm.samples[0].count).toBe(0);
    const assertTouch = (index: number, x: number, y: number) => {
      expect(index, `Encoded touch at ${x}, ${y}`).toBeGreaterThanOrEqual(0);
      expect(webm.samples[index].count).toBeGreaterThan(100);
      expect(webm.samples[index].x).toBeCloseTo(x, 2); expect(webm.samples[index].y).toBeCloseTo(y, 2);
    };
    // Require the actual encoded sequence: clear, tap, clear, drag start, move, clear.
    // A missing tap cannot pass by matching a later drag at a different location.
    const tapIndex = webm.samples.findIndex(sample => sample.count > 100);
    assertTouch(tapIndex, .25, .3);
    const gapIndex = webm.samples.findIndex((sample, index) => index > tapIndex && sample.count === 0);
    expect(gapIndex, 'Tap disappears before the next gesture').toBeGreaterThan(tapIndex);
    const dragIndex = webm.samples.findIndex((sample, index) => index > gapIndex && sample.count > 100);
    assertTouch(dragIndex, .3, .4);
    const moveIndex = webm.samples.findIndex((sample, index) => index > dragIndex && sample.count > 100 &&
      sample.x !== null && sample.y !== null && Math.abs(sample.x - .7) < .005 && Math.abs(sample.y - .6) < .005);
    assertTouch(moveIndex, .7, .6);
    const clearIndex = webm.samples.findIndex((sample, index) => index > moveIndex && sample.count === 0);
    expect(clearIndex, 'Released drag disappears from the recording').toBeGreaterThan(moveIndex);
    expect(webm.samples.at(-1)!.count).toBe(0);
  });
}

test('native capability changes on identical video config suppress doubled overlays in real recording', async ({ page }, testInfo) => {
  await fixture(page);
  await send(page, { ...codec, nativeTouches: false });
  await send(page, { type: 'video-frame', keyframe: true, data: 'AA==' });
  const touch = page.getByRole('application', { name: 'Сенсорный экран устройства' });
  const marker = touch.locator('.session-touch-marker');
  const box = (await touch.boundingBox())!;
  await page.mouse.move(box.x + box.width * .75, box.y + box.height * .6); await page.mouse.down();
  await expect(marker).toBeVisible();
  await page.evaluate(() => { (window as any).__sourceNative = true; });
  await send(page, { ...codec, nativeTouches: true }); // Identical SPS/PPS must still update this capability.
  await expect(marker).toBeHidden();
  await send(page, { type: 'video-frame', keyframe: true, data: 'AA==' });
  await page.mouse.up();
  await page.getByRole('button', { name: 'Начать запись экрана без звука', exact: true }).click();
  await page.mouse.move(box.x + box.width * .75, box.y + box.height * .6); await page.mouse.down();
  await expect(marker).toBeHidden(); await page.waitForTimeout(400); await page.mouse.up();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Остановить запись экрана', exact: true }).click();
  await (await download).saveAs(testInfo.outputPath('native-touch.webm'));
  const result = await inspectCapture(testInfo.outputPath('native-touch.webm'), 'video/webm', [.15, .3], false);
  for (const sample of result.samples) {
    expect(sample.count).toBeGreaterThan(100); expect(sample.green).toBe(0);
    expect(sample.x).toBeCloseTo(.2, 2); expect(sample.y).toBeCloseTo(.3, 2);
  }
  await send(page, { ...codec }); // Old agents omit nativeTouches and use the fallback.
  await page.mouse.move(box.x + box.width * .75, box.y + box.height * .6);
  await page.mouse.down(); await expect(marker).toBeVisible();
  await touch.dispatchEvent('lostpointercapture', { pointerId: 1 });
  await expect(marker).toBeHidden();
  expect(await page.evaluate(() => (window as any).__sentInputs.at(-1))).toMatchObject({ type: 'input', kind: 'touch', action: 'up' });
  await page.mouse.up();
});

test('initial touch preference read recovers a transient failure without notifications', async ({ page }) => {
  const state = await fixture(page, { failReads: 1 });
  await expect.poll(state.reads).toBe(2);
  const touch = page.getByRole('application', { name: 'Сенсорный экран устройства' });
  const box = (await touch.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
  await expect(touch.locator('.session-touch-marker')).toBeVisible(); await page.mouse.up();
  await expect(page.getByText('Не удалось прочитать настройки устройства', { exact: true })).toHaveCount(0);
  await page.reload();
  await expect.poll(state.reads).toBe(3);
  await page.waitForTimeout(1200); expect(state.reads()).toBe(3);
});


test('initial touch preference loading stops after three failed reads', async ({ page }) => {
  const state = await fixture(page, { failReads: Infinity });
  await expect.poll(state.reads, { timeout: 7000 }).toBe(3);
  await page.waitForTimeout(1200);
  expect(state.reads()).toBe(3);
  await expect(page.getByText('Не удалось прочитать настройки устройства', { exact: true })).toHaveCount(0);
});
