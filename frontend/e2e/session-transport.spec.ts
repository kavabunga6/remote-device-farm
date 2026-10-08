import { expect, test, type Page } from '@playwright/test';

const sessionId = 'cbd55091-aaaa-bbbb-cccc-000000000001';
async function transportFixture(page: Page, options: { rtc?: boolean } = {}) {
  const httpInputs: string[] = [];
  await page.route('**/api/sessions/*/input', route => { httpInputs.push(route.request().postData() || ''); return route.fulfill({ json: { ok: true } }); });
  await page.addInitScript(({ rtcAvailable }) => {
    const state = window as any;
    const RealSocket = window.WebSocket;
    const clockStart = Date.now(), monotonicStart = performance.now();
    const serverNow = () => clockStart + performance.now() - monotonicStart;
    state.__transport = { sockets: [], inputs: [], peers: [], allPeers: [], autoPong: true, dcAutoPong: true, lingerClose: false, online: true, frames: 0 };
    const NativePeer = window.RTCPeerConnection;
    window.RTCPeerConnection = class extends NativePeer { constructor(config?: RTCConfiguration) { super(config); state.__transport.allPeers.push(this); } };
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => state.__transport.online });
    const image = document.createElement('canvas'); image.width = 180; image.height = 320;
    image.getContext('2d')!.fillStyle = '#2244aa'; image.getContext('2d')!.fillRect(0, 0, 180, 320);
    const frame = { type: 'frame', mime: 'image/png', data: image.toDataURL().split(',')[1], width: 180, height: 320, nativeTouches: true };
    const gather = (peer: RTCPeerConnection) => new Promise<void>(resolve => {
      if (peer.iceGatheringState === 'complete') return resolve();
      peer.addEventListener('icegatheringstatechange', () => { if (peer.iceGatheringState === 'complete') resolve(); });
    });
    class SessionSocket {
      readyState = 0; bufferedAmount = 0; onopen: any; onmessage: any; onclose: any; onerror: any;
      epoch = 'ws-' + (state.__transport.sockets.length + 1);
      rtc = false; sent: any[] = []; timer: any;
      constructor(url: string) {
        this.rtc = url.includes('transport=webrtc'); state.__transport.sockets.push(this);
        setTimeout(() => {
          if (this.readyState !== 0) return;
          this.readyState = 1; this.onopen?.({});
          this.message({ type: 'ready', sessionId: 'session', inputEpoch: this.epoch, serverTime: serverNow(), inputMaxAgeMs: 1500 });
          if (this.rtc) {
            this.message({ type: 'video-config', data: 'AAAAAWdCAAk=', nativeTouches: true });
            // Capability intentionally arrives separately, after codec metadata.
            this.message({ type: 'rtc-capabilities', available: rtcAvailable, iceServers: [], reason: 'WebRTC недоступен на узле теста.' });
          } else {
            this.message(frame);
            this.timer = setInterval(() => this.message(frame), 100);
          }
        }, 20);
      }
      message(value: object) { if (this.readyState === 1) this.onmessage?.({ data: JSON.stringify(value) }); }
      send(raw: string) {
        const message = JSON.parse(raw); this.sent.push(message);
        if (message.type === 'ping' && state.__transport.autoPong) queueMicrotask(() => this.message({ type: 'pong', id: message.id, serverTime: serverNow() }));
        if (message.type === 'input') state.__transport.inputs.push({ ...message, via: 'websocket', receivedAt: serverNow() });
        if (message.type === 'rtc-offer') void this.answer(message.description);
      }
      async answer(description: RTCSessionDescriptionInit) {
        const peer = new RTCPeerConnection(); state.__transport.peers.push(peer);
        const canvas = document.createElement('canvas'); canvas.width = 180; canvas.height = 320;
        const paint = () => { const context = canvas.getContext('2d')!; context.fillStyle = '#22cc66'; context.fillRect(0, 0, 180, 320); context.fillStyle = '#111111'; context.fillRect((state.__transport.frames++ % 80), 10, 25, 25); };
        paint(); const timer = setInterval(paint, 80);
        peer.addEventListener('connectionstatechange', () => { if (peer.connectionState === 'closed') clearInterval(timer); });
        const stream = canvas.captureStream(12); stream.getTracks().forEach(track => peer.addTrack(track, stream));
        peer.ondatachannel = event => {
          const channel = event.channel;
          const sendReady = () => channel.send(JSON.stringify({ type: 'ready', inputEpoch: 'rtc-epoch', serverTime: serverNow(), inputMaxAgeMs: 1500 }));
          channel.onopen = sendReady;
          channel.onmessage = incoming => {
            const value = JSON.parse(incoming.data);
            if (value.type === 'ping' && state.__transport.autoPong && state.__transport.dcAutoPong) channel.send(JSON.stringify({ type: 'pong', id: value.id, serverTime: serverNow() }));
            if (value.type === 'input') state.__transport.inputs.push({ ...value, via: 'webrtc', receivedAt: serverNow() });
          };
        };
        await peer.setRemoteDescription(description);
        await peer.setLocalDescription(await peer.createAnswer()); await gather(peer);
        this.message({ type: 'rtc-answer', description: { type: 'answer', sdp: peer.localDescription!.sdp }, peerId: 'rtc-epoch' });
      }
      close() { if (this.readyState >= 2) return; clearInterval(this.timer); if (state.__transport.lingerClose) { this.readyState = 2; return; } this.readyState = 3; this.onclose?.({}); }
      addEventListener() {} removeEventListener() {}
    }
    const ControlledSocket = function(url: string, protocols?: string | string[]) {
      return /\/api\/sessions\/.+\/stream/.test(String(url)) ? new SessionSocket(String(url)) : new RealSocket(url, protocols);
    };
    Object.assign(ControlledSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
    Object.defineProperty(window, 'WebSocket', { configurable: true, get: () => ControlledSocket, set: () => {} });
  }, { rtcAvailable: options.rtc ?? true });
  await page.goto('/#/session/' + sessionId);
  await expect.poll(() => page.evaluate(() => (window as any).__transport.sockets.at(-1)?.readyState)).toBe(1);
  await expect(page.getByRole('button', { name: 'Домой', exact: true })).toBeEnabled();
  return { httpInputs };
}
async function selectTransport(page: Page, mode: 'websocket' | 'webrtc') {
  await page.getByLabel('Транспорт и качество соединения', { exact: true }).click();
  await page.getByLabel('Транспорт трансляции', { exact: true }).selectOption(mode);
}

test('WSS input has a new epoch, monotonic sequence and a peer-clock deadline; disconnect never falls back to HTTP', async ({ page }) => {
  const fixture = await transportFixture(page);
  await page.getByRole('button', { name: 'Домой', exact: true }).click();
  await page.evaluate(() => { Date.now = () => 1; });
  await page.getByRole('button', { name: 'Громче', exact: true }).click();
  const inputs = await page.evaluate(() => (window as any).__transport.inputs);
  expect(inputs).toHaveLength(2);
  expect(inputs.map((input: any) => input.seq)).toEqual([1, 2]);
  for (const input of inputs) {
    expect(input.epoch).toBe(inputs[0].epoch);
    expect(input.deadline - input.receivedAt).toBeGreaterThan(1000);
    expect(input.deadline - input.receivedAt).toBeLessThanOrEqual(1500);
  }
  await page.evaluate(() => { const state = (window as any).__transport; state.online = false; window.dispatchEvent(new Event('offline')); });
  await expect(page.getByRole('button', { name: 'Домой', exact: true })).toBeDisabled();
  await page.locator('.touch-layer').dispatchEvent('keydown', { key: 'Enter' });
  await page.evaluate(() => { const state = (window as any).__transport; state.online = true; window.dispatchEvent(new Event('online')); });
  await expect(page.getByRole('button', { name: 'Домой', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Домой', exact: true }).click();
  const next = await page.evaluate(() => (window as any).__transport.inputs.at(-1));
  expect(next.epoch).not.toBe(inputs[0].epoch); expect(next.seq).toBe(1);
  expect(fixture.httpInputs).toEqual([]);
});

test('missing pongs closes a still-open stream and resets a gesture instead of replaying it after reconnect', async ({ page }) => {
  await transportFixture(page);
  await page.clock.install();
  const box = await page.locator('.touch-layer').boundingBox();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2); await page.mouse.down();
  await page.evaluate(() => { (window as any).__transport.autoPong = false; });
  await page.clock.runFor(8500);
  await expect(page.getByRole('button', { name: 'Домой', exact: true })).toBeDisabled();
  await page.mouse.up();
  const before = await page.evaluate(() => (window as any).__transport.inputs.length);
  await page.evaluate(() => { (window as any).__transport.autoPong = true; });
  await page.clock.runFor(1500);
  await expect(page.getByRole('button', { name: 'Домой', exact: true })).toBeEnabled();
  await page.mouse.up();
  expect(await page.evaluate(() => (window as any).__transport.inputs.length)).toBe(before);
});

test('WebRTC selection receives genuine H264 video frames and sends protected control over a real DataChannel', async ({ page }) => {
  const fixture = await transportFixture(page);
  await selectTransport(page, 'webrtc');
  await expect(page.locator('[data-media="video"]')).toHaveText('WebRTC', { timeout: 20_000 });
  await expect.poll(() => page.locator('.device-screen canvas').evaluate((canvas: HTMLCanvasElement) => { const pixel = canvas.getContext('2d')!.getImageData(100, 100, 1, 1).data; return Math.max(...[34, 204, 102].map((value, index) => Math.abs(pixel[index] - value))); })).toBeLessThan(6);
  await expect(page.getByRole('button', { name: 'Домой', exact: true })).toBeEnabled();
  await page.locator('.session-transport-menu > summary').click();
  await page.getByRole('button', { name: 'Домой', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__transport.inputs.length)).toBe(1);
  const input = await page.evaluate(() => (window as any).__transport.inputs[0]);
  expect(input).toMatchObject({ via: 'webrtc', kind: 'key', keyCode: 3, epoch: 'rtc-epoch', seq: 1 });
  expect(input.deadline - input.receivedAt).toBeGreaterThan(500);
  expect(input.deadline - input.receivedAt).toBeLessThanOrEqual(1500);
  expect(fixture.httpInputs).toEqual([]);
  await selectTransport(page, 'websocket');
  await expect(page.locator('[data-media="video"]')).toHaveText('Кадры');
  expect(await page.evaluate(() => { const state = (window as any).__transport; return state.allPeers.filter((peer: RTCPeerConnection) => !state.peers.includes(peer)).every((peer: RTCPeerConnection) => peer.connectionState === 'closed'); })).toBe(true);
});

test('unsupported WebRTC is explicit and switching back restores WebSocket without HTTP input', async ({ page }) => {
  const fixture = await transportFixture(page, { rtc: false });
  await selectTransport(page, 'webrtc');
  await expect(page.locator('[data-media="video"]')).toHaveText('Видео недоступно');
  await expect(page.locator('.stream-placeholder')).toContainText('WebRTC недоступен на узле теста.');
  await expect(page.getByRole('button', { name: 'Домой', exact: true })).toBeDisabled();
  await page.getByLabel('Транспорт трансляции', { exact: true }).selectOption('websocket');
  await expect(page.getByRole('button', { name: 'Домой', exact: true })).toBeEnabled();
  expect(fixture.httpInputs).toEqual([]);
});


test('a silent RTC control channel times out even while signaling still answers pings', async ({ page }) => {
  const fixture = await transportFixture(page);
  await selectTransport(page, 'webrtc');
  await expect(page.locator('[data-media="video"]')).toHaveText('WebRTC', { timeout: 20_000 });
  await expect(page.getByRole('button', { name: 'Домой', exact: true })).toBeEnabled();
  await page.evaluate(() => {
    const state = (window as any).__transport;
    state.dcAutoPong = false;
    // Avoid an automatic retry during this assertion; no offline event is dispatched,
    // so only the DataChannel heartbeat can mark the existing stream disconnected.
    state.online = false;
  });
  await expect(page.getByRole('button', { name: 'Домой', exact: true })).toBeDisabled({ timeout: 12_000 });
  await expect(page.locator('.stream-placeholder')).toContainText('Узел не отвечает на проверку соединения WebRTC.');
  expect(await page.evaluate(() => (window as any).__transport.sockets.at(-1).readyState)).toBe(3);
  expect(fixture.httpInputs).toEqual([]);
});


test('heartbeat recovery abandons a socket whose close handshake never completes', async ({ page }) => {
  const fixture = await transportFixture(page);
  await page.evaluate(() => {
    const state = (window as any).__transport;
    state.lingerClose = true; state.autoPong = false;
    state.oldSocket = state.sockets.at(-1);
  });
  const count = await page.evaluate(() => (window as any).__transport.sockets.length);
  await expect.poll(() => page.evaluate(() => (window as any).__transport.oldSocket.readyState), { timeout: 12_000 }).toBe(2);
  await page.evaluate(() => { (window as any).__transport.autoPong = true; });
  await expect.poll(() => page.evaluate(() => (window as any).__transport.sockets.length), { timeout: 2000 }).toBeGreaterThan(count);
  await expect(page.getByRole('button', { name: 'Домой', exact: true })).toBeEnabled();
  expect(await page.evaluate(() => (window as any).__transport.sockets.length)).toBeGreaterThan(count);
  expect(await page.evaluate(() => (window as any).__transport.oldSocket.readyState)).toBe(2);
  expect(await page.evaluate(() => (window as any).__transport.oldSocket.onmessage)).toBeNull();
  await page.getByRole('button', { name: 'Домой', exact: true }).click();
  const input = await page.evaluate(() => (window as any).__transport.inputs.at(-1));
  const oldEpoch = await page.evaluate(() => (window as any).__transport.oldSocket.epoch);
  expect(input.epoch).not.toBe(oldEpoch); expect(input.seq).toBe(1);
  expect(fixture.httpInputs).toEqual([]);
});
