import { expect, test, type Page } from '@playwright/test';

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
    target.__captures = [];
    target.__sentInputs = [];
    const objectUrl = URL.createObjectURL.bind(URL);
    URL.createObjectURL = value => {
      if (value instanceof Blob) target.__captures.push(value);
      return objectUrl(value);
    };
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

// Decode the actual downloaded PNG/WebM bytes with the browser codecs, then inspect pixels.
// Neither canvas captureStream nor MediaRecorder nor video decoding is mocked.
async function inspectCapture(page: Page, type: 'image/png' | 'video/webm', times: number[] | 'timeline', landscape: boolean) {
  return page.evaluate(async ({ type, times, landscape }) => {
    const blob = [...(window as any).__captures as Blob[]].reverse().find(value => value.type.startsWith(type));
    if (!blob) throw new Error('No real capture was downloaded');
    const canvas = document.createElement('canvas');
    let source: CanvasImageSource;
    let video: HTMLVideoElement | null = null;
    if (type === 'image/png') {
      const bitmap = await createImageBitmap(blob);
      canvas.width = bitmap.width; canvas.height = bitmap.height; source = bitmap;
    } else {
      video = document.createElement('video'); video.muted = true; video.preload = 'auto';
      const ready = new Promise<void>((resolve, reject) => { video!.onloadeddata = () => resolve(); video!.onerror = () => reject(new Error('WebM decode failed')); });
      video.src = URL.createObjectURL(blob); document.body.append(video); await ready;
      canvas.width = video.videoWidth; canvas.height = video.videoHeight; source = video;
    }
    const context = canvas.getContext('2d', { willReadFrequently: true })!;
    const frameWidth = type === 'video/webm' ? landscape ? 1280 : 720 : canvas.width;
    const frameHeight = type === 'video/webm' ? landscape ? 720 : 1280 : canvas.height;
    const left = (canvas.width - frameWidth) / 2, top = (canvas.height - frameHeight) / 2;
    const samples: { time: number; count: number; green: number; x: number | null; y: number | null }[] = [];
    const inspect = (time: number) => {
      context.drawImage(source, 0, 0);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let count = 0, green = 0, sumX = 0, sumY = 0;
      for (let i = 0; i < pixels.length; i += 4) {
        const r = pixels[i], g = pixels[i+1], b = pixels[i+2];
        const isGreen = g-r > 30 && g-b > 10 && g > 80;
        if (isGreen) green++;
        if (isGreen || r > 160 && g > 160 && b > 160) {
          count++; sumX += (i / 4) % canvas.width; sumY += Math.floor(i / 4 / canvas.width);
        }
      }
      samples.push({ time, count, green, x: count ? (sumX / count - left) / frameWidth : null, y: count ? (sumY / count - top) / frameHeight : null });
    };
    if (times === 'timeline') {
      if (!video) throw new Error('A video is required for timeline inspection');
      // Inspect presented frames of the real file. A completed seek can still
      // leave drawImage with the previous compositor frame on some platforms.
      const player = video; player.playbackRate = .5;
      await new Promise<void>((resolve, reject) => {
        let callback = 0;
        const timer = window.setTimeout(() => { player.cancelVideoFrameCallback(callback); player.pause(); reject(new Error('WebM playback timed out')); }, 15000);
        const frame: VideoFrameRequestCallback = (_now, metadata) => {
          inspect(metadata.mediaTime);
          callback = player.requestVideoFrameCallback(frame);
        };
        player.onended = () => {
          player.cancelVideoFrameCallback(callback);
          // Ended can precede the final compositor callback. Sample the actual
          // decoded last frame as well, after its texture has been presented.
          requestAnimationFrame(() => requestAnimationFrame(() => {
            try { inspect(player.currentTime); clearTimeout(timer); resolve(); }
            catch (error) { clearTimeout(timer); reject(error); }
          }));
        };
        player.onerror = () => { clearTimeout(timer); player.cancelVideoFrameCallback(callback); reject(new Error('WebM decode failed')); };
        callback = player.requestVideoFrameCallback(frame);
        void player.play().catch(reject);
      });
    } else {
      for (const time of times) {
        if (video) await new Promise<void>((resolve, reject) => {
          const timer = window.setTimeout(() => reject(new Error('WebM seek timed out')), 3000);
          video!.onseeked = () => { clearTimeout(timer); requestAnimationFrame(() => requestAnimationFrame(() => resolve())); };
          video!.currentTime = time;
        });
        inspect(time);
      }
    }
    video?.remove();
    return { mime: blob.type, bytes: blob.size, width: canvas.width, height: canvas.height, samples };
  }, { type, times, landscape });
}

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
    const png = await inspectCapture(page, 'image/png', [0], landscape);
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
    const webm = await inspectCapture(page, 'video/webm', 'timeline', landscape);
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
  const result = await inspectCapture(page, 'video/webm', [.15, .3], false);
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
