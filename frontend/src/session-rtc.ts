import { t } from './i18n';
import { HEARTBEAT_INTERVAL_MS, HEARTBEAT_TIMEOUT_MS, INPUT_BUFFER_LIMIT, StreamControl } from './stream-control';

export type RtcConfiguration = { available: boolean; iceServers?: RTCIceServer[]; reason?: string };
type Callbacks = {
  signal(message: Record<string, unknown>): void;
  canvas(): HTMLCanvasElement | null;
  frame(width: number, height: number): void;
  control(ready: boolean): void;
  rtt(value: number): void;
  stats(value: { iceRttMs: number | null; packetsLost: number | null }): void;
  audio(needsGesture: boolean, notice: string): void;
  audioPacket(): void;
  error(message: string, permanent?: boolean): void;
};

/** Native WebRTC media tracks and an authenticated, bounded control channel. */
export function createSessionRtc(callbacks: Callbacks, audioEnabled: boolean) {
  let peer: RTCPeerConnection | null = null;
  let channel: RTCDataChannel | null = null;
  let closed = false;
  let started = false;
  let gatheringTimer: number | undefined;
  let heartbeatTimer: number | undefined;
  let statsTimer: number | undefined;
  let disconnectedTimer: number | undefined;
  let videoFrame: number | undefined;
  let animationFrame: number | undefined;
  let lastAudioPackets = 0;
  let lastDrawnTime = -1;
  let cancelGather: (() => void) | null = null;
  let audioAllowed = audioEnabled;
  let hasAudio = false;
  let ready = false;
  let authenticated = false;
  let openedAt = 0;
  const control = new StreamControl();
  const video = document.createElement('video');
  video.autoplay = true; video.muted = true; video.playsInline = true;
  const audio = document.createElement('audio');
  audio.autoplay = true; audio.muted = !audioAllowed;
  const fail = (message: string, permanent = false) => {
    if (closed) return;
    ready = false;
    callbacks.control(false);
    callbacks.error(message, permanent);
  };
  const playAudio = async () => {
    if (closed || !hasAudio || !audioAllowed) return;
    try {
      await audio.play();
      if (!closed) callbacks.audio(false, '');
    } catch {
      if (!closed) callbacks.audio(true, t('ui.3b0cbc5e4cdc'));
    }
  };
  const draw = () => {
    if (closed) return;
    if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && video.videoWidth && video.videoHeight && video.currentTime !== lastDrawnTime) {
      lastDrawnTime = video.currentTime;
      const canvas = callbacks.canvas();
      if (canvas) {
        if (canvas.width !== video.videoWidth) canvas.width = video.videoWidth;
        if (canvas.height !== video.videoHeight) canvas.height = video.videoHeight;
        canvas.getContext('2d')?.drawImage(video, 0, 0);
        callbacks.frame(video.videoWidth, video.videoHeight);
      }
    }
    if ('requestVideoFrameCallback' in video) videoFrame = video.requestVideoFrameCallback(draw);
    else animationFrame = requestAnimationFrame(draw);
  };
  const sendPing = () => {
    if (closed || channel?.readyState !== 'open') return;
    const now = performance.now();
    if (now - (authenticated ? control.lastPongAt : openedAt) >= HEARTBEAT_TIMEOUT_MS) {
      fail(t('ui.cbdd82ab2c19'));
      return;
    }
    channel.send(JSON.stringify(control.ping(now)));
  };
  return {
    async start(configuration: RtcConfiguration) {
      if (started || closed) return;
      started = true;
      if (!configuration.available) { fail(configuration.reason || t('ui.a6f3a6ae01e5'), true); return; }
      if (!('RTCPeerConnection' in window)) { fail(t('ui.a29474ebec3f'), true); return; }
      try {
        const connection = new RTCPeerConnection({ iceServers: configuration.iceServers || [], bundlePolicy: 'max-bundle' });
        peer = connection;
        const videoTransceiver = connection.addTransceiver('video', { direction: 'recvonly' });
        const videoCodecs = RTCRtpReceiver.getCapabilities?.('video')?.codecs.filter(codec => codec.mimeType.toLowerCase() === 'video/h264');
        if (videoCodecs?.length && videoTransceiver.setCodecPreferences) videoTransceiver.setCodecPreferences(videoCodecs);
        const audioTransceiver = connection.addTransceiver('audio', { direction: 'recvonly' });
        const audioCodecs = RTCRtpReceiver.getCapabilities?.('audio')?.codecs.filter(codec => codec.mimeType.toLowerCase() === 'audio/opus');
        if (audioCodecs?.length && audioTransceiver.setCodecPreferences) audioTransceiver.setCodecPreferences(audioCodecs);
        connection.ontrack = event => {
          if (closed) return;
          if (event.track.kind === 'video') {
            video.srcObject = new MediaStream([event.track]);
            void video.play().then(() => { if (videoFrame === undefined && animationFrame === undefined) draw(); }).catch(() => fail(t('ui.e5a40249020b')));
          } else {
            hasAudio = true;
            audio.srcObject = new MediaStream([event.track]);
            void playAudio();
          }
        };
        connection.onconnectionstatechange = () => {
          if (closed) return;
          if (connection.connectionState === 'failed') fail(t('ui.43eba720bcab'));
          if (connection.connectionState === 'disconnected' && disconnectedTimer === undefined) {
            ready = false; callbacks.control(false);
            disconnectedTimer = window.setTimeout(() => fail(t('ui.8ab9ac69bd33')), HEARTBEAT_TIMEOUT_MS);
          }
          if (connection.connectionState === 'connected') {
            if (disconnectedTimer !== undefined) window.clearTimeout(disconnectedTimer);
            disconnectedTimer = undefined;
            // A fresh pong must confirm control liveness after a transient disconnect.
            sendPing();
          }
        };
        channel = connection.createDataChannel('control', { ordered: true });
        channel.onopen = () => {
          openedAt = performance.now();
          sendPing();
          heartbeatTimer = window.setInterval(sendPing, HEARTBEAT_INTERVAL_MS);
        };
        channel.onclose = () => { if (!closed) fail(t('ui.1f924e795bb0')); };
        channel.onerror = () => { if (!closed) fail(t('ui.012f71a5fadc')); };
        channel.onmessage = event => {
          if (closed || typeof event.data !== 'string') return;
          let message: Record<string, unknown>;
          try { message = JSON.parse(event.data); } catch { return; }
          if (message.type === 'ready' && control.ready(message, performance.now())) { authenticated = true; ready = true; callbacks.control(true); sendPing(); }
          if (authenticated && message.type === 'pong' && control.pong(message, performance.now())) {
            ready = true; callbacks.control(true); callbacks.rtt(control.rttMs!);
          }
          if (message.type === 'input-error') fail(typeof message.message === 'string' ? message.message : t('ui.2096301da1ff'));
        };
        const offer = await connection.createOffer();
        if (closed) return;
        await connection.setLocalDescription(offer);
        if (connection.iceGatheringState !== 'complete') await new Promise<void>((resolve, reject) => {
          cancelGather = resolve;
          gatheringTimer = window.setTimeout(() => reject(new Error(t('ui.d54da5d48da2'))), 10_000);
          connection.onicegatheringstatechange = () => {
            if (connection.iceGatheringState === 'complete') {
              window.clearTimeout(gatheringTimer); gatheringTimer = undefined; cancelGather = null; resolve();
            }
          };
        });
        if (closed) return;
        callbacks.signal({ type: 'rtc-offer', description: { type: 'offer', sdp: connection.localDescription!.sdp } });
        statsTimer = window.setInterval(() => {
          void connection.getStats().then(report => {
            if (closed) return;
            let iceRttMs: number | null = null;
            let packetsLost: number | null = null;
            report.forEach(stat => {
              if (stat.type === 'candidate-pair' && stat.state === 'succeeded' && stat.nominated && typeof stat.currentRoundTripTime === 'number') iceRttMs = stat.currentRoundTripTime * 1000;
              if (stat.type === 'inbound-rtp' && stat.kind === 'video' && typeof stat.packetsLost === 'number') packetsLost = Math.max(0, stat.packetsLost);
              if (stat.type === 'inbound-rtp' && stat.kind === 'audio' && typeof stat.packetsReceived === 'number') {
                if (stat.packetsReceived > lastAudioPackets && audioAllowed && !audio.paused) callbacks.audioPacket();
                lastAudioPackets = stat.packetsReceived;
              }
            });
            callbacks.stats({ iceRttMs, packetsLost });
          }).catch(() => {});
        }, 1_000);
      } catch (error) { fail(error instanceof Error ? error.message : t('ui.eba53be90b65')); }
    },
    async answer(description: RTCSessionDescriptionInit) {
      if (!peer || closed) return;
      try { await peer.setRemoteDescription(description); }
      catch { fail(t('ui.042ce9e122e2')); }
    },
    send(payload: Record<string, unknown>) {
      if (closed || !ready || channel?.readyState !== 'open' || !navigator.onLine) return false;
      if (channel.bufferedAmount > INPUT_BUFFER_LIMIT) {
        // Never hold an up/key event behind an unbounded queue of stale moves.
        if (!(payload.kind === 'touch' && payload.action === 'move')) fail(t('ui.bdd8e78bb19e'));
        return false;
      }
      const message = control.input(payload, performance.now());
      if (!message) return false;
      try { channel.send(JSON.stringify(message)); return true; } catch { return false; }
    },
    setAudioEnabled(enabled: boolean) { audioAllowed = enabled; audio.muted = !enabled; if (enabled) void playAudio(); },
    unlockAudio() { void playAudio(); },
    close() {
      closed = true; ready = false; cancelGather?.(); cancelGather = null;
      for (const timer of [heartbeatTimer, statsTimer, disconnectedTimer, gatheringTimer]) if (timer !== undefined) window.clearTimeout(timer);
      if (videoFrame !== undefined) video.cancelVideoFrameCallback?.(videoFrame);
      if (animationFrame !== undefined) cancelAnimationFrame(animationFrame);
      video.pause(); audio.pause(); video.srcObject = null; audio.srcObject = null;
      channel?.close(); peer?.close();
    },
  };
}
