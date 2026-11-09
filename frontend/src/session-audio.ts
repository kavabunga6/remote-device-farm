import { t } from './i18n';
import { AUDIO_SIGNAL_THRESHOLD, decodeBase64, type StreamMessage } from './session-media';

type AudioOwner = {
  closed(): boolean;
  enabled(): boolean;
  context: { current: AudioContext | null };
  clock: { current: number };
  clearPlayback(): void;
  needsGesture(value: boolean): void;
  notice(value: string): void;
  playback(hasSignal: boolean): void;
  transport(value: 'websocket' | 'webrtc'): void;
};
const errorText = (error: unknown) => error instanceof Error ? error.message : t('ui.b9f61453dd3f');
const MAX_AUDIO_LAG_MS = 300;

/** Decodes one connection's audio; the hook owns the user-gesture AudioContext. */
export class SessionAudio {
  private decoder: AudioDecoder | null = null;
  private configured = false;
  private pcmConfigured = false;
  private sampleRate = 48000;
  private channels = 2;
  private configMessage: StreamMessage | undefined;
  private restartDecoder = false;
  private sourceOffsetMs: number | undefined;
  private offsetMeasuredAt = 0;
  private readonly sources = new Set<AudioBufferSourceNode>();

  constructor(private readonly owner: AudioOwner, private readonly rtc: boolean) {}

  reset(): void {
    if (this.decoder && this.decoder.state !== 'closed') this.decoder.close();
    this.decoder = null;
    this.configured = false;
    this.pcmConfigured = false;
    this.restartDecoder = false;
    this.stopQueuedAudio();
  }

  pause(): void {
    this.restartDecoder = this.configured;
    this.stopQueuedAudio();
  }

  handle(message: StreamMessage): void {
    if (message.type === 'audio-config') this.configure(message);
    if (message.type !== 'audio-frame' || !message.data || !this.owner.enabled() || (!this.pcmConfigured && !this.configured)) return;
    if (!this.acceptTimestamp(message.timestamp)) return;
    if (this.restartDecoder && this.configMessage) this.configure(this.configMessage);
    if (this.pcmConfigured) this.decodePcm(message.data);
    else if (this.configured && this.decoder?.state === 'configured') {
      try {
        if (this.decoder.decodeQueueSize < 16) this.decoder.decode(new EncodedAudioChunk({
          type: 'key', timestamp: message.timestamp ?? 0, data: decodeBase64(message.data),
        }));
        else this.restartDecoder = true;
      } catch (error) {
        this.configured = false;
        this.owner.clearPlayback();
        if (this.owner.enabled()) this.owner.notice(t('ui.0d3affb22351', { p0: errorText(error) }));
      }
    }
  }

  private configure(message: StreamMessage): void {
    this.reset();
    // Repeated codec headers can arrive while the same stream is catching up.
    // Keep its clock unless the source changes to a different codec.
    if (this.configMessage?.codec !== message.codec) this.sourceOffsetMs = undefined;
    this.configMessage = message;
    if (this.rtc && message.codec === 'opus') {
      this.owner.transport('webrtc');
      return;
    }
    this.owner.transport('websocket');
    this.owner.clearPlayback();
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
          this.owner.clearPlayback();
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
      this.owner.clearPlayback();
      if (this.owner.enabled()) this.owner.notice(t('ui.04b49ea56cd6', { p0: errorText(error) }));
    }
  }

  private acceptTimestamp(timestamp: number | undefined): boolean {
    if (typeof timestamp !== 'number' || !Number.isSafeInteger(timestamp) || timestamp <= 0) return true;
    const now = performance.now();
    const offset = now - timestamp / 1000;
    // Keep the lowest observed transit time. Allow slow drift between the
    // Android and browser clocks without learning seconds of queueing delay.
    const drift = (now - this.offsetMeasuredAt) / 1000;
    this.sourceOffsetMs = Math.min(offset, (this.sourceOffsetMs ?? offset) + drift);
    this.offsetMeasuredAt = now;
    return this.checkFreshness(timestamp, now);
  }

  private checkFreshness(timestamp: number, now = performance.now()): boolean {
    if (this.sourceOffsetMs === undefined || timestamp <= 0 || now - timestamp / 1000 - this.sourceOffsetMs <= MAX_AUDIO_LAG_MS) return true;
    // Chromium's Opus decoder can keep emitting continuous timestamps across
    // a gap in the input. Start a new decoder when fresh packets resume.
    if (this.configured) this.restartDecoder = true;
    if (this.sources.size) {
      this.stopQueuedAudio();
      this.owner.clearPlayback();
    }
    return false;
  }

  private stopQueuedAudio(): void {
    for (const source of this.sources) {
      source.onended = null;
      source.stop();
      source.disconnect();
    }
    this.sources.clear();
    this.owner.clock.current = 0;
  }

  private playbackContext(sampleRate: number): AudioContext | null {
    const context = this.owner.context.current ?? new AudioContext({ sampleRate, latencyHint: 'interactive' });
    this.owner.context.current = context;
    if (context.state !== 'running') {
      this.owner.needsGesture(true);
      this.owner.clearPlayback();
      this.owner.notice(t('ui.3b0cbc5e4cdc'));
      return null;
    }
    return this.owner.clock.current - context.currentTime > 0.25 ? null : context;
  }

  private play(context: AudioContext, buffer: AudioBuffer, offset: number, hasSignal: boolean): void {
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    const startAt = Math.max(context.currentTime + offset, this.owner.clock.current);
    source.start(startAt);
    this.sources.add(source);
    source.onended = () => { this.sources.delete(source); source.disconnect(); };
    this.owner.clock.current = startAt + buffer.duration;
    this.owner.needsGesture(false);
    this.owner.notice('');
    this.owner.playback(hasSignal);
  }

  private render(audio: AudioData, decoder: AudioDecoder): void {
    try {
      if (this.owner.closed() || this.decoder !== decoder || !this.owner.enabled() || !this.checkFreshness(audio.timestamp)) return;
      const context = this.playbackContext(audio.sampleRate);
      if (!context) return;
      const buffer = context.createBuffer(audio.numberOfChannels, audio.numberOfFrames, audio.sampleRate);
      let hasSignal = false;
      for (let channel = 0; channel < audio.numberOfChannels; channel += 1) {
        const samples = new Float32Array(audio.numberOfFrames);
        audio.copyTo(samples, { planeIndex: channel, format: 'f32-planar' });
        if (!hasSignal) hasSignal = samples.some(sample => Math.abs(sample) >= AUDIO_SIGNAL_THRESHOLD);
        buffer.copyToChannel(samples, channel);
      }
      this.play(context, buffer, 0.025, hasSignal);
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
      let hasSignal = false;
      for (let channel = 0; channel < this.channels; channel += 1) {
        const samples = new Float32Array(frames);
        for (let frame = 0; frame < frames; frame += 1) {
          samples[frame] = view.getInt16((frame * this.channels + channel) * 2, true) / 32768;
          if (!hasSignal && Math.abs(samples[frame]) >= AUDIO_SIGNAL_THRESHOLD) hasSignal = true;
        }
        buffer.copyToChannel(samples, channel);
      }
      this.play(context, buffer, 0.02, hasSignal);
    } catch (error) { this.playbackError(error); }
  }

  private playbackError(error: unknown): void {
    this.owner.clearPlayback();
    this.owner.notice(t('ui.93f3de906b00', { p0: errorText(error) }));
  }
}
