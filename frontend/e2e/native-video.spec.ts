import { expect, test } from '@playwright/test';

test('the browser decodes native VP8 access units after a PNG placeholder without H264 headers', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { SessionVideo } = await import('/src/session-video.ts');
    const source = document.createElement('canvas'); source.width = 96; source.height = 160;
    const context = source.getContext('2d')!; context.fillStyle = '#20c080'; context.fillRect(0, 0, 96, 160);
    const encoded = await new Promise<EncodedVideoChunk>((resolve, reject) => {
      const encoder = new VideoEncoder({ output: chunk => resolve(chunk), error: reject });
      encoder.configure({ codec: 'vp8', width: 96, height: 160, bitrate: 100000, framerate: 30 });
      const frame = new VideoFrame(source, { timestamp: 0 }); encoder.encode(frame, { keyFrame: true }); frame.close();
      void encoder.flush().then(() => encoder.close(), reject);
    });
    const bytes = new Uint8Array(encoded.byteLength); encoded.copyTo(bytes);
    const canvas = document.createElement('canvas'), image = document.createElement('img');
    const errors: string[] = [], transports: string[] = [];
    let rendered: () => void;
    const ready = new Promise<void>(resolve => { rendered = resolve; });
    const decoder = new SessionVideo({ closed: () => false, canvas: () => canvas, image: () => image,
      pendingImage: { current: null }, connecting: () => {}, fail: message => errors.push(message), requestKeyframe: () => {},
      frame: (format, _width, _height, transport) => { if (transport) transports.push(transport); if (format === 'video') rendered(); } });
    decoder.handle({ type: 'frame', mime: 'image/png', data: source.toDataURL('image/png').split(',')[1], width: 96, height: 160 });
    decoder.handle({ type: 'video-config', codec: 'vp8', data: undefined, width: 96, height: 160 });
    decoder.handle({ type: 'video-frame', codec: 'vp8', keyframe: true, data: btoa(String.fromCharCode(...bytes)), timestamp: encoded.timestamp });
    await Promise.race([ready, new Promise((_, reject) => setTimeout(() => reject(new Error('VP8 frame was not rendered')), 5000))]);
    const pixel = [...canvas.getContext('2d')!.getImageData(48, 80, 1, 1).data]; decoder.reset();
    return { width: canvas.width, height: canvas.height, errors, transports, pixel };
  });
  expect(result.errors).toEqual([]); expect(result.transports).toEqual(['images', 'native']);
  expect(result.width).toBe(96); expect(result.height).toBe(160);
  // VP8 is lossy; hardware and software encoders may choose different quantizers.
  for (const [index, target] of [32, 192, 128, 255].entries()) expect(Math.abs(result.pixel[index] - target)).toBeLessThanOrEqual(index === 3 ? 0 : 16);
});
