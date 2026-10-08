import { randomInt } from 'node:crypto';
import { RTCPeerConnection, MediaStreamTrack, RtpPacket, RtpHeader, useH264, useOPUS } from 'werift';
import { packetizeH264, h264Profile, rtpTimestamp, opusPacketSamples, OpusRtpClock } from './rtc-media.mjs';
import { loadRtcConfig } from './rtc-config.mjs';
import { INPUT_MAX_AGE_MS } from './input-gate.mjs';

const PEER_ID = /^[a-zA-Z0-9-]{8,64}$/;
const LEASE_MS = 10_000;
const MEDIA_LIMITS = {
  video: { count: 4, ageMs: 120, bytes: 4 * 1024 * 1024 },
  audio: { count: 8, ageMs: 150, bytes: 128 * 1024 },
};

// DataChannel bypasses the HTTP validator, so accept only the same narrow
// Android input vocabulary. Nothing on this channel can run a shell command.
export function rtcInputParams(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid input');
  const { kind } = value;
  const coord = key => {
    const n = value[key];
    if (!Number.isInteger(n) || n < 0 || n > 8192) throw new Error('Invalid coordinates');
    return n;
  };
  if (kind === 'touch') {
    if (!['down', 'move', 'up'].includes(value.action) || value.pointerId !== 0) throw new Error('Invalid touch');
    return { kind, action: value.action, pointerId: 0, x: coord('x'), y: coord('y') };
  }
  if (kind === 'key') {
    if (!Number.isInteger(value.keyCode) || value.keyCode < 1 || value.keyCode > 300) throw new Error('Invalid key');
    return { kind, keyCode: value.keyCode };
  }
  if (kind === 'text') {
    if (typeof value.text !== 'string' || value.text.length > 1000 || /[\r\n\0]/.test(value.text)) throw new Error('Invalid text');
    return { kind, text: value.text };
  }
  if (kind === 'tap') return { kind, x: coord('x'), y: coord('y') };
  if (kind === 'swipe') {
    const durationMs = value.durationMs ?? 300;
    if (!Number.isInteger(durationMs) || durationMs < 50 || durationMs > 5000) throw new Error('Invalid swipe duration');
    return { kind, x1: coord('x1'), y1: coord('y1'), x2: coord('x2'), y2: coord('y2'), durationMs };
  }
  throw new Error('Unknown input kind');
}

function timeout(promise, ms, message) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })])
    .finally(() => clearTimeout(timer));
}

export class WebRtcManager {
  constructor({ streams, config = loadRtcConfig(), input, openInput, releaseInput,
    createPeer = options => new RTCPeerConnection(options), now = Date.now }) {
    this.streams = streams;
    this.config = config;
    this.input = input;
    this.openInput = openInput;
    this.releaseInput = releaseInput;
    this.createPeer = createPeer;
    this.now = now;
    this.peers = new Map();
    this.videoConfigs = new Map();
    this.audioConfigs = new Map();
    this.audioClocks = new Map();
  }

  capabilities() {
    return { available: this.config.enabled, iceServers: this.config.enabled ? this.config.iceServers : [],
      ...(!this.config.enabled ? { reason: 'WebRTC не включён на узле.' } : {}) };
  }

  hasPeers(sessionId) {
    return [...this.peers.values()].some(p => !p.closed && p.sessionId === sessionId);
  }

  async offer(sessionId, serial, { peerId, description, canControl }) {
    if (!this.config.enabled) throw new Error('WebRTC не включён на узле.');
    if (!PEER_ID.test(peerId) || !description || description.type !== 'offer' ||
        typeof description.sdp !== 'string' || description.sdp.length > 128 * 1024 ||
        !description.sdp.includes('m=video ') || !description.sdp.includes('m=application ')) throw new Error('Invalid WebRTC offer');
    if (this.peers.has(peerId)) throw new Error('WebRTC peer already exists');
    if (this.peers.size >= 32 || [...this.peers.values()].filter(p => p.sessionId === sessionId).length >= 8) throw new Error('WebRTC viewer limit reached');
    const stream = this.streams.streams.get(sessionId);
    const videoConfig = this.videoConfigs.get(sessionId) || stream?.videoConfig;
    if (!videoConfig?.data) throw new Error('Видеопоток ещё не готов. Дождитесь подключения scrcpy.');
    const profile = h264Profile(Buffer.from(videoConfig.data, 'base64'));
    const pc = this.createPeer({
      codecs: { video: [useH264({ parameters: `profile-level-id=${profile};packetization-mode=1;level-asymmetry-allowed=1` })], audio: [useOPUS()] },
      iceServers: this.config.iceServers,
      icePortRange: this.config.icePortRange,
      iceAdditionalHostAddresses: this.config.addresses,
      iceUseIpv6: false, iceUseTcp: false, bundlePolicy: 'max-bundle', maxMessageSize: 8192,
    });
    const peer = { pc, peerId, sessionId, serial, canControl: canControl === true, closed: false,
      lastLease: this.now(), lastControl: this.now(), inputActivity: 0, needsKeyframe: true, lastKeyframeAt: 0, keyframeRequestRevision: 0,
      videoSeq: randomInt(65536), audioSeq: randomInt(65536), windowAt: this.now(), count: 0,
      videoBusy: false, audioBusy: false, videoGeneration: 0, videoQueue: [], audioQueue: [],
      lastVideoTimestamp: null, lastAudioTimestamp: null, audioNextTimestamp: null, audioGeneration: 0, channel: null };
    this.peers.set(peerId, peer);
    peer.timer = setInterval(() => {
      if (!peer.closed && (this.now() - peer.lastLease > LEASE_MS || (peer.channel && this.now() - peer.lastControl > 8000))) void this.closePeer(peer);
    }, 1000);
    peer.timer.unref?.();
    try {
      if (peer.canControl) {
        peer.inputOpening = Promise.resolve(this.openInput(sessionId, peerId));
        await peer.inputOpening;
      }
      const assertOpen = () => { if (peer.closed) throw new Error('WebRTC peer closed during negotiation'); };
      assertOpen();
      peer.videoTrack = new MediaStreamTrack({ kind: 'video' });
      peer.audioTrack = new MediaStreamTrack({ kind: 'audio' });
      peer.videoSender = pc.addTrack(peer.videoTrack);
      peer.audioSender = pc.addTrack(peer.audioTrack);
      peer.videoSender.onPictureLossIndication.subscribe(() => this.requestKeyframe(peer));
      pc.onDataChannel.subscribe(channel => this.bindControl(peer, channel));
      pc.connectionStateChange.subscribe(state => {
        if (state === 'connected') { peer.lastControl = this.now(); this.requestKeyframe(peer); }
        else if (state === 'failed' || state === 'closed') void this.closePeer(peer);
      });
      await timeout((async () => {
        await pc.setRemoteDescription(description);
        assertOpen();
        const answer = await pc.createAnswer();
        assertOpen();
        await pc.setLocalDescription(answer);
        assertOpen();
      })(), 12_000, 'WebRTC negotiation timed out');
      if (peer.closed || !pc.localDescription?.sdp || !/m=video [1-9]/.test(pc.localDescription.sdp)) throw new Error('WebRTC H.264 negotiation failed');
      return { peerId, description: { type: 'answer', sdp: pc.localDescription.sdp } };
    } catch (error) {
      await this.closePeer(peer);
      throw error;
    }
  }

  renew(sessionId, peerId) {
    const peer = this.peers.get(peerId);
    if (peer && peer.sessionId === sessionId && !peer.closed) peer.lastLease = this.now();
    return { renewed: Boolean(peer && peer.sessionId === sessionId && !peer.closed),
      inputActivity: peer && peer.sessionId === sessionId && !peer.closed ? peer.inputActivity : 0 };
  }

  bindControl(peer, channel) {
    if (peer.closed || peer.channel || channel.label !== 'control' || !channel.ordered ||
        channel.maxRetransmits != null || channel.maxPacketLifeTime != null) { channel.close(); return; }
    peer.channel = channel;
    const ready = () => {
      peer.lastControl = this.now();
      this.send(peer, { type: 'ready', inputEpoch: peer.peerId, serverTime: this.now(), inputMaxAgeMs: INPUT_MAX_AGE_MS });
      this.requestKeyframe(peer);
    };
    channel.stateChange.subscribe(state => {
      if (state === 'open') ready();
      if (state === 'closed') void this.closePeer(peer);
    });
    if (channel.readyState === 'open') ready();
    channel.onMessage.subscribe(data => {
      if (peer.closed || this.now() - peer.lastLease > LEASE_MS) return;
      if (Buffer.byteLength(data) > 8192) { this.inputError(peer, new Error('Input message exceeds the limit')); void this.closePeer(peer); return; }
      let message;
      try { message = JSON.parse(String(data)); } catch { this.inputError(peer, new Error('Invalid input message')); void this.closePeer(peer); return; }
      if (!message || typeof message !== 'object') return;
      if (this.now() - peer.windowAt >= 1000) { peer.windowAt = this.now(); peer.count = 0; }
      if (++peer.count > 90) { this.inputError(peer, new Error('Input rate limit exceeded')); void this.closePeer(peer); return; }
      peer.lastControl = this.now();
      if (message.type === 'ping') {
        if (typeof message.id === 'string' && message.id.length <= 80 || Number.isSafeInteger(message.id)) {
          this.send(peer, { type: 'pong', id: message.id, serverTime: this.now() });
        }
        return;
      }
      if (message.type !== 'input') return;
      if (message.epoch !== peer.peerId) { this.inputError(peer, Object.assign(new Error('Input connection changed.'), {code: 'input_closed'}), message.seq); return; }
      if (!peer.canControl) { this.send(peer, { type: 'input-error', code: 'readonly', seq: message.seq, message: 'Доступ только для просмотра.' }); return; }
      try {
        const params = rtcInputParams(message);
        const meta = { epoch: message.epoch, seq: message.seq, deadline: message.deadline };
        Promise.resolve(this.input(peer.sessionId, peer.peerId, meta, params)).then(() => {
          peer.inputActivity++;
          this.send(peer, { type: 'input-ack', seq: message.seq, serverTime: this.now() });
        }, error => this.inputError(peer, error, message.seq));
      } catch (error) { this.inputError(peer, error, message.seq); }
    });
  }

  inputError(peer, error, seq) {
    this.send(peer, { type: 'input-error', code: error.code || 'invalid_input', message: error.message || 'Input failed', seq });
    // Validation can fail before InputGate sees an up. Release only this peer's
    // epoch, so a malformed/expired gesture cannot remain down or reset a
    // different viewer's contact. The frontend reconnects after input-error.
    if (peer.canControl) void Promise.resolve(this.releaseInput(peer.sessionId, peer.peerId)).catch(() => {});
  }

  send(peer, data) {
    if (!peer.closed && peer.channel?.readyState === 'open' && peer.channel.bufferedAmount < 32 * 1024) peer.channel.send(JSON.stringify(data));
  }

  requestKeyframe(peer) {
    peer.needsKeyframe = true;
    peer.videoQueue.length = 0;
    peer.keyframeRequestRevision++;
    if (this.now() - peer.lastKeyframeAt < 1000) return;
    peer.lastKeyframeAt = this.now();
    Promise.resolve(this.streams.requestKeyframe(peer.sessionId, peer.serial)).catch(() => {});
  }

  publish(event) {
    if (!this.config.enabled) return;
    if (event.type === 'video-config') {
      const previous = this.videoConfigs.get(event.sessionId);
      this.videoConfigs.set(event.sessionId, event);
      if (previous?.data !== event.data || previous?.width !== event.width || previous?.height !== event.height) {
        for (const peer of this.peers.values()) if (peer.sessionId === event.sessionId) {
          peer.videoGeneration++;
          peer.videoQueue.length = 0;
          peer.lastVideoTimestamp = null;
          peer.needsKeyframe = true;
        }
      }
    }
    if (event.type === 'audio-config') {
      const previous = this.audioConfigs.get(event.sessionId);
      this.audioConfigs.set(event.sessionId, event);
      if (previous?.data !== event.data || previous?.codec !== event.codec) {
        this.audioClocks.get(event.sessionId)?.reset();
        this.resetAudioPeers(event.sessionId);
      }
    }
    if (!['video-frame', 'audio-frame'].includes(event.type)) return;
    const kind = event.type === 'video-frame' ? 'video' : 'audio';
    if (kind === 'audio') {
      if (event.codec !== 'opus') return; // PCM/AAC are explicitly relayed via WSS.
      try {
        if (typeof event.data !== 'string' || Buffer.byteLength(event.data, 'base64') > MEDIA_LIMITS.audio.bytes) return;
        const samples = opusPacketSamples(Buffer.from(event.data, 'base64'));
        let clock = this.audioClocks.get(event.sessionId);
        if (!clock) { clock = new OpusRtpClock(); this.audioClocks.set(event.sessionId, clock); }
        const { position, discontinuity } = clock.accept(event.timestamp, samples, this.now());
        if (discontinuity) this.resetAudioPeers(event.sessionId);
        event = { ...event, audioSamplePosition: position, audioSampleCount: samples };
      } catch { return; }
    }
    for (const peer of this.peers.values()) {
      if (peer.closed || peer.sessionId !== event.sessionId || peer.pc.connectionState !== 'connected') continue;
      this.enqueueMedia(peer, kind, event);
    }
  }

  resetAudioPeers(sessionId) {
    for (const peer of this.peers.values()) if (peer.sessionId === sessionId) {
      peer.audioGeneration++;
      peer.audioQueue.length = 0;
      peer.lastAudioTimestamp = peer.audioNextTimestamp = null;
    }
  }

  invalidateVideo(peer) {
    // A lost access unit can invalidate every dependent delta, including one
    // currently split into RTP packets. Only a later complete IDR can recover.
    peer.videoGeneration++;
    this.requestKeyframe(peer);
  }

  enqueueMedia(peer, kind, event) {
    const limits = MEDIA_LIMITS[kind];
    const queue = peer[`${kind}Queue`];
    const timestampKey = kind === 'video' ? 'lastVideoTimestamp' : 'lastAudioTimestamp';
    const bytes = typeof event.data === 'string' ? Buffer.byteLength(event.data, 'base64') : 0;
    const position = kind === 'video' ? event.timestamp : event.audioSamplePosition;
    if (!Number.isSafeInteger(position) || position < 0 || !bytes || bytes > limits.bytes ||
        (peer[timestampKey] != null && position <= peer[timestampKey])) {
      if (kind === 'video') this.invalidateVideo(peer);
      return;
    }
    peer[timestampKey] = position;
    const now = this.now();
    const expired = item => now - item.receivedAt > limits.ageMs ||
      position - item.position > limits.ageMs * (kind === 'video' ? 1000 : 48);
    if (kind === 'video') {
      if (queue.length && (expired(queue[0]) || queue.length >= limits.count ||
          queue.reduce((sum, item) => sum + item.bytes, bytes) > limits.bytes)) this.invalidateVideo(peer);
      // An in-flight or queued IDR may establish the dependency chain once
      // sent. After PLI/config/overflow its revision no longer qualifies.
      const keyframeAhead = (peer.videoBusy && peer.videoSendingKeyframe &&
        peer.videoSendingGeneration === peer.videoGeneration && peer.videoSendingRevision === peer.keyframeRequestRevision) ||
        queue.some(item => item.event.keyframe);
      if (peer.needsKeyframe && !event.keyframe && !keyframeAhead) { this.requestKeyframe(peer); return; }
    } else {
      // Preserve short bursts; when congested retain only still-fresh audio.
      // Audio packets are independently decodable, unlike dependent P frames.
      while (queue.length && (expired(queue[0]) || queue.length >= limits.count ||
          queue.reduce((sum, item) => sum + item.bytes, bytes) > limits.bytes)) queue.shift();
    }
    queue.push({ event, receivedAt: now, bytes, position });
    this.drainMedia(peer, kind);
  }

  drainMedia(peer, kind) {
    if (peer.closed || peer[`${kind}Busy`]) return;
    const queue = peer[`${kind}Queue`];
    const limits = MEDIA_LIMITS[kind];
    while (queue.length) {
      const item = queue.shift();
      if (this.now() - item.receivedAt > limits.ageMs) {
        if (kind === 'video') { this.invalidateVideo(peer); return; }
        continue;
      }
      if (kind === 'video' && peer.needsKeyframe && !item.event.keyframe) { this.requestKeyframe(peer); return; }
      void this.sendMedia(peer, kind, item);
      return;
    }
  }

  async sendMedia(peer, kind, item) {
    const { event, receivedAt } = item;
    peer[`${kind}Busy`] = true;
    const generation = peer.videoGeneration;
    const audioGeneration = peer.audioGeneration;
    const keyframeRequestRevision = peer.keyframeRequestRevision;
    if (kind === 'video') {
      peer.videoSendingKeyframe = event.keyframe;
      peer.videoSendingGeneration = generation;
      peer.videoSendingRevision = keyframeRequestRevision;
    }
    try {
      const sender = peer[`${kind}Sender`];
      if (!sender.codec || peer.closed) return;
      let bytes = Buffer.from(event.data, 'base64');
      if (kind === 'video' && event.keyframe) {
        const config = this.videoConfigs.get(peer.sessionId);
        if (config?.data) bytes = Buffer.concat([Buffer.from(config.data, 'base64'), bytes]);
      }
      const timestamp = kind === 'video' ? rtpTimestamp(event.timestamp, 90000) : event.audioSamplePosition >>> 0;
      const audioSamples = kind === 'audio' ? event.audioSampleCount : 0;
      const packets = kind === 'video' ? packetizeH264(bytes) : [{ payload: bytes,
        marker: peer.audioNextTimestamp == null || peer.audioNextTimestamp !== timestamp }];
      for (const { payload, marker } of packets) {
        if (peer.closed || (kind === 'video' && generation !== peer.videoGeneration)) return;
        if (this.now() - receivedAt > MEDIA_LIMITS[kind].ageMs) {
          if (kind === 'video') this.invalidateVideo(peer);
          return;
        }
        const sequenceNumber = peer[`${kind}Seq`]++ & 0xffff;
        const rtp = new RtpPacket(new RtpHeader({ payloadType: sender.codec.payloadType, sequenceNumber, timestamp, marker, ssrc: sender.ssrc }), payload);
        await sender.sendRtp(rtp);
      }
      if (kind === 'audio' && audioGeneration === peer.audioGeneration) peer.audioNextTimestamp = (timestamp + audioSamples) >>> 0;
      if (kind === 'video' && generation === peer.videoGeneration &&
          keyframeRequestRevision === peer.keyframeRequestRevision) peer.needsKeyframe = false;
    } catch {
      if (kind === 'video') this.invalidateVideo(peer);
    } finally {
      peer[`${kind}Busy`] = false;
      this.drainMedia(peer, kind);
    }
  }

  close(sessionId, peerId) {
    const peer = this.peers.get(peerId);
    if (!peer || peer.sessionId !== sessionId) return Promise.resolve();
    return this.closePeer(peer);
  }

  closePeer(peer) {
    if (peer.closing) return peer.closing;
    peer.closed = true;
    clearInterval(peer.timer);
    peer.videoQueue.length = peer.audioQueue.length = 0;
    peer.closing = Promise.resolve().then(async () => {
      if (peer.canControl) {
        // If closing races with opening the input epoch, its eventual opening
        // must be released too. No media/negotiation resumes after this await.
        await peer.inputOpening?.catch(() => {});
        await Promise.resolve(this.releaseInput(peer.sessionId, peer.peerId)).catch(() => {});
      }
      peer.videoTrack?.stop(); peer.audioTrack?.stop();
      await peer.pc.close().catch(() => {});
    }).finally(() => { if (this.peers.get(peer.peerId) === peer) this.peers.delete(peer.peerId); });
    return peer.closing;
  }

  async closeSession(sessionId) {
    await Promise.allSettled([...this.peers.values()].filter(p => p.sessionId === sessionId).map(p => this.close(sessionId, p.peerId)));
    this.videoConfigs.delete(sessionId); this.audioConfigs.delete(sessionId); this.audioClocks.delete(sessionId);
  }

  async closeAll() {
    await Promise.allSettled([...this.peers.values()].map(p => this.close(p.sessionId, p.peerId)));
    this.videoConfigs.clear(); this.audioConfigs.clear(); this.audioClocks.clear();
  }
}
