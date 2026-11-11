import { RTCPeerConnection, useVP8, useOPUS } from 'werift';
import { EmulatorRtcSignaling, protoBytes, protoFields } from './emulator-rtc-signaling.mjs';
import { EmulatorTouchController } from './emulator-touch.mjs';
import { NativeVp8Frames } from './native-rtc-media.mjs';
import { OpusRtpClock, opusPacketSamples } from './rtc-media.mjs';
import { diagnostic } from './diagnostics.mjs';

const KEYS = new Map([[3, 'GoHome'], [4, 'GoBack'], [19, 'ArrowUp'], [20, 'ArrowDown'], [21, 'ArrowLeft'], [22, 'ArrowRight'],
  [23, 'Enter'], [24, 'AudioVolumeUp'], [25, 'AudioVolumeDown'], [26, 'Power'], [61, 'Tab'], [66, 'Enter'], [67, 'Backspace'],
  [82, 'ContextMenu'], [111, 'Escape'], [164, 'AudioVolumeMute'], [187, 'AppSwitch']]);
const keyEvent = (key, event = 2) => Buffer.concat([Buffer.from([16, event]), protoBytes(4, Buffer.from(key))]);
const opusHead = Buffer.alloc(19); opusHead.write('OpusHead'); opusHead[8] = 1; opusHead[9] = 2; opusHead.writeUInt32LE(48000, 12);

export class NativeEmulatorStream {
  constructor({ sessionId, serial, emit, canEmitVideo = () => true, audioEnabled = false, onFailure,
    createPeer = options => new RTCPeerConnection(options), createSignaling = options => new EmulatorRtcSignaling(options),
    createTouch = options => new EmulatorTouchController(options), startTimeoutMs = 20000, now = Date.now }) {
    Object.assign(this, { sessionId, serial, emit, canEmitVideo, audioEnabled, onFailure, createPeer, createSignaling, createTouch, startTimeoutMs, now });
    this.mode = 'emulator-rtc'; this.inputEpoch = 0; this.closed = false; this.audioAvailable = false; this.audioCodec = 'opus';
    this.audioClock = new OpusRtpClock(); this.signalTail = Promise.resolve(); this.signalCount = 0;
    this.lastPli = -Infinity; this.videoNeedsKeyframe = true;
    this.pendingInputs = new Set(); this.inputReset = null;
    this.frames = new NativeVp8Frames({ requestKeyframe: () => this.requestKeyframe() });
  }
  async start() {
    this.ready = new Promise((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; });
    // Observe rejection immediately, including when the gRPC startup fails first.
    void this.ready.catch(() => {});
    this.startTimer = setTimeout(() => this.fail(new Error(diagnostic('native.rtc.frame_timeout'))), this.startTimeoutMs);
    try {
      this.touchControl = this.createTouch({ serial: this.serial, onFailure: error => this.fail(error) });
      this.naturalSize = await this.touchControl.prepare();
      await this.touchControl.rpc('sendKey', keyEvent('WakeUp'));
      this.assertOpen();
      this.pc = this.createPeer({ codecs: { video: [useVP8()], audio: [useOPUS()] }, iceServers: [],
        iceLite: true, iceUseIpv6: false, iceUseTcp: false, bundlePolicy: 'max-bundle' });
      this.pc.onTrack.subscribe(track => {
        track.onReceiveRtp.subscribe(packet => {
          if (this.closed) return;
          if (track.kind === 'video') this.videoPacket(packet); else this.audioPacket(packet);
        });
      });
      this.pc.onDataChannel.subscribe(channel => channel.close());
      this.pc.connectionStateChange.subscribe(state => {
        if (state === 'connected') { this.requestKeyframe(); this.scheduleSnapshot(); }
        else if (state === 'failed' || state === 'closed') this.fail(new Error(diagnostic('native.rtc.closed')));
      });
      this.signaling = this.createSignaling({ serial: this.serial, onFailure: error => this.fail(error) });
      await this.signaling.start(message => this.signal(message));
      await this.ready;
    } catch (error) { await this.close(); throw error; }
  }
  signal(message) {
    if (this.closed) return;
    if (!message || typeof message !== 'object' || ++this.signalCount > 64) return this.fail(new Error(diagnostic('native.grpc.invalid')));
    this.signalTail = this.signalTail.then(async () => {
      this.assertOpen();
      if (typeof message.sdp === 'string') {
        if (message.type !== 'offer' || message.sdp.length > 128 * 1024 || this.offered) throw new Error(diagnostic('native.grpc.invalid'));
        this.offered = true;
        await this.pc.setRemoteDescription({ type: 'offer', sdp: message.sdp }); this.assertOpen();
        for (const transceiver of this.pc.getTransceivers()) transceiver.setDirection('recvonly');
        const transceiver = this.pc.getTransceivers().find(item => item.kind === 'video');
        this.videoReceiver = transceiver?.receiver;
        this.videoSsrc = Number(message.sdp.match(/a=ssrc:(\d+)/)?.[1]);
        await this.pc.setLocalDescription(await this.pc.createAnswer()); this.assertOpen();
        await this.signaling.send({ type: 'answer', sdp: this.pc.localDescription.sdp });
      } else if (message.candidate) {
        const candidate = typeof message.candidate === 'string' ? { candidate: message.candidate, sdpMid: message.sdpMid, sdpMLineIndex: message.sdpMLineIndex } : message.candidate;
        if (typeof candidate.candidate !== 'string' || candidate.candidate.length > 2048) throw new Error(diagnostic('native.grpc.invalid'));
        await this.pc.addIceCandidate(candidate);
      } else if (message.bye) throw new Error(diagnostic('native.rtc.closed'));
    }).catch(error => this.fail(error)).finally(() => { this.signalCount--; });
  }
  videoPacket(packet) {
    const frame = this.frames.push(packet);
    if (!frame) return;
    this.lastVideoAt = this.now();
    if (frame.keyframe) {
      this.videoConfig = { type: 'video-config', codec: 'vp8', data: null, width: frame.width, height: frame.height, nativeTouches: true };
      // RTC peers need codec metadata before they can be admitted as viewers.
      this.resendConfig();
      this.markReady();
    }
    if (!this.canEmitVideo(this.sessionId)) { this.videoNeedsKeyframe = true; return; }
    if (this.videoNeedsKeyframe && !frame.keyframe) { this.requestKeyframe(); return; }
    if (frame.keyframe) this.videoNeedsKeyframe = false;
    this.emit({ type: 'video-frame', codec: 'vp8', sessionId: this.sessionId, data: frame.data.toString('base64'), keyframe: frame.keyframe, timestamp: frame.timestamp });
  }
  markReady() {
    if (!this.started) { this.started = true; clearTimeout(this.startTimer); this.resolveReady(); }
  }
  scheduleSnapshot() {
    if (this.closed || this.snapshotTimer || this.snapshotFlight) return;
    this.snapshotTimer = setTimeout(() => {
      this.snapshotTimer = null;
      if (this.closed || (this.lastVideoAt !== undefined && this.now() - this.lastVideoAt < 1000)) return;
      void this.snapshot().catch(() => { if (!this.started) this.scheduleSnapshot(); });
    }, 1000);
  }
  snapshot() {
    if (this.snapshotFlight) return this.snapshotFlight;
    this.snapshotFlight = (async () => {
      // The emulator may not resend a static framebuffer after SDP negotiation.
      // Seed the viewer once, without a redraw or a permanent screenshot poll.
      const image = protoFields(await this.signaling.snapshot(), 8 * 1024 * 1024); this.assertOpen();
      const format = protoFields(image.get(1)), data = image.get(4), width = format.get(3), height = format.get(4);
      if (!Buffer.isBuffer(data) || !data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
          !Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 8192 || height > 8192) throw new Error(diagnostic('native.rtc.input'));
      if (this.lastVideoAt !== undefined && this.now() - this.lastVideoAt < 1000) return;
      this.videoConfig ??= { type: 'video-config', codec: 'vp8', data: null, width, height, nativeTouches: true };
      this.resendConfig();
      if (this.canEmitVideo(this.sessionId)) this.emit({ type: 'frame', sessionId: this.sessionId, mime: 'image/png', width, height, data: data.toString('base64'), nativeTouches: true });
      this.markReady();
    })().finally(() => { this.snapshotFlight = null; });
    return this.snapshotFlight;
  }
  audioPacket(packet) {
    try {
      if (this.audioSource === 'fallback') return;
      const samples = opusPacketSamples(packet.payload);
      if (!this.audioAvailable) { this.audioAvailable = true; this.resendConfig(); }
      const { position } = this.audioClock.accept(Math.round(packet.header.timestamp * 1000000 / 48000), samples, this.now());
      if (this.audioEnabled) this.emit({ type: 'audio-frame', sessionId: this.sessionId, codec: 'opus', data: packet.payload.toString('base64'), timestamp: Math.round(position * 1000000 / 48000), duration: samples * 1000000 / 48000 });
    } catch { /* Invalid audio must not interrupt video or enter the decoder. */ }
  }
  resendConfig(request = false) {
    if (this.closed) return;
    if (this.videoConfig) this.emit({ ...this.videoConfig, sessionId: this.sessionId });
    if (this.audioEnabled && this.audioAvailable) this.emit({ type: 'audio-config', sessionId: this.sessionId, codec: 'opus', sampleRate: 48000, channels: 2, data: opusHead.toString('base64') });
    if (request) { this.videoNeedsKeyframe = true; this.requestKeyframe(); this.scheduleSnapshot(); }
  }
  requestKeyframe() {
    if (this.closed || !this.videoReceiver || !Number.isInteger(this.videoSsrc) || this.now() - this.lastPli < 500) return false;
    this.lastPli = this.now();
    void this.videoReceiver.sendRtcpPLI(this.videoSsrc).catch(error => this.fail(error)); return true;
  }
  selectAudioSource() {
    // An SDP track is not evidence of media. Keep one source for this stream,
    // so a late Opus packet cannot interrupt the selected audio decoder.
    this.audioSource = this.audioAvailable ? 'opus' : 'fallback';
    if (!this.audioAvailable) this.audioEnabled = false;
  }
  setAudio(enabled) { this.audioEnabled = enabled && this.audioSource !== 'fallback'; this.resendConfig(); }
  hasControl() { return this.started && !this.closed && !this.inputReset; }
  canInput(params) { return params?.kind === 'key' ? KEYS.has(params.keyCode) : ['touch', 'text'].includes(params?.kind); }
  assertOpen(epoch = this.inputEpoch) {
    if (this.closed || epoch !== this.inputEpoch) throw new Error(diagnostic('native.rtc.closed'));
  }
  async geometry() {
    // Native capture rotates the natural framebuffer using the emulator's
    // sensor orientation. Its own metadata, rather than an ADB display query,
    // therefore defines the coordinates shown by this particular source.
    const image = protoFields(await this.touchControl.rpc('getScreenshot', Buffer.from([24, 1, 32, 1])));
    const format = protoFields(image.get(1));
    const rotation = format.has(2) ? protoFields(format.get(2)).get(1) ?? 0 : 0;
    if (!image.get(4)?.length || !Number.isInteger(rotation) || rotation < 0 || rotation > 3) throw new Error(diagnostic('native.rtc.input'));
    this.touchControl.setGeometry({ ...this.naturalSize, rotation });
  }
  trackInput(operation) {
    if (this.closed || this.inputReset) return Promise.reject(new Error(diagnostic('native.rtc.closed')));
    const result = Promise.resolve().then(operation);
    this.pendingInputs.add(result);
    void result.finally(() => this.pendingInputs.delete(result)).catch(() => {});
    return result;
  }
  touch(params) { const epoch = this.inputEpoch; return this.trackInput(() => this.performTouch(params, epoch)); }
  async performTouch(params, epoch) {
    this.assertOpen(epoch);
    if (params.action === 'down') await this.geometry();
    this.assertOpen(epoch);
    if (!this.touchControl.sendTouch({ ...params, width: this.videoConfig.width, height: this.videoConfig.height })) throw new Error(diagnostic('native.rtc.input'));
    return { ok: true };
  }
  input(params, epoch = this.inputEpoch) { return this.trackInput(() => this.performInput(params, epoch)); }
  async performInput(params, epoch) {
    this.assertOpen(epoch);
    if (params.inputDeadline !== undefined && this.now() >= params.inputDeadline) throw new Error(diagnostic('native.rtc.input'));
    if (params.kind === 'touch') return this.touch(params);
    if (params.kind === 'key' && KEYS.has(params.keyCode)) await this.touchControl.rpc('sendKey', keyEvent(KEYS.get(params.keyCode)));
    else if (params.kind === 'text') {
      await this.touchControl.rpc('setClipboard', protoBytes(1, Buffer.from(params.text)));
      this.assertOpen(epoch); this.controlHeld = true;
      try { await this.touchControl.rpc('sendKey', keyEvent('Control', 0)); this.assertOpen(epoch); await this.touchControl.rpc('sendKey', keyEvent('v')); }
      finally { await this.releaseModifiers(); }
    } else throw new Error(diagnostic('native.rtc.input'));
    return { ok: true };
  }
  async releaseModifiers() {
    if (!this.controlHeld) return;
    try { await this.touchControl.rpc('sendKey', keyEvent('Control', 1)); } finally { this.controlHeld = false; }
  }
  releaseInput() {
    if (this.inputReset) return this.inputReset;
    this.inputEpoch++;
    this.inputReset = (async () => {
      await Promise.allSettled([...this.pendingInputs]);
      await Promise.all([this.touchControl?.releaseInput(), this.releaseModifiers()]); return { released: true };
    })().finally(() => { this.inputReset = null; });
    return this.inputReset;
  }
  fail(error) {
    if (this.closed) return;
    this.lastError = error; this.rejectReady?.(error);
    void this.close(); if (this.started) this.onFailure?.(error);
  }
  close() {
    if (this.closing) return this.closing;
    this.closed = true; clearTimeout(this.startTimer); clearTimeout(this.snapshotTimer);
    this.rejectReady?.(new Error(diagnostic('native.rtc.closed')));
    this.closing = (async () => {
      await this.releaseInput().catch(() => {});
      await Promise.allSettled([this.signaling?.close(), this.pc?.close(), this.touchControl?.close()]);
      this.frames.discard(); this.videoConfig = null;
    })();
    return this.closing;
  }
}
