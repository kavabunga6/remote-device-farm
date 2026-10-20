import { RESET_VIDEO_CONTROL_MESSAGE, scrcpyServerArgs, SocketReader, parseMediaHeader, parseAudioCodecHeader, shouldRetryAac, encodeTouchEvent, encodeKeyPress, encodeTextInput, connectPort, within, connectVideoPortWithHandshake } from './scrcpy-protocol.mjs';
export { scrcpyServerArgs, SocketReader, parseMediaHeader, parseAudioCodecHeader, shouldRetryAac, encodeTouchEvent, encodeKeyPress, encodeTextInput, connectPort, within, connectVideoPortWithHandshake } from './scrcpy-protocol.mjs';
import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import crypto from 'node:crypto';
import { runProcess } from './adb.mjs';
import { EmulatorAudioStream } from './emulator-audio.mjs';
import { EmulatorTouchController } from './emulator-touch.mjs';
import { TouchGeometryCache, parseTouchGeometryChange } from './touch-geometry.mjs';

export class ScrcpyStream {
  constructor({ sessionId, serial, adb, serverPath, emit, canEmitVideo = () => true,
    audioEnabled = false, audioCodec = 'opus', onFailure, onAudioFailure,
    createEmulatorTouch = options => new EmulatorTouchController(options),
    maxInputAgeMs = 500, now = Date.now }) {
    this.sessionId = sessionId;
    this.serial = serial;
    this.adb = adb;
    this.serverPath = serverPath;
    this.emit = emit;
    this.canEmitVideo = canEmitVideo;
    this.audioEnabled = audioEnabled;
    this.audioCodec = audioCodec;
    this.closed = false;
    this.videoConfig = null;
    this.audioConfig = null;
    this.audioAvailable = false;
    this.lastError = null;
    this.processLog = '';
    this.onFailure = onFailure;
    this.onAudioFailure = onAudioFailure;
    this.activePointers = new Set();
    this.scrcpyPointers = new Map();
    this.inputEpoch = 0;
    this.maxInputAgeMs = maxInputAgeMs;
    this.now = now;
    this.displayLogBuffers = new Map();
    this.videoNeedsKeyframe = true;
    this.videoConfigPending = true;
    this.lastVideoResetAt = 0;
    this.createEmulatorTouch = createEmulatorTouch;
    this.nativeTouch = null;
    this.nativeTouchReady = false;
    this.nativePointers = new Set();
    this.nativeInputTail = Promise.resolve();
    this.nativeInputPending = 0;
    this.inputAbort = new AbortController();
    this.touchGeometry = new TouchGeometryCache({ adb, serial, signal: this.inputAbort.signal });
  }

  async start() {
    await access(this.serverPath);
    await this.adb.connect(this.serial);
    void this.startNativeTouch();
    this.scid = crypto.randomBytes(4).readUInt32BE(0) & 0x7fffffff;
    this.deviceServerPath = `/data/local/tmp/rdf-scrcpy-${this.scid.toString(16).padStart(8, '0')}.jar`;
    const pushed = await this.adb.run(this.serial, ['push', this.serverPath, this.deviceServerPath], { timeoutMs: 30000 });
    if (pushed.exitCode !== 0) throw new Error(pushed.stderr || 'Could not push scrcpy server');
    const socketName = `localabstract:scrcpy_${this.scid.toString(16).padStart(8, '0')}`;
    const forwarded = await this.adb.run(this.serial, ['forward', 'tcp:0', socketName], { timeoutMs: 10000 });
    if (forwarded.exitCode !== 0) throw new Error(forwarded.stderr || 'Could not forward scrcpy socket');
    this.port = Number(forwarded.stdout.trim());
    if (!Number.isInteger(this.port) || this.port < 1 || this.port > 65535) throw new Error('Invalid scrcpy forward port');
    const args = scrcpyServerArgs(this.serial, this.deviceServerPath, this.scid, this.audioCodec);
    this.process = spawn('adb', args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    this.process.stdout.on('data', data => this.observeDisplayOutput(data, 'stdout'));
    this.process.stderr.on('data', data => {
      this.processLog = `${this.processLog}${data.toString()}`.slice(-4000);
      this.observeDisplayOutput(data, 'stderr');
    });
    this.process.on('error', (error) => { this.lastError = error; });
    this.process.on('close', (code) => {
      if (!this.closed) this.lastError = new Error(`scrcpy exited ${code}: ${this.processLog.trim()}`);
      this.videoSocket?.destroy();
      this.audioSocket?.destroy();
      this.controlSocket?.destroy();
    });
    try {
      const video = await connectVideoPortWithHandshake(this.port);
      this.videoSocket = video.socket;
      this.audioSocket = await connectPort(this.port);
      // In forward mode the server accepts video, audio and control in that
      // order. It cannot start publishing media until all three connect.
      this.controlSocket = await connectPort(this.port);
      this.controlSocket.once('error', (error) => {
        if (this.closed) return;
        this.lastError = error;
        void this.close();
        this.onFailure?.(error);
      });
      this.controlSocket.once('close', () => {
        if (this.closed) return;
        const error = new Error('scrcpy control socket closed');
        this.lastError = error;
        void this.close();
        this.onFailure?.(error);
      });
      const videoReader = video.reader;
      const audioReader = new SocketReader(this.audioSocket);
      const videoCodec = (await within(videoReader.read(4), 10000, 'scrcpy video header')).toString('ascii');
      if (videoCodec !== 'h264') throw new Error(`Unexpected scrcpy video codec ${videoCodec}`);
      this.videoTask = this.readVideo(videoReader);
      this.videoTask.catch((error) => {
        if (!this.closed) {
          this.lastError = error;
          this.close();
          this.onFailure?.(error);
        }
      });
      try {
        const audioHeader = await within(audioReader.read(4), 5000, 'scrcpy audio header');
        const audio = parseAudioCodecHeader(audioHeader, this.audioCodec);
        if (audio.available) {
          this.audioAvailable = true;
          this.audioTask = this.readAudio(audioReader);
          this.audioTask.catch((error) => {
            if (!this.closed) {
              this.audioAvailable = false;
              this.lastError = error;
              if (this.audioEnabled) {
                this.audioEnabled = false;
                this.onAudioFailure?.();
              }
            }
          });
        } else {
          this.audioSocket.destroy();
          console.warn(`scrcpy audio capture unavailable for ${this.sessionId}`);
        }
      } catch (error) {
        if (error.code === 'SCRCPY_AUDIO_CODEC_ERROR') throw error;
        this.audioSocket.destroy();
        this.audioAvailable = false;
        console.warn(`scrcpy audio unavailable for ${this.sessionId}: ${error.message}`);
      }
      if (this.closed) throw this.lastError || new Error('scrcpy video stopped during startup');
    } catch (error) {
      const log = this.processLog.trim();
      const failure = log ? new Error(`${error.message}; scrcpy server stderr: ${log}`) : this.lastError || error;
      if (error.code) failure.code = error.code;
      await this.close();
      throw failure;
    }
  }

  async readVideo(reader) {
    for (;;) {
      const header = await reader.read(12);
      const flags = parseMediaHeader(header);
      if (flags.session) {
        const width = header.readUInt32BE(4);
        const height = header.readUInt32BE(8);
        if (width < 1 || height < 1 || width > 8192 || height > 8192) throw new Error('Invalid video dimensions');
        // Invalidate even when dimensions are identical: a 180-degree turn
        // starts a new codec session too. The display event often arrives first.
        if (this.nativeTouch) this.touchGeometry.invalidate();
        // A rotation starts a new codec session. The previous SPS/PPS may no longer match.
        this.videoConfig = { type: 'video-config', codec: 'h264', width, height, data: null, nativeTouches: this.nativeTouchReady };
        this.videoNeedsKeyframe = true;
        this.videoConfigPending = true;
        continue;
      }
      const packet = await reader.read(flags.packetSize);
      if (flags.config) {
        this.videoConfig = { ...(this.videoConfig || { type: 'video-config', codec: 'h264' }), data: packet.toString('base64') };
        // SDP negotiation needs the SPS/PPS before an RTC peer exists. This
        // small metadata packet must not depend on frame admission capacity.
        this.emit({ ...this.videoConfig, sessionId: this.sessionId });
        this.videoConfigPending = false;
      } else {
        this.forwardVideoFrame(flags, packet);
      }
    }
  }

  forwardVideoFrame(flags, packet) {
    // Always drain the device socket; only the newest decodable frames may
    // enter the broker queue. Skipped H.264 deltas require a fresh keyframe.
    if (!this.canEmitVideo(this.sessionId)) {
      this.videoNeedsKeyframe = true;
      this.videoConfigPending = true;
      return;
    }
    if (this.videoNeedsKeyframe && !flags.keyframe) {
      this.requestKeyframe();
      return;
    }
    if (this.videoConfigPending) {
      if (!this.videoConfig?.data) return;
      this.emit({ ...this.videoConfig, sessionId: this.sessionId });
      this.videoConfigPending = false;
    }
    this.emit({ type: 'video-frame', sessionId: this.sessionId, codec: 'h264', timestamp: flags.timestamp,
      keyframe: flags.keyframe, data: packet.toString('base64') });
    this.videoNeedsKeyframe = false;
  }

  async readAudio(reader) {
    this.audioConfig = { type: 'audio-config', codec: this.audioCodec, sampleRate: 48000, channels: 2, data: null };
    if (this.audioEnabled) this.emit({ ...this.audioConfig, sessionId: this.sessionId });
    for (;;) {
      const header = await reader.read(12);
      const flags = parseMediaHeader(header);
      if (flags.session) throw new Error('Unexpected audio session packet');
      const packet = await reader.read(flags.packetSize);
      if (flags.config) {
        this.audioConfig = { ...this.audioConfig, data: packet.toString('base64') };
        if (this.audioEnabled) this.emit({ ...this.audioConfig, sessionId: this.sessionId });
      } else if (this.audioEnabled) {
        this.emit({ type: 'audio-frame', sessionId: this.sessionId, codec: this.audioCodec, timestamp: flags.timestamp,
          data: packet.toString('base64') });
      }
    }
  }

  setAudio(enabled) {
    if (enabled && !this.audioAvailable) throw new Error('Audio capture is unavailable on this emulator');
    this.audioEnabled = Boolean(enabled);
    if (enabled && this.audioConfig) this.emit({ ...this.audioConfig, sessionId: this.sessionId });
  }

  hasControl() {
    return !this.closed && Boolean(this.controlSocket) && !this.controlSocket.destroyed;
  }

  writeControl(message) {
    if (!this.hasControl()) throw new Error('scrcpy control is unavailable');
    if (this.controlSocket.writableLength > 64 * 1024) throw new Error('scrcpy control channel is congested');
    if (message.length) this.controlSocket.write(message);
    return { ok: true };
  }

  assertInputEpoch(epoch = this.inputEpoch) {
    if (this.closed || epoch !== this.inputEpoch || this.inputRelease) {
      throw Object.assign(new Error('Input was reset or stream closed'), { code: 'INPUT_RESET' });
    }
  }

  input(params, epoch = this.inputEpoch) {
    this.assertInputEpoch(epoch);
    if (params?.kind === 'key') return this.writeControl(encodeKeyPress(params.keyCode));
    if (params?.kind === 'text') return this.writeControl(encodeTextInput(params.text));
    throw new Error('Unsupported scrcpy input kind');
  }

  observeDisplayOutput(data, channel) {
    // Observe only display events. Do not retain verbose stdout, which can
    // contain unrelated device diagnostics. Bound even a malformed long line.
    const text = (this.displayLogBuffers.get(channel) || '') + data.toString();
    const lines = text.split(/\r?\n/);
    this.displayLogBuffers.set(channel, lines.pop().slice(-2048));
    if (this.nativeTouch) {
      const change = lines.map(parseTouchGeometryChange).filter(Boolean).at(-1);
      if (change) this.touchGeometry.invalidate(change);
    }
  }

  async startNativeTouch() {
    // Only managed emulators expose this internal endpoint. USB phones retain
    // scrcpy control and the viewer composites its indicator into captures.
    if (!/^rdf-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}:5555$/.test(this.serial)) return;
    const touch = this.createEmulatorTouch({ serial: this.serial, onFailure: error => {
      if (this.nativeTouch !== touch || this.closed) return;
      this.nativeTouchReady = false;
      if (this.videoConfig) this.videoConfig.nativeTouches = false;
      this.resendConfig();
      console.warn('Native emulator touch unavailable for ' + this.sessionId + ': ' + error.message);
    } });
    this.nativeTouch = touch;
    try {
      await touch.prepare();
      const geometry = await this.touchGeometry.get();
      if (this.closed) { await touch.close(); return; }
      touch.setGeometry(geometry);
      if (!touch.isAvailable()) throw new Error('Native touch closed during display probe');
      this.nativeTouchReady = true;
      if (this.videoConfig) this.videoConfig.nativeTouches = true;
      this.resendConfig();
    } catch (error) {
      await touch.close();
      if (!this.closed) console.warn('Native emulator touch unavailable for ' + this.sessionId + ': ' + error.message);
    }
  }

  nativeInput(params, width, height) {
    if (this.nativeInputPending >= 128) {
      if (params.action === 'move') return Promise.resolve({ ok: true });
      if (params.action === 'down') throw new Error('Native touch channel is congested');
      // Always leave room for releases of already accepted contacts (at most 10).
    }
    const touch = this.nativeTouch;
    const epoch = this.inputEpoch;
    const acceptedAt = this.now();
    const deadline = Math.min(acceptedAt + this.maxInputAgeMs,
      Number.isFinite(params.inputDeadline) ? params.inputDeadline : Infinity);
    this.nativeInputPending++;
    const result = this.nativeInputTail.then(async () => {
      this.assertInputEpoch(epoch);
      if (!this.nativeTouchReady || this.nativeTouch !== touch) throw new Error('Native touch is unavailable');
      if (params.action === 'down') touch.setGeometry(await this.touchGeometry.get());
      this.assertInputEpoch(epoch);
      if (params.action !== 'up' && this.now() >= deadline) {
        if (params.action === 'move') return { ok: true };
        // Invalidate the entire queued gesture, keeping video and native transport.
        await this.releaseInput('expired');
        throw Object.assign(new Error('Native touch input expired'), { code: 'INPUT_EXPIRED' });
      }
      if (!touch.sendTouch({ ...params, width, height })) throw new Error('Native touch was not accepted');
      return { ok: true };
    });
    this.nativeInputTail = result.catch(async error => {
      if (error.code === 'INPUT_RESET' || error.code === 'INPUT_EXPIRED' || epoch !== this.inputEpoch) return;
      this.nativeTouchReady = false;
      if (this.videoConfig) this.videoConfig.nativeTouches = false;
      await touch?.close();
      if (!this.closed) this.resendConfig();
    }).finally(() => { this.nativeInputPending--; });
    return result;
  }

  touch(params) {
    this.assertInputEpoch();
    if (!this.hasControl()) throw new Error('scrcpy control is unavailable');
    const { width, height } = this.videoConfig || {};
    const message = encodeTouchEvent(params, width, height);
    const pointerId = params.pointerId ?? 0;
    if (params.action === 'down' && this.activePointers.has(pointerId)) throw new Error('Touch pointer is already down');
    if (params.action !== 'down' && !this.activePointers.has(pointerId)) throw new Error('Touch pointer is not down');
    const native = this.nativePointers.has(pointerId) ||
      (params.action === 'down' && this.nativeTouchReady && this.activePointers.size === this.nativePointers.size);
    const result = native ? this.nativeInput(params, width, height) : this.writeControl(message);
    if (!native && params.action !== 'up') this.scrcpyPointers.set(pointerId, { ...params, width, height });
    if (params.action === 'down') {
      this.activePointers.add(pointerId);
      if (native) this.nativePointers.add(pointerId);
    } else if (params.action === 'up') {
      this.activePointers.delete(pointerId);
      this.nativePointers.delete(pointerId);
      this.scrcpyPointers.delete(pointerId);
    }
    return result;
  }

  releaseInput(reason = 'disconnect') {
    if (this.inputRelease) return this.inputRelease;
    this.inputEpoch++;
    this.activePointers.clear();
    this.nativePointers.clear();
    const contacts = [...this.scrcpyPointers];
    this.scrcpyPointers.clear();
    // Release on the transport that accepted down. A lost acknowledgement must
    // never cause another down/up to be replayed over the other transport.
    for (const [pointerId, point] of contacts) {
      if (!this.hasControl()) break;
      try {
        this.controlSocket.write(encodeTouchEvent({ ...point, action: 'up', pointerId }, point.width, point.height));
      } catch { break; }
    }
    this.inputRelease = Promise.resolve(this.nativeTouch?.releaseInput()).then(() => ({ released: true }))
      .finally(() => { this.inputRelease = null; });
    return this.inputRelease;
  }

  requestKeyframe() {
    const now = Date.now();
    if (this.closed || !this.controlSocket || this.controlSocket.destroyed || now - this.lastVideoResetAt < 1000) return false;
    this.controlSocket.write(RESET_VIDEO_CONTROL_MESSAGE);
    this.lastVideoResetAt = now;
    return true;
  }

  resendConfig() {
    if (this.videoConfig?.data) this.emit({ ...this.videoConfig, sessionId: this.sessionId });
    if (this.audioEnabled && this.audioConfig) this.emit({ ...this.audioConfig, sessionId: this.sessionId });
    // A new viewer may join while Android is idle, when scrcpy emits no frames.
    // Ask the running encoder for a fresh keyframe so the viewer paints immediately.
    this.requestKeyframe();
  }

  async close() {
    if (this.closed) return;
    const released = this.releaseInput('close');
    this.closed = true;
    this.touchGeometry.close();
    this.displayLogBuffers.clear();
    this.inputAbort.abort(new Error('Stream closed'));
    await released.catch(() => {});
    this.nativeTouchReady = false;
    this.nativePointers.clear();
    await this.nativeTouch?.close();
    this.videoSocket?.destroy();
    this.audioSocket?.destroy();
    this.controlSocket?.destroy();
    this.activePointers.clear();
    this.process?.kill('SIGTERM');
    const cleanup = [];
    if (this.port) cleanup.push(runProcess('adb', ['-s', this.serial, 'forward', '--remove', `tcp:${this.port}`], { timeoutMs: 5000 }));
    if (this.deviceServerPath) cleanup.push(this.adb.run(this.serial, ['shell', 'rm', '-f', this.deviceServerPath], { timeoutMs: 5000 }));
    await Promise.allSettled(cleanup);
  }
}

export class StreamManager {
  constructor({ adb, serverPath, emit, canEmitVideo = () => true, screenshotIntervalMs = 800,
    scrcpyRetryIntervalMs = 5000, createScrcpyStream = options => new ScrcpyStream(options),
    createEmulatorAudioStream = options => new EmulatorAudioStream(options) }) {
    this.adb = adb;
    this.serverPath = serverPath;
    this.emit = emit;
    this.canEmitVideo = canEmitVideo;
    this.screenshotIntervalMs = screenshotIntervalMs;
    this.scrcpyRetryIntervalMs = scrcpyRetryIntervalMs;
    this.createScrcpyStream = createScrcpyStream;
    this.createEmulatorAudioStream = createEmulatorAudioStream;
    this.streams = new Map();
    this.audio = new Map();
    this.emulatorAudio = new Map();
  }

  async start(sessionId, serial) {
    const existing = this.streams.get(sessionId);
    if (existing?.starting) return existing.ready;
    if (existing) {
      existing.resendConfig?.();
      this.emulatorAudio.get(sessionId)?.resendConfig();
      if (!(existing instanceof ScrcpyStream)) this.scheduleScrcpyRetry(sessionId, serial, existing);
      return { mode: existing instanceof ScrcpyStream ? 'scrcpy' : 'screenshots' };
    }
    // Track startup before the first await so disconnect/stop can see it and
    // concurrent viewers share the same candidate. Cleanup waits for startup
    // to settle, including resources acquired after a stop request.
    const startup = { serial, starting: true, closed: false,
      close: async () => { startup.closed = true; await startup.ready?.catch(() => {}); } };
    this.streams.set(sessionId, startup);
    startup.ready = this.tryScrcpy(sessionId, serial, null, startup);
    return startup.ready;
  }

  scheduleScrcpyRetry(sessionId, serial, fallback) {
    if (fallback.closed || fallback.retryTimer || fallback.retrying || this.streams.get(sessionId) !== fallback) return;
    fallback.retryTimer = setTimeout(() => {
      fallback.retryTimer = null;
      if (fallback.closed || this.streams.get(sessionId) !== fallback) return;
      fallback.retrying = true;
      void this.tryScrcpy(sessionId, serial, fallback).catch(error => {
        console.warn('scrcpy retry failed for ' + sessionId + ': ' + error.message);
      }).finally(() => {
        fallback.retrying = false;
        this.scheduleScrcpyRetry(sessionId, serial, fallback);
      });
    }, this.scrcpyRetryIntervalMs);
    fallback.retryTimer.unref?.();
  }

  async tryScrcpy(sessionId, serial, fallback = null, startup = null) {
    const owner = fallback || startup;
    const cancelled = () => {
      if (!owner || (!owner.closed && this.streams.get(sessionId) === owner)) return false;
      if (startup) throw new Error('Stream startup cancelled');
      return true;
    };
    const makeStream = (audioCodec) => {
      const scrcpy = this.createScrcpyStream({ sessionId, serial, adb: this.adb, serverPath: this.serverPath,
        emit: event => {
          if (this.streams.get(sessionId) === scrcpy ||
              (startup && !startup.closed && this.streams.get(sessionId) === startup)) this.emit(event);
        },
        canEmitVideo: this.canEmitVideo, audioCodec,
        onAudioFailure: () => {
          void this.restoreEmulatorAudio(sessionId, serial, scrcpy);
        },
        audioEnabled: this.audio.get(sessionId) || false, onFailure: (error) => {
          if (this.streams.get(sessionId) !== scrcpy) return;
          console.warn(`scrcpy stream failed for ${sessionId}, switching to screenshots: ${error.message}`);
          const replacement = this.screenshotStream(sessionId, serial);
          this.streams.set(sessionId, replacement);
          this.scheduleScrcpyRetry(sessionId, serial, replacement);
          if (this.audio.get(sessionId) && !this.emulatorAudio.has(sessionId)) {
            void this.restoreEmulatorAudio(sessionId, serial, replacement);
          }
        } });
      return scrcpy;
    };
    let failure;
    for (const codec of ['opus', 'aac']) {
      if (cancelled()) return { mode: 'screenshots' };
      const scrcpy = makeStream(codec);
      if (startup) startup.candidate = scrcpy;
      try {
        await scrcpy.start();
        if (scrcpy.closed) throw scrcpy.lastError || new Error('scrcpy video stopped during startup');
        if (cancelled()) {
          await scrcpy.close();
          return { mode: 'screenshots' };
        }
        if (fallback) fallback.close();
        this.streams.set(sessionId, scrcpy);
        if (fallback) {
          console.log('scrcpy recovered for ' + sessionId + ' (video)');
          scrcpy.resendConfig();
        } else console.log('scrcpy started for ' + sessionId + ' (video)');
        if (scrcpy.audioAvailable) this.closeEmulatorAudio(sessionId);
        else if (this.audio.get(sessionId)) void this.restoreEmulatorAudio(sessionId, serial, scrcpy);
        return { mode: 'scrcpy', audioCodec: scrcpy.audioAvailable ? codec : null };
      } catch (error) {
        await scrcpy.close();
        failure = error;
        if (cancelled()) return { mode: 'screenshots' };
        if (codec === 'opus' && shouldRetryAac(error)) {
          console.warn(`scrcpy Opus encoder unavailable for ${sessionId}; retrying AAC`);
          continue;
        }
        break;
      }
    }
    if (cancelled()) return { mode: 'screenshots' };
    const activeFallback = fallback || this.screenshotStream(sessionId, serial);
    this.streams.set(sessionId, activeFallback);
    this.scheduleScrcpyRetry(sessionId, serial, activeFallback);
    if (this.audio.get(sessionId) && !this.emulatorAudio.has(sessionId)) {
      void this.restoreEmulatorAudio(sessionId, serial, activeFallback);
    }
    console.warn(`scrcpy unavailable for ${sessionId}, using screenshots: ${failure?.message || 'unknown error'}`);
    return { mode: 'screenshots', reason: failure?.message || 'unknown error' };
  }

  screenshotStream(sessionId, serial) {
    const state = { closed: false, serial, retryTimer: null, retrying: false,
      close: () => { state.closed = true; clearTimeout(state.retryTimer); state.retryTimer = null; },
      resendConfig: () => {} };
    const loop = async () => {
      while (!state.closed) {
        try {
          const frame = await this.adb.screenshot(serial);
          if (!state.closed) this.emit({ ...frame, sessionId });
        }
        catch (error) { if (!state.closed) console.warn(`Screenshot failed for ${sessionId}: ${error.message}`); }
        await new Promise((resolve) => setTimeout(resolve, this.screenshotIntervalMs));
      }
    };
    loop();
    return state;
  }

  closeEmulatorAudio(sessionId) {
    const audio = this.emulatorAudio.get(sessionId);
    this.emulatorAudio.delete(sessionId);
    audio?.close();
  }

  async startEmulatorAudio(sessionId, serial, stream) {
    if (this.streams.get(sessionId) !== stream) throw new Error('Video stream changed during audio startup');
    let audio = this.emulatorAudio.get(sessionId);
    if (!audio) {
      audio = this.createEmulatorAudioStream({
        sessionId, serial, emit: event => this.emit(event),
        onFailure: error => {
          if (this.emulatorAudio.get(sessionId) !== audio) return;
          this.emulatorAudio.delete(sessionId);
          audio.close();
          console.warn('Emulator audio failed for ' + sessionId + ': ' + error.message);
          if (this.audio.get(sessionId)) {
            this.audio.set(sessionId, false);
            this.emit({ type: 'audio-unavailable', sessionId });
          }
        },
      });
      this.emulatorAudio.set(sessionId, audio);
      audio.ready = audio.start().catch(error => {
        if (this.emulatorAudio.get(sessionId) === audio) this.emulatorAudio.delete(sessionId);
        audio.close();
        throw error;
      });
    }
    await audio.ready;
    if (this.streams.get(sessionId) !== stream || this.emulatorAudio.get(sessionId) !== audio) {
      audio.close();
      throw new Error('Video stream changed during audio startup');
    }
    return audio;
  }

  async restoreEmulatorAudio(sessionId, serial, stream) {
    if (!this.audio.get(sessionId) || this.streams.get(sessionId) !== stream) return;
    try {
      const audio = await this.startEmulatorAudio(sessionId, serial, stream);
      if (this.audio.get(sessionId) && this.streams.get(sessionId) === stream) audio.setEnabled(true);
    } catch (error) {
      if (this.streams.get(sessionId) !== stream) return;
      console.warn('Emulator audio unavailable for ' + sessionId + ': ' + error.message);
      this.audio.set(sessionId, false);
      this.emit({ type: 'audio-unavailable', sessionId });
    }
  }

  async setAudio(sessionId, enabled) {
    const stream = this.streams.get(sessionId);
    if (enabled && !stream) throw new Error('Start the emulator stream before enabling audio');
    if (enabled && stream instanceof ScrcpyStream && stream.audioAvailable) {
      this.closeEmulatorAudio(sessionId);
      stream.setAudio(true);
      this.audio.set(sessionId, true);
      return { enabled: true, available: true, codec: stream.audioCodec };
    }
    if (enabled) {
      const audio = await this.startEmulatorAudio(sessionId, stream.serial, stream);
      audio.setEnabled(true);
      this.audio.set(sessionId, true);
      return { enabled: true, available: true, codec: 'pcm-s16le' };
    }
    this.audio.set(sessionId, false);
    stream?.setAudio?.(false);
    this.closeEmulatorAudio(sessionId);
    return { enabled: false, available: stream instanceof ScrcpyStream && stream.audioAvailable };
  }

  controlStream(sessionId, serial, { release = false } = {}) {
    const current = this.streams.get(sessionId);
    // Video can arrive while start() is still probing optional audio. Keep the
    // startup owner for cancellation, but expose its already-open control socket
    // so the first visible-frame input never falls into the slow ADB queue.
    const stream = current?.starting && !current.closed ? current.candidate : current;
    if (!(stream instanceof ScrcpyStream) || (serial && stream.serial !== serial)) return null;
    if (current?.starting && !release && !stream.hasControl()) return null;
    return stream;
  }

  touch(sessionId, serial, params) {
    const stream = this.controlStream(sessionId, serial);
    if (!(stream instanceof ScrcpyStream) || stream.serial !== serial) {
      throw new Error('Live scrcpy control is unavailable for this session');
    }
    return stream.touch(params);
  }

  realtimeInput(sessionId, serial, params) {
    const stream = this.controlStream(sessionId, serial);
    if ((params?.kind === 'key' || params?.kind === 'text') &&
        stream instanceof ScrcpyStream && stream.serial === serial && stream.hasControl()) {
      // Capture this exact stream before bypassing the session command queue.
      // A later close must fail here, never run a slow adb fallback outside it.
      const epoch = stream.inputEpoch;
      return () => stream.input(params, epoch);
    }
    return null;
  }

  input(sessionId, serial, params) {
    if (params?.kind === 'touch') return this.touch(sessionId, serial, params);
    const realtime = this.realtimeInput(sessionId, serial, params);
    if (realtime) return realtime();
    // Screenshot mode and non-streaming API clients still use adb. Legacy
    // tap/swipe coordinates refer to the device, not the downscaled video.
    // Never fall back after a write failure: input might already be delivered.
    return this.adb.input(serial, params);
  }

  async releaseInput(sessionId, serial, reason = 'disconnect') {
    // A broken control socket must not prevent native-pointer cleanup.
    const stream = this.controlStream(sessionId, serial, { release: true });
    if (!(stream instanceof ScrcpyStream) || (serial && stream.serial !== serial)) return { released: false };
    return stream.releaseInput(reason);
  }

  requestKeyframe(sessionId, serial) {
    const stream = this.controlStream(sessionId, serial);
    if (!(stream instanceof ScrcpyStream) || stream.serial !== serial) return { requested: false };
    return { requested: stream.requestKeyframe() };
  }

  async stop(sessionId) {
    const stream = this.streams.get(sessionId);
    this.streams.delete(sessionId);
    this.closeEmulatorAudio(sessionId);
    if (stream) await stream.close();
  }

  async dispose(sessionId) {
    await this.stop(sessionId);
    this.audio.delete(sessionId);
  }
}
