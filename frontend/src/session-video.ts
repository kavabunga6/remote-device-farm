import { t } from './i18n';
import { decodeBase64, h264Codec, joinBytes, type StreamMessage } from './session-media';
type VideoOwner = {
  closed(): boolean;
  canvas(): HTMLCanvasElement | null;
  image(): HTMLImageElement | null;
  pendingImage: { current: string | null };
  frame(format: 'image' | 'video', width?: number, height?: number, transport?: 'mjpeg' | 'images'): void;
  connecting(): void;
  fail(message: string, unsupported?: boolean): void;
  requestKeyframe(): void;
};
const errorText = (error: unknown) => error instanceof Error ? error.message : t('ui.b9f61453dd3f');
const VIDEO_DECODE_STALL_MS = 1500;
const KEYFRAME_REQUEST_INTERVAL_MS = 1000;

/** Owns one connection's image and H.264 decoder resources. */
export class SessionVideo {
  private decoder: VideoDecoder | null = null;
  private configBytes: Uint8Array | null = null;
  private configBase64: string | null = null;
  private config: VideoDecoderConfig | null = null;
  private waitingForKeyframe = true;
  private dropping = false;
  private pendingSince: number | null = null;
  private lastKeyframeRequestAt = -Infinity;
  constructor(private readonly owner: VideoOwner) {}
  reset(): void {
    if (this.decoder && this.decoder.state !== 'closed') this.decoder.close();
    this.decoder = null; this.configBytes = null; this.configBase64 = null; this.config = null;
    this.waitingForKeyframe = true; this.dropping = false;
    this.pendingSince = null;
    this.lastKeyframeRequestAt = -Infinity;
  }
  handle(message: StreamMessage): void {
    if (message.type === 'frame') this.image(message);
    else if (message.type === 'video-config') this.configure(message);
    else if (message.type === 'video-frame') this.decode(message);
  }
  private image(message: StreamMessage): void {
    if (!message.data) return;
    this.reset();
    const mime = message.mime === 'image/jpeg' || message.mime === 'image/webp' ? message.mime : 'image/png';
    const source = `data:${mime};base64,${message.data}`;
    const image = this.owner.image();
    if (image) image.src = source; else this.owner.pendingImage.current = source;
    this.owner.frame('image', message.width, message.height, mime === 'image/jpeg' ? 'mjpeg' : 'images');
  }
  private configure(message: StreamMessage): void {
    if (!message.data || (this.decoder?.state === 'configured' && this.configBase64 === message.data)) return;
    this.reset(); this.owner.connecting();
    if (!('VideoDecoder' in window)) { this.owner.fail(globalThis.isSecureContext ? t('ui.6afd1f9a6d5d') : t('ui.5857f8195393'), true); return; }
    try {
      this.configBytes = decodeBase64(message.data); this.configBase64 = message.data;
      this.config = { codec: h264Codec(this.configBytes), optimizeForLatency: true };
      let decoder: VideoDecoder;
      decoder = new VideoDecoder({
        output: frame => this.render(frame, decoder),
        error: error => { if (this.decoder === decoder) this.owner.fail(t('ui.ed5e458d7bc8', { p0: error.message })); },
      });
      this.decoder = decoder; decoder.configure(this.config);
    } catch (error) { this.owner.fail(t('ui.c1302697e98f', { p0: errorText(error) }), true); }
  }
  private render(frame: VideoFrame, decoder: VideoDecoder): void {
    if (this.owner.closed() || this.decoder !== decoder || this.dropping) { frame.close(); return; }
    this.pendingSince = null;
    try {
      const canvas = this.owner.canvas();
      if (!canvas) return;
      const width = frame.displayWidth || frame.codedWidth, height = frame.displayHeight || frame.codedHeight;
      if (canvas.width !== width) canvas.width = width;
      if (canvas.height !== height) canvas.height = height;
      canvas.getContext('2d')?.drawImage(frame, 0, 0, width, height);
      this.owner.frame('video', width, height);
    } catch (error) { this.owner.fail(t('copy.session-video.3f00f5e6', { p0: errorText(error) })); }
    finally { frame.close(); }
  }
  private decode(message: StreamMessage): void {
    if (!message.data || this.decoder?.state !== 'configured') return;
    try {
      const now = performance.now();
      // Accepted chunks can leave the decode queue before the decoder produces a frame.
      if (this.decoder.decodeQueueSize >= 8 || (this.pendingSince !== null && now - this.pendingSince >= VIDEO_DECODE_STALL_MS)) {
        this.dropping = true;
      }
      if ((this.dropping || this.waitingForKeyframe) && !message.keyframe) {
        if (now - this.lastKeyframeRequestAt >= KEYFRAME_REQUEST_INTERVAL_MS) {
          this.lastKeyframeRequestAt = now;
          this.owner.requestKeyframe();
        }
        return;
      }
      if (this.dropping) {
        if (!this.config) return;
        this.decoder.reset(); this.decoder.configure(this.config);
        this.dropping = false; this.pendingSince = null;
      }
      const packet = decodeBase64(message.data);
      this.pendingSince ??= now;
      this.decoder.decode(new EncodedVideoChunk({ type: message.keyframe ? 'key' : 'delta', timestamp: message.timestamp ?? 0,
        data: message.keyframe && this.configBytes ? joinBytes(this.configBytes, packet) : packet }));
      this.waitingForKeyframe = false;
    } catch (error) { this.owner.fail(t('ui.400595b4a03f', { p0: errorText(error) })); }
  }
}
