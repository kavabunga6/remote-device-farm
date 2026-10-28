import { t } from './i18n';
import { decodeBase64, type StreamMessage } from './session-media';

type AudioOwner = {
  closed(): boolean;
  enabled(): boolean;
  context: { current: AudioContext | null };
  clock: { current: number };
  active(value: boolean): void;
  needsGesture(value: boolean): void;
  notice(value: string): void;
  playback(): void;
  transport(value: 'websocket' | 'webrtc'): void;
};
const errorText = (error: unknown) => error instanceof Error ? error.message : t('ui.b9f61453dd3f');

/** Decodes one connection's audio; the hook owns the user-gesture AudioContext. */
export class SessionAudio {
  private decoder: AudioDecoder | null = null;
  private configured = false;
  private pcmConfigured = false;
  private sampleRate = 48000;
  private channels = 2;

  constructor(private readonly owner: AudioOwner, private readonly rtc: boolean) {}

  reset(): void {
    if (this.decoder && this.decoder.state !== 'closed') this.decoder.close();
    this.decoder = null;
    this.configured = false;
    this.pcmConfigured = false;
  }

  handle(message: StreamMessage): void {
    if (message.type === 'audio-config') this.configure(message);
    if (message.type !== 'audio-frame' || !message.data) return;
    if (this.pcmConfigured && this.owner.enabled()) this.decodePcm(message.data);
    else if (this.configured && this.decoder?.state === 'configured') {
      try {
        if (this.decoder.decodeQueueSize < 16) this.decoder.decode(new EncodedAudioChunk({
          type: 'key', timestamp: message.timestamp ?? 0, data: decodeBase64(message.data),
        }));
      } catch (error) {
        this.configured = false;
        this.owner.active(false);
        if (this.owner.enabled()) this.owner.notice(t('ui.0d3affb22351', { p0: errorText(error) }));
      }
    }
  }

  private configure(message: StreamMessage): void {
    this.reset();
    if (this.rtc && message.codec === 'opus') {
      this.owner.transport('webrtc');
      return;
    }
    this.owner.transport('websocket');
    this.owner.active(false);
    this.owner.clock.current = 0;
    if (message.codec === 'pcm-s16le') {
      this.sampleRate = message.sampleRate || 48000;
      this.channels = message.channels || 2;
      this.pcmConfigured = this.sampleRate > 0 && this.channels >= 1 && this.channels <= 2;
      if (!this.pcmConfigured && this.owner.enabled()) this.owner.notice(t('ui.457a252ec013'));
      return;
    }
    if (!('AudioDecoder' in window)) {
      if (this.owner.enabled()) this.owner.notice(t('ui.67a53ec39aa4'));
      return;
    }
    if (!message.data) return;
    try {
      let decoder: AudioDecoder;
      decoder = new AudioDecoder({
        output: audio => this.render(audio, decoder),
        error: error => {
          if (this.decoder !== decoder) return;
          this.configured = false;
          this.owner.active(false);
          if (this.owner.enabled()) this.owner.notice(t('ui.d101328a6215', { p0: error.message }));
        },
      });
      this.decoder = decoder;
      const codec = message.codec === 'aac' ? 'mp4a.40.2' : message.codec === 'opus' ? 'opus' : null;
      if (!codec) throw new Error(t('ui.68f6fac0e28a'));
      decoder.configure({ codec, sampleRate: message.sampleRate || 48000,
        numberOfChannels: message.channels || 2, description: decodeBase64(message.data) });
      this.configured = true;
    } catch (error) {
      this.reset();
      this.owner.active(false);
      if (this.owner.enabled()) this.owner.notice(t('ui.04b49ea56cd6', { p0: errorText(error) }));
    }
  }

  private playbackContext(sampleRate: number): AudioContext | null {
    const context = this.owner.context.current ?? new AudioContext({ sampleRate, latencyHint: 'interactive' });
    this.owner.context.current = context;
    if (context.state !== 'running') {
      this.owner.needsGesture(true);
      this.owner.active(false);
      this.owner.notice(t('ui.3b0cbc5e4cdc'));
      return null;
    }
    return this.owner.clock.current - context.currentTime > 0.25 ? null : context;
  }

  private play(context: AudioContext, buffer: AudioBuffer, offset: number): void {
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    const startAt = Math.max(context.currentTime + offset, this.owner.clock.current);
    source.start(startAt);
    this.owner.clock.current = startAt + buffer.duration;
    this.owner.needsGesture(false);
    this.owner.notice('');
    this.owner.playback();
  }

  private render(audio: AudioData, decoder: AudioDecoder): void {
    try {
      if (this.owner.closed() || this.decoder !== decoder || !this.owner.enabled()) return;
      const context = this.playbackContext(audio.sampleRate);
      if (!context) return;
      const buffer = context.createBuffer(audio.numberOfChannels, audio.numberOfFrames, audio.sampleRate);
      for (let channel = 0; channel < audio.numberOfChannels; channel += 1) {
        const samples = new Float32Array(audio.numberOfFrames);
        audio.copyTo(samples, { planeIndex: channel, format: 'f32-planar' });
        buffer.copyToChannel(samples, channel);
      }
      this.play(context, buffer, 0.025);
    } catch (error) { this.playbackError(error); }
    finally { audio.close(); }
  }

  private decodePcm(data: string): void {
    try {
      const bytes = decodeBase64(data);
      const frameBytes = this.channels * 2;
      if (bytes.byteLength < frameBytes || bytes.byteLength % frameBytes !== 0) return;
      const context = this.playbackContext(this.sampleRate);
      if (!context) return;
      const frames = bytes.byteLength / frameBytes;
      const buffer = context.createBuffer(this.channels, frames, this.sampleRate);
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      for (let channel = 0; channel < this.channels; channel += 1) {
        const samples = new Float32Array(frames);
        for (let frame = 0; frame < frames; frame += 1) {
          samples[frame] = view.getInt16((frame * this.channels + channel) * 2, true) / 32768;
        }
        buffer.copyToChannel(samples, channel);
      }
      this.play(context, buffer, 0.02);
    } catch (error) { this.playbackError(error); }
  }

  private playbackError(error: unknown): void {
    this.owner.active(false);
    this.owner.notice(t('ui.93f3de906b00', { p0: errorText(error) }));
  }
}
