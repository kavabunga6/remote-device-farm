import { expect, test, type Page } from '@playwright/test';

const sessionId = 'cbd55091-aaaa-bbbb-cccc-000000000001';
const pcmConfig = { type: 'audio-config', codec: 'pcm-s16le', sampleRate: 48000, channels: 2 };
const silentFrame = { type: 'audio-frame', data: 'AAAAAA==' };
const pcmFrame = { type: 'audio-frame', data: 'AEAAwA==' };

async function mediaFixture(page: Page, options: { audioEnabled?: boolean; suspended?: boolean } = {}) {
  let audioEnabled = options.audioEnabled ?? true;
  let session: Record<string, unknown> | undefined;
  const toggles: boolean[] = [];
  const rotations: string[] = [];
  await page.clock.install();
  await page.addInitScript(({ suspended }) => {
    const target = window as any;
    const NativeSocket = window.WebSocket;
    target.__mediaSockets = [];
    target.__audioPlayed = 0;
    target.__audioStopped = 0;
    class MediaSocket {
      static OPEN = 1; static CONNECTING = 0; static CLOSED = 3; static CLOSING = 2;
      readyState = 0;
      onopen: ((event: object) => void) | null = null;
      onmessage: ((event: { data: string }) => void) | null = null;
      onclose: ((event: object) => void) | null = null;
      onerror = null;
      constructor() { target.__mediaSockets.push(this); }
      send(raw: string) { const message = JSON.parse(raw); if (message.type === 'ping') queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ type: 'pong', id: message.id, serverTime: Date.now() }) })); }
      close() { this.readyState = 3; this.onclose?.({}); }
      addEventListener() {}
      removeEventListener() {}
    }
    const ControlledSocket = function (url: string, protocols?: string | string[]) {
      return /\/api\/sessions\/.+\/stream/.test(String(url)) ? new MediaSocket() : new NativeSocket(url, protocols);
    };
    Object.assign(ControlledSocket, { OPEN: 1, CONNECTING: 0, CLOSED: 3, CLOSING: 2 });
    // The development mock also installs a WebSocket constructor. Keep our event-controlled
    // socket for this regression, while real Vite/HMR sockets continue to work.
    Object.defineProperty(window, 'WebSocket', { configurable: true, get: () => ControlledSocket, set: () => {} });
    target.__openMedia = () => {
      const socket = target.__mediaSockets.at(-1);
      socket.readyState = 1; socket.onopen?.({});
      socket.onmessage?.({ data: JSON.stringify({ type: 'ready', inputEpoch: 'media-test', serverTime: Date.now(), inputMaxAgeMs: 1500 }) });
    };
    target.__sendMedia = (message: object) => target.__mediaSockets.at(-1).onmessage?.({ data: JSON.stringify(message) });
    target.__closeMedia = () => target.__mediaSockets.at(-1).close();
    class TestAudioContext {
      state = suspended ? 'suspended' : 'running';
      currentTime = 0;
      destination = {};
      createBuffer(_channels: number, frames: number, rate: number) { return { duration: frames / rate, copyToChannel() {} }; }
      createBufferSource() {
        return { buffer: null, connect() {}, disconnect() {}, start() { target.__audioPlayed += 1; }, stop() { target.__audioStopped += 1; } };
      }
      async resume() { this.state = 'running'; }
      async close() { this.state = 'closed'; }
    }
    target.AudioContext = TestAudioContext;
    target.VideoDecoder = class {
      state = 'unconfigured';
      decodeQueueSize = 0;
      callbacks: { output: (frame: VideoFrame) => void };
      constructor(callbacks: { output: (frame: VideoFrame) => void }) { this.callbacks = callbacks; }
      configure() { this.state = 'configured'; }
      close() { this.state = 'closed'; }
      reset() { this.state = 'unconfigured'; }
      decode() {
        const canvas = document.createElement('canvas');
        canvas.width = 720; canvas.height = 1280;
        this.callbacks.output(new VideoFrame(canvas, { timestamp: 0 }));
      }
    };
  }, { suspended: options.suspended ?? false });
  await page.route('**/api/me/notifications', route => route.fulfill({ json: { notifications: [] } }));
  await page.route('**/api/sessions/' + sessionId, async route => {
    const response = await route.fetch();
    const data = await response.json();
    session = { ...data.session, audioEnabled, idleExpiresAt: new Date(Date.now() + 3600000).toISOString() };
    await route.fulfill({ response, json: { session } });
  });
  await page.route('**/api/sessions/' + sessionId + '/audio', async route => {
    audioEnabled = route.request().postDataJSON().enabled;
    toggles.push(audioEnabled);
    session = { ...session, audioEnabled };
    await route.fulfill({ json: { session } });
  });
  await page.route('**/api/sessions/' + sessionId + '/rotate', async route => {
    const { orientation } = route.request().postDataJSON();
    rotations.push(orientation);
    session = { ...session, orientation };
    await route.fulfill({ json: { session } });
  });
  await page.goto('/#/session/' + sessionId);
  await expect(page.getByRole('group', { name: 'Состояние трансляции' })).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as any).__mediaSockets.length)).toBeGreaterThan(0);
  return { toggles, rotations };
}

async function openMedia(page: Page) { await page.evaluate(() => (window as any).__openMedia()); }
async function sendMedia(page: Page, message: object) { await page.evaluate(value => (window as any).__sendMedia(value), message); }

async function sendImage(page: Page, mime: 'image/jpeg' | 'image/png', width = 720, height = 1280) {
  await page.evaluate(({ type, width, height }) => {
    const canvas = document.createElement('canvas');
    canvas.width = width; canvas.height = height;
    const data = canvas.toDataURL(type).split(',')[1];
    (window as any).__sendMedia({ type: 'frame', mime: type, width, height, data });
  }, { type: mime, width, height });
}

test('device controls stay in one left column as phone, tablet, and TV frames change', async ({ page }, info) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  const { rotations } = await mediaFixture(page, { audioEnabled: false });
  await openMedia(page);
  const controls = page.getByRole('group', { name: 'Управление устройством' });
  const rotate = controls.getByRole('button', { name: 'Повернуть экран' });
  const checkFrame = async (width: number, height: number) => {
    await sendImage(page, 'image/jpeg', width, height);
    await expect(rotate).toHaveAttribute('aria-pressed', String(width > height));
    await expect.poll(() => controls.evaluate(element => {
      const rail = element.getBoundingClientRect();
      const frame = element.parentElement!.querySelector('.device-screen')!.getBoundingClientRect();
      return { ratio: frame.width / frame.height, left: rail.right <= frame.left, viewport: document.documentElement.scrollWidth <= innerWidth + 1 };
    })).toEqual({ ratio: expect.closeTo(width / height, 2), left: true, viewport: true });
  };
  await checkFrame(720, 1280);
  await rotate.click();
  await expect.poll(() => rotations).toEqual(['landscape']);
  await checkFrame(2560, 1600);
  await page.getByRole('button', { name: 'Свернуть боковое меню' }).click();
  await page.getByRole('group', { name: 'Компоновка сессии' }).getByRole('button', { name: 'Экран', exact: true }).click();
  await checkFrame(1920, 1080);
  const buttons = await controls.getByRole('button').evaluateAll(nodes => nodes.map(node => {
    const button = node.getBoundingClientRect(), icon = node.querySelector('svg')!.getBoundingClientRect();
    return [button.x, button.y, button.width, button.height, icon.width, icon.height];
  }));
  for (const [index, [x, y, width, height, iconWidth, iconHeight]] of buttons.entries()) {
    expect(x).toBe(buttons[0]![0]);
    if (index) expect(y).toBeGreaterThan(buttons[index - 1]![1]);
    expect([width, height, iconWidth, iconHeight]).toEqual([40, 40, 20, 20]);
  }
  await page.screenshot({ path: info.outputPath('landscape-tv.png') });
  await page.setViewportSize({ width: 780, height: 420 });
  await checkFrame(1920, 1080);
  const last = controls.getByRole('button').last();
  await last.focus();
  await expect(last).toBeInViewport();
  await expect.poll(() => controls.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
  await rotate.click();
  await expect.poll(() => rotations).toEqual(['landscape', 'portrait']);
  await checkFrame(1600, 2560);
});

test('transport status follows received frames and disconnect rather than the configured protocol', async ({ page }) => {
  await mediaFixture(page, { audioEnabled: false });
  const video = page.locator('[data-media="video"]');
  await expect(video).toHaveText('Видео: подключение');
  await expect(video.locator('.activity-indicator')).toHaveCount(1);
  await openMedia(page);
  await expect(video).toHaveText('Видео: подключение');
  await sendImage(page, 'image/jpeg');
  await expect(video).toHaveText('MJPEG');
  await sendImage(page, 'image/png');
  await expect(video).toHaveText('Кадры');
  await sendMedia(page, { type: 'video-config', data: 'AAAAAWdCAAk=' });
  await expect(video).toHaveText('Видео: подключение');
  await sendMedia(page, { type: 'video-frame', keyframe: true, timestamp: 0, data: 'AA==' });
  await expect(video).toHaveText('scrcpy');
  await expect(video).toHaveAttribute('data-state', 'live');
  await expect(video.locator('.activity-indicator')).toHaveCount(0);
  await video.click();
  const popover = page.locator('.session-transport-popover');
  await expect(popover.getByRole('status')).toHaveText('Новых кадров пока нет.');
  await expect(popover.getByRole('button', { name: 'Подключиться снова' })).toBeVisible();
  await page.evaluate(() => (window as any).__closeMedia());
  await expect(video).toHaveText('Видео: нет связи');
});

test('audio distinguishes silence from a signal and the transmission toggle is independent of Android volume', async ({ page }) => {
  const { toggles } = await mediaFixture(page);
  const audio = page.locator('[data-media="audio"]');
  const headphones = page.locator('.device-audio');
  await expect(audio).toHaveText('Звук: подключение');
  await expect(audio.locator('.activity-indicator')).toHaveCount(1);
  await openMedia(page);
  await expect(audio).toHaveText('Звук: ожидание');
  await expect(audio.locator('.activity-indicator')).toHaveCount(0);
  await sendMedia(page, pcmConfig);
  await expect(audio).toHaveText('Звук: ожидание');
  await expect(headphones).toHaveAttribute('data-state', 'waiting');
  await sendMedia(page, silentFrame);
  await expect(audio).toHaveText('Звук: тишина');
  await expect(headphones).toHaveAttribute('data-state', 'silent');
  await expect(audio).toHaveAttribute('title', /в потоке тишина/);
  await sendMedia(page, pcmFrame);
  await expect(audio).toHaveText('Звук: приём');
  await expect(headphones).toHaveAttribute('data-state', 'receiving');
  await expect(headphones).toHaveCSS('color', 'rgb(138, 241, 200)');
  await expect(audio).toHaveAttribute('title', /Поток может содержать тишину/);
  expect(await page.evaluate(() => (window as any).__audioPlayed)).toBe(2);
  await page.clock.runFor(800);
  await sendMedia(page, silentFrame);
  await expect(audio).toHaveText('Звук: приём');
  await page.clock.runFor(800);
  await sendMedia(page, silentFrame);
  await expect(audio).toHaveText('Звук: тишина');
  await page.clock.runFor(1600);
  await expect(audio).toHaveText('Звук: ожидание');
  await sendMedia(page, pcmFrame);
  await expect(audio).toHaveText('Звук: приём');
  const stoppedBefore = await page.evaluate(() => (window as any).__audioStopped);
  await page.getByRole('button', { name: 'Выключить звук трансляции', exact: true }).click();
  await expect(audio).toHaveText('Звук выкл.');
  expect(await page.evaluate(() => (window as any).__audioStopped)).toBeGreaterThan(stoppedBefore);
  expect(toggles).toEqual([false]);
  await sendMedia(page, pcmFrame);
  expect(await page.evaluate(() => (window as any).__audioPlayed)).toBe(5);
  await page.getByRole('button', { name: 'Включить звук трансляции', exact: true }).click();
  await expect(audio).toHaveText('Звук: ожидание');
  expect(toggles).toEqual([false, true]);
});

test('scrcpy Opus audio distinguishes silence, a synthetic tone, and late packets', async ({ page }) => {
  await mediaFixture(page);
  await openMedia(page);
  const stream = await page.evaluate(async () => {
    const frames: Array<{ type: string; data: string; timestamp: number }> = [];
    let config = '';
    const base64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
    const encoder = new AudioEncoder({
      output(chunk, metadata) {
        if (metadata?.decoderConfig?.description) config = base64(new Uint8Array(metadata.decoderConfig.description as ArrayBuffer));
        const bytes = new Uint8Array(chunk.byteLength);
        chunk.copyTo(bytes);
        frames.push({ type: 'audio-frame', data: base64(bytes), timestamp: chunk.timestamp });
      },
      error(error) { throw error; },
    });
    try {
      encoder.configure({ codec: 'opus', sampleRate: 48000, numberOfChannels: 1, bitrate: 64000 });
      for (let index = 0; index < 10; index++) {
        const samples = new Float32Array(960);
        if (index >= 5) for (let frame = 0; frame < samples.length; frame++) {
          samples[frame] = 0.3 * Math.sin(frame * 2 * Math.PI * 500 / 48000);
        }
        const audio = new AudioData({
          format: 'f32', sampleRate: 48000, numberOfFrames: samples.length,
          numberOfChannels: 1, timestamp: index * 20_000, data: samples,
        });
        encoder.encode(audio);
        audio.close();
      }
      await encoder.flush();
      return { config, frames };
    } finally { encoder.close(); }
  });
  expect(stream.config).toBeTruthy();
  const badge = page.locator('[data-media="audio"]');
  await sendMedia(page, { type: 'audio-config', codec: 'opus', sampleRate: 48000, channels: 1, data: stream.config });
  for (const frame of stream.frames.filter(frame => frame.timestamp < 80_000)) await sendMedia(page, frame);
  await expect(badge).toHaveText('Звук: тишина');
  for (const frame of stream.frames.filter(frame => frame.timestamp >= 80_000)) await sendMedia(page, frame);
  await expect(badge).toHaveText('Звук: приём');
  const last = stream.frames.at(-1)!;
  await page.clock.runFor(6000);
  await expect(badge).toHaveText('Звук: ожидание');
  const played = () => page.evaluate(() => (window as any).__audioPlayed as number);
  const previous = await played();
  await sendMedia(page, { ...last, timestamp: last.timestamp + 20_000 });
  await sendMedia(page, { ...last, timestamp: last.timestamp + 6_020_000 });
  await expect(badge).toHaveText('Звук: приём');
  await expect.poll(played).toBe(previous + 1);
});

test('audio skips a six-second backlog and resumes with fresh frames', async ({ page }) => {
  await mediaFixture(page);
  await openMedia(page);
  await sendMedia(page, pcmConfig);
  const counters = () => page.evaluate(() => {
    const fixture = window as unknown as { __audioPlayed: number; __audioStopped: number };
    return [fixture.__audioPlayed, fixture.__audioStopped];
  });
  const start = 20_000_000;
  await sendMedia(page, { ...pcmFrame, timestamp: start });
  await expect.poll(counters).toEqual([1, 0]);

  await page.clock.runFor(6000);
  await sendMedia(page, { ...pcmFrame, timestamp: start + 20_000 });
  await expect.poll(counters).toEqual([1, 1]);
  await sendMedia(page, pcmConfig);
  await sendMedia(page, { ...pcmFrame, timestamp: start + 40_000 });
  await expect.poll(counters).toEqual([1, 1]);

  await sendMedia(page, { ...pcmFrame, timestamp: start + 6_000_000 });
  await expect.poll(counters).toEqual([2, 1]);
  await page.evaluate(() => (window as any).__closeMedia());
  await expect.poll(counters).toEqual([2, 2]);
});

test('browser permission and unavailable audio are visible without falsely claiming reception', async ({ page }) => {
  const { toggles } = await mediaFixture(page, { suspended: true });
  const audio = page.locator('[data-media="audio"]');
  await openMedia(page);
  await sendMedia(page, pcmConfig);
  await sendMedia(page, pcmFrame);
  await expect(audio).toHaveText('Разрешить звук');
  expect(await page.evaluate(() => (window as any).__audioPlayed)).toBe(0);
  await page.getByRole('button', { name: 'Разрешить звук трансляции в браузере', exact: true }).click();
  await expect(audio).toHaveText('Звук: ожидание');
  expect(toggles).toEqual([]);
  await sendMedia(page, pcmFrame);
  await expect(audio).toHaveText('Звук: приём');
  await sendMedia(page, { type: 'audio-unavailable' });
  await expect(audio).toHaveText('Звук недоступен');
  await expect(audio).toHaveAttribute('title', /Аудио недоступно для этого устройства/);
  await page.getByRole('button', { name: 'Выключить звук трансляции', exact: true }).click();
  await expect(audio).toHaveText('Звук выкл.');
  expect(toggles).toEqual([false]);
});


for (const gesture of ['pointer', 'keyboard'] as const) {
  test('ordinary '+gesture+' interaction resumes blocked sound without a second permission button', async ({ page }) => {
    const { toggles } = await mediaFixture(page, { suspended: true });
    await openMedia(page); await sendMedia(page, pcmConfig); await sendMedia(page, pcmFrame);
    await expect(page.locator('[data-media="audio"]')).toHaveText('Разрешить звук');
    if (gesture === 'pointer') await page.getByRole('heading', { name: 'Консоль устройства' }).click();
    else await page.keyboard.press('Tab');
    await expect(page.locator('[data-media="audio"]')).toHaveText('Звук: ожидание');
    await sendMedia(page, pcmFrame);
    await expect(page.locator('[data-media="audio"]')).toHaveText('Звук: приём');
    expect(toggles).toEqual([]);
    await expect(page.locator('.audio-notice')).toHaveCount(0);
  });
}
