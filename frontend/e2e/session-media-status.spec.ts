import { expect, test, type Page } from '@playwright/test';

const sessionId = 'cbd55091-aaaa-bbbb-cccc-000000000001';
const pcmConfig = { type: 'audio-config', codec: 'pcm-s16le', sampleRate: 48000, channels: 2 };
const pcmFrame = { type: 'audio-frame', data: 'AAAAAA==' }; // One silent stereo sample: receiving does not mean audible sound.

async function mediaFixture(page: Page, options: { audioEnabled?: boolean; suspended?: boolean } = {}) {
  let audioEnabled = options.audioEnabled ?? true;
  let session: Record<string, unknown> | undefined;
  const toggles: boolean[] = [];
  await page.clock.install();
  await page.addInitScript(({ suspended }) => {
    const target = window as any;
    const NativeSocket = window.WebSocket;
    target.__mediaSockets = [];
    target.__audioPlayed = 0;
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
      createBufferSource() { return { buffer: null, connect() {}, start() { target.__audioPlayed += 1; } }; }
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
  await page.goto('/#/session/' + sessionId);
  await expect(page.getByRole('group', { name: 'Состояние трансляции' })).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as any).__mediaSockets.length)).toBeGreaterThan(0);
  return { toggles };
}

async function openMedia(page: Page) { await page.evaluate(() => (window as any).__openMedia()); }
async function sendMedia(page: Page, message: object) { await page.evaluate(value => (window as any).__sendMedia(value), message); }

async function sendImage(page: Page, mime: 'image/jpeg' | 'image/png') {
  await page.evaluate(type => {
    const canvas = document.createElement('canvas');
    canvas.width = 720; canvas.height = 1280;
    const data = canvas.toDataURL(type).split(',')[1];
    (window as any).__sendMedia({ type: 'frame', mime: type, width: 720, height: 1280, data });
  }, mime);
}

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
  await page.evaluate(() => (window as any).__closeMedia());
  await expect(video).toHaveText('Видео: нет связи');
});

test('audio configuration waits for data, receiving expires, and transmission toggle is independent of Android volume', async ({ page }) => {
  const { toggles } = await mediaFixture(page);
  const audio = page.locator('[data-media="audio"]');
  await expect(audio).toHaveText('Звук: подключение');
  await expect(audio.locator('.activity-indicator')).toHaveCount(1);
  await openMedia(page);
  await expect(audio).toHaveText('Звук: ожидание');
  await expect(audio.locator('.activity-indicator')).toHaveCount(0);
  await sendMedia(page, pcmConfig);
  await expect(audio).toHaveText('Звук: ожидание');
  await sendMedia(page, pcmFrame);
  await expect(audio).toHaveText('Звук: приём');
  await expect(audio).toHaveAttribute('title', /Поток может содержать тишину/);
  expect(await page.evaluate(() => (window as any).__audioPlayed)).toBe(1);
  await page.clock.fastForward(1501);
  await expect(audio).toHaveText('Звук: ожидание');
  await sendMedia(page, pcmFrame);
  await expect(audio).toHaveText('Звук: приём');
  await page.getByRole('button', { name: 'Выключить звук трансляции', exact: true }).click();
  await expect(audio).toHaveText('Звук выкл.');
  expect(toggles).toEqual([false]);
  await sendMedia(page, pcmFrame);
  expect(await page.evaluate(() => (window as any).__audioPlayed)).toBe(2);
  await page.getByRole('button', { name: 'Включить звук трансляции', exact: true }).click();
  await expect(audio).toHaveText('Звук: ожидание');
  expect(toggles).toEqual([false, true]);
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
