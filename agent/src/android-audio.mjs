import { ScrcpyStream, shouldRetryAac } from './scrcpy.mjs';
import { diagnostic } from './diagnostics.mjs';

/** Captures Android playback without creating a second video encoder or control channel. */
export class AndroidAudioStream {
  constructor({ createStream = options => new ScrcpyStream(options), ...options }) {
    this.options = options; this.createStream = createStream; this.closed = false;
  }
  get codec() { return this.stream?.audioCodec; }
  start() { return this.ready ??= this.open(); }
  async open() {
    for (const codec of ['opus', 'aac']) {
      if (this.closed) throw new Error(diagnostic('scrcpy.03bf10da46'));
      const stream = this.createStream({ ...this.options, audioOnly: true, audioEnabled: false, audioCodec: codec,
        emit: event => { if (!this.closed && this.stream === stream) this.options.emit(event); },
        onAudioFailure: () => { if (!this.closed && this.stream === stream) this.options.onFailure?.(stream.lastError || new Error(diagnostic('scrcpy.f7034c1bc1'))); } });
      this.stream = stream;
      try {
        await stream.start();
        if (this.closed || stream.closed) throw stream.lastError || new Error(diagnostic('scrcpy.03bf10da46'));
        if (!stream.audioAvailable) throw new Error(diagnostic('scrcpy.f7034c1bc1'));
        return;
      } catch (error) {
        await stream.close();
        if (this.closed || codec !== 'opus' || !shouldRetryAac(error)) throw error;
      }
    }
  }
  setEnabled(enabled) { if (!this.closed) this.stream?.setAudio(enabled); }
  resendConfig() { if (!this.closed && this.stream?.audioEnabled) this.stream.setAudio(true); }
  close() {
    if (this.closing) return this.closing;
    this.closed = true;
    this.closing = (async () => { await this.ready?.catch(() => {}); await this.stream?.close(); })();
    return this.closing;
  }
}
