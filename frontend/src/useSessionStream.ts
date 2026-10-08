import { t } from './i18n';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { sessionSocketUrl } from './api';
import { HEARTBEAT_INTERVAL_MS, HEARTBEAT_TIMEOUT_MS, INPUT_BUFFER_LIMIT, reconnectDelay, StreamControl } from './stream-control';
import { createSessionRtc, type RtcConfiguration } from './session-rtc';

export type StreamStatus = 'connecting' | 'live' | 'disconnected' | 'unsupported';
export type StreamTransport = 'scrcpy' | 'mjpeg' | 'images' | 'webrtc' | null;
export type ConnectionMode = 'websocket' | 'webrtc';
export type StreamMetrics = { rttMs: number | null; fps: number | null; iceRttMs: number | null; packetsLost: number | null };
export type SessionAudioState = 'disabled' | 'connecting' | 'waiting' | 'unlock' | 'receiving' | 'unavailable';
type StreamMessage = {
  type: string;
  data?: string;
  mime?: string;
  width?: number;
  height?: number;
  rotation?: number;
  codec?: string;
  timestamp?: number;
  keyframe?: boolean;
  sampleRate?: number;
  channels?: number;
  nativeTouches?: boolean;
  inputEpoch?: string;
  serverTime?: number;
  inputMaxAgeMs?: number;
  id?: string;
  rtc?: RtcConfiguration;
  available?: boolean;
  iceServers?: RTCIceServer[];
  reason?: string;
  description?: RTCSessionDescriptionInit;
  message?: string;
};

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : t('ui.b9f61453dd3f');
}

function decodeBase64(encoded: string): Uint8Array {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function h264Codec(config: Uint8Array): string {
  for (let index = 0; index < config.length - 7; index += 1) {
    const start = config[index] === 0 && config[index + 1] === 0 &&
      (config[index + 2] === 1 || (config[index + 2] === 0 && config[index + 3] === 1));
    if (!start) continue;
    const nal = index + (config[index + 2] === 1 ? 3 : 4);
    if ((config[nal] & 0x1f) !== 7) continue;
    const profile = [config[nal + 1], config[nal + 2], config[nal + 3]]
      .map(value => value.toString(16).padStart(2, '0')).join('');
    return `avc1.${profile}`;
  }
  return 'avc1.42e01e';
}

function joinBytes(first: Uint8Array, second: Uint8Array): Uint8Array {
  const joined = new Uint8Array(first.length + second.length);
  joined.set(first);
  joined.set(second, first.length);
  return joined;
}
export function useSessionStream(id: string, audioEnabled: boolean, mode: ConnectionMode = 'websocket') {
  const imageRef = useRef<HTMLImageElement>(null);
  const pendingImage = useRef<string | null>(null);
  // The first frame may arrive while the session details still render a loading state.
  useLayoutEffect(() => {
    if (pendingImage.current && imageRef.current) {
      imageRef.current.src = pendingImage.current;
      pendingImage.current = null;
    }
  });
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const audioEnabledRef = useRef(audioEnabled);
  const rtcRef = useRef<ReturnType<typeof createSessionRtc> | null>(null);
  const sendInputRef = useRef<(payload: Record<string, unknown>) => boolean>(() => false);
  const retryAttemptRef = useRef(0);
  const [inputReady, setInputReady] = useState(false);
  const [connectionGeneration, setConnectionGeneration] = useState(0);
  const [metrics, setMetrics] = useState<StreamMetrics>({ rttMs: null, fps: null, iceRttMs: null, packetsLost: null });
  const [audioTransport, setAudioTransport] = useState<ConnectionMode | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const audioClockRef = useRef(0);
  const lastAudioPlaybackRef = useRef(0);
  const audioActivityTimerRef = useRef<number | undefined>(undefined);
  const [retry, setRetry] = useState(0);
  const [status, setStatus] = useState<StreamStatus>('connecting');
  const [size, setSize] = useState({ width: 1080, height: 1920 });
  const [format, setFormat] = useState<'image' | 'video'>('image');
  const [transport, setTransport] = useState<StreamTransport>(null);
  const [nativeTouches, setNativeTouches] = useState(false);
  const [streamError, setStreamError] = useState('');
  const [connected, setConnected] = useState(false);
  const [audioUnavailableCount, setAudioUnavailableCount] = useState(0);
  const [audioNeedsGesture, setAudioNeedsGesture] = useState(false);
  const [audioNotice, setAudioNotice] = useState('');
  const [audioActive, setAudioActive] = useState(false);
  const markAudioPlayback = () => {
    lastAudioPlaybackRef.current = Date.now();
    setAudioActive(true);
    if (audioActivityTimerRef.current !== undefined) return;
    const check = () => {
      const remaining = 1500 - (Date.now() - lastAudioPlaybackRef.current);
      if (remaining > 0) audioActivityTimerRef.current = window.setTimeout(check, remaining);
      else { audioActivityTimerRef.current = undefined; setAudioActive(false); }
    };
    audioActivityTimerRef.current = window.setTimeout(check, 1500);
  };
  const clearAudioActivity = () => {
    if (audioActivityTimerRef.current !== undefined) window.clearTimeout(audioActivityTimerRef.current);
    audioActivityTimerRef.current = undefined;
    lastAudioPlaybackRef.current = 0;
  };

  useEffect(() => {
    audioEnabledRef.current = audioEnabled;
    rtcRef.current?.setAudioEnabled(audioEnabled);
    if (!audioEnabled) {
      setAudioNeedsGesture(false);
      setAudioNotice('');
      setAudioActive(false);
      clearAudioActivity();
      audioClockRef.current = 0;
      const context = audioContextRef.current;
      audioContextRef.current = null;
      if (context && context.state !== 'closed') void context.close().catch(() => {});
    }
  }, [audioEnabled]);
  const unlockAudioRef = useRef<() => void>(() => {});
  useEffect(() => {
    if (!audioEnabled) return;
    const unlock = (event: Event) => {
      if (!event.isTrusted) return;
      // The explicit audio button owns its action. Resuming on pointerdown there
      // would turn the same click into a transmission toggle after React updates.
      if (event.target instanceof Element && event.target.closest('[data-media="audio"], .audio-notice button')) return;
      if (audioContextRef.current?.state === 'running' && !audioNeedsGesture) return;
      unlockAudioRef.current();
    };
    window.addEventListener('pointerdown', unlock, { capture: true, passive: true });
    window.addEventListener('keydown', unlock, true);
    return () => { window.removeEventListener('pointerdown', unlock, true); window.removeEventListener('keydown', unlock, true); };
  }, [audioEnabled, audioNeedsGesture]);
  useEffect(() => () => { clearAudioActivity(); void audioContextRef.current?.close(); audioContextRef.current = null; }, []);
  useEffect(() => {
    const online = () => { retryAttemptRef.current = 0; setRetry(value => value + 1); };
    const offline = () => {
      sendInputRef.current = () => false;
      setInputReady(false); setConnected(false); setStatus('disconnected');
      setStreamError(t('ui.9193089515d9'));
      rtcRef.current?.close(); socketRef.current?.close();
    };
    window.addEventListener('online', online); window.addEventListener('offline', offline);
    return () => { window.removeEventListener('online', online); window.removeEventListener('offline', offline); };
  }, []);
  useEffect(() => {
    setInputReady(false); sendInputRef.current = () => false;
    setMetrics({ rttMs: null, fps: null, iceRttMs: null, packetsLost: null });
    setAudioTransport(null);
    if (!navigator.onLine) { setConnected(false); setStatus('disconnected'); return; }
    let closed = false;
    let disconnected = false;
    let unsupportedVideo = false;
    let reconnectTimer: number | undefined;
    let videoDecoder: VideoDecoder | null = null;
    let audioDecoder: AudioDecoder | null = null;
    let videoConfigBytes: Uint8Array | null = null;
    let videoConfigBase64: string | null = null;
    let videoDecoderConfig: VideoDecoderConfig | null = null;
    let videoConfigured = false;
    let waitingForKeyframe = true;
    let droppingVideo = false;
    let audioConfigured = false;
    let pcmConfigured = false;
    let pcmSampleRate = 48000;
    let pcmChannels = 2;
    const control = new StreamControl();
    let ready = false;
    let frameCount = 0;
    let previousFrames = 0;
    let previousMetricsAt = performance.now();
    let openedAt = performance.now();
    let rtcConfiguration: RtcConfiguration | null = null;
    let rtcVideoConfigured = false;
    const socket = new WebSocket(sessionSocketUrl(id) + (mode === 'webrtc' ? '?transport=webrtc' : ''));
    const markFrame = () => { frameCount += 1; retryAttemptRef.current = 0; };
    const setControlReady = (value: boolean) => { ready = value; setInputReady(value); if (!value && frameCount) setStatus('disconnected'); };
    const rtc = mode === 'webrtc' ? createSessionRtc({
      signal: message => { if (!closed && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message)); },
      canvas: () => canvasRef.current,
      frame: (width, height) => {
        if (closed) return;
        markFrame(); setSize(previous => previous.width === width && previous.height === height ? previous : { width, height });
        setFormat('video'); setTransport('webrtc'); setStatus('live');
      },
      control: setControlReady,
      rtt: rttMs => setMetrics(previous => ({ ...previous, rttMs })),
      stats: value => setMetrics(previous => ({ ...previous, ...value })),
      audio: (needsGesture, notice) => { setAudioNeedsGesture(needsGesture); setAudioNotice(notice); },
      audioPacket: () => { setAudioTransport('webrtc'); markAudioPlayback(); },
      error: (message, permanent) => {
        if (closed) return;
        unsupportedVideo = permanent === true; setStreamError(message); setControlReady(false);
        finishConnection();
      },
    }, audioEnabledRef.current) : null;
    rtcRef.current = rtc;
    const maybeStartRtc = () => {
      if (rtc && rtcConfiguration && (!rtcConfiguration.available || rtcVideoConfigured)) void rtc.start(rtcConfiguration);
    };
    const rtcStartupTimer = rtc ? window.setTimeout(() => {
      if (!closed && !frameCount) {
        setStreamError(t('ui.2770d99cb256'));
        finishConnection();
      }
    }, 25_000) : undefined;
    const sendPing = () => {
      if (closed || socket.readyState === WebSocket.CLOSED || socket.readyState === WebSocket.CLOSING) return;
      const now = performance.now();
      if (now - Math.max(openedAt, control.lastPongAt) >= HEARTBEAT_TIMEOUT_MS) {
        setStreamError(t('ui.289be8a7bcd2'));
        finishConnection(); return;
      }
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(control.ping(now)));
    };
    const heartbeatTimer = window.setInterval(sendPing, HEARTBEAT_INTERVAL_MS);
    const metricsTimer = window.setInterval(() => {
      const now = performance.now();
      const fps = Math.round((frameCount - previousFrames) * 1000 / Math.max(1, now - previousMetricsAt));
      previousFrames = frameCount; previousMetricsAt = now;
      if (frameCount) setMetrics(previous => ({ ...previous, fps }));
    }, 1000);
    sendInputRef.current = payload => {
      if (closed || !navigator.onLine || !ready) return false;
      if (rtc) return rtc.send(payload);
      if (socket.readyState !== WebSocket.OPEN) return false;
      if (socket.bufferedAmount > INPUT_BUFFER_LIMIT) {
        if (!(payload.kind === 'touch' && payload.action === 'move')) finishConnection();
        return false;
      }
      const message = control.input(payload, performance.now());
      if (!message) return false;
      try { socket.send(JSON.stringify(message)); return true; } catch { return false; }
    };
    socketRef.current = socket;
    setStatus('connecting'); setStreamError(''); setConnected(false); setTransport(null); setNativeTouches(false);
    setAudioActive(false); setAudioNeedsGesture(false); setAudioNotice(''); clearAudioActivity();
    socket.onopen = () => { setConnected(true); openedAt = performance.now(); sendPing(); };

    const failVideo = (message: string, unsupported = false) => {
      if (closed || socket.readyState === WebSocket.CLOSED) return;
      unsupportedVideo = unsupported;
      releaseDecoders();
      setStreamError(message);
      finishConnection();
    };

    const resetVideo = () => {
      if (videoDecoder && videoDecoder.state !== 'closed') videoDecoder.close();
      videoDecoder = null;
      videoConfigBytes = null;
      videoConfigBase64 = null;
      videoDecoderConfig = null;
      videoConfigured = false;
      waitingForKeyframe = true;
      droppingVideo = false;
    };

    const releaseDecoders = () => {
      resetVideo();
      if (audioDecoder && audioDecoder.state !== 'closed') audioDecoder.close();
      audioDecoder = null;
      audioConfigured = false;
      pcmConfigured = false;
    };

    socket.onmessage = event => {
      if (closed || socket.readyState !== WebSocket.OPEN) return;
      if (typeof event.data !== 'string') return;
      let message: StreamMessage;
      try { message = JSON.parse(event.data) as StreamMessage; } catch { return; }

      if (message.type === 'ready') {
        if (control.ready(message, performance.now())) {
          setConnectionGeneration(value => value + 1);
          if (!rtc) setControlReady(true);
          sendPing();
        }
        if (message.rtc) { rtcConfiguration = message.rtc; maybeStartRtc(); }
        return;
      }
      if (message.type === 'rtc-capabilities') {
        rtcConfiguration = { available: message.available === true, iceServers: message.iceServers, reason: message.reason };
        maybeStartRtc(); return;
      }
      if (message.type === 'pong') {
        if (control.pong(message, performance.now()) && !rtc) setMetrics(previous => ({ ...previous, rttMs: control.rttMs }));
        return;
      }
      if (message.type === 'rtc-answer' && message.description) { void rtc?.answer(message.description); return; }
      if (message.type === 'rtc-error') {
        unsupportedVideo = true; setStreamError(message.message || t('ui.2fb778811f4c'));
        finishConnection(); return;
      }
      if (message.type === 'input-error') {
        setStreamError(message.message || t('ui.a156ef936b6d'));
        finishConnection(); return;
      }
      // Transport capability can change without a new codec configuration (including identical SPS/PPS).
      if (message.type === 'frame' || message.type === 'video-config') setNativeTouches(message.nativeTouches === true);

      if (rtc && message.type === 'video-config' && message.data) { rtcVideoConfigured = true; maybeStartRtc(); }
      if (rtc && (message.type === 'frame' || message.type === 'video-config' || message.type === 'video-frame')) return;

      if (message.type === 'frame' && message.data) {
        markFrame();
        resetVideo();
        const mime = message.mime === 'image/jpeg' || message.mime === 'image/webp' ? message.mime : 'image/png';
        const source = `data:${mime};base64,${message.data}`;
        if (imageRef.current) imageRef.current.src = source;
        else pendingImage.current = source;
        if (message.width && message.height) setSize(previous => previous.width === message.width && previous.height === message.height ? previous : { width: message.width!, height: message.height! });
        setFormat('image'); setTransport(mime === 'image/jpeg' ? 'mjpeg' : 'images'); setStatus('live');
      }

      if (message.type === 'error') {
        setStreamError(t('ui.f0a6f67a351c'));
      }
      if (message.type === 'audio-unavailable') {
        setAudioNotice(t('ui.85049ec8e7fd'));
        setAudioNeedsGesture(false);
        setAudioActive(false);
        setAudioUnavailableCount(value => value + 1);
      }

      if (message.type === 'video-config') {
        // A rotation may announce itself before the next SPS/PPS. Keep showing
        // the current video until a new codec configuration arrives.
        if (!message.data) return;
        // The agent may resend identical SPS/PPS to refresh a viewer. Recreating
        // WebCodecs here drops frames until the next keyframe.
        if (videoDecoder?.state === 'configured' && videoConfigBase64 === message.data) return;
        resetVideo();
        setTransport('scrcpy');
        setStatus('connecting');
        if (!('VideoDecoder' in window)) { failVideo(globalThis.isSecureContext ? t('ui.6afd1f9a6d5d') : t('ui.5857f8195393'), true); return; }
        try {
          videoConfigBytes = decodeBase64(message.data);
          videoConfigBase64 = message.data;
          videoDecoderConfig = { codec: h264Codec(videoConfigBytes), optimizeForLatency: true };
          let decoder: VideoDecoder;
          decoder = new VideoDecoder({
            output: frame => {
              if (closed || videoDecoder !== decoder || droppingVideo) { frame.close(); return; }
              try {
                const canvas = canvasRef.current;
                if (canvas) {
                  const width = frame.displayWidth || frame.codedWidth;
                  const height = frame.displayHeight || frame.codedHeight;
                  if (canvas.width !== width) canvas.width = width;
                  if (canvas.height !== height) canvas.height = height;
                  canvas.getContext('2d')?.drawImage(frame, 0, 0, width, height);
                  setSize(previous => previous.width === width && previous.height === height ? previous : { width, height });
                  markFrame(); setFormat('video'); setStatus('live');
                }
              } catch (error) {
                failVideo(t('ui.ae3ad8b3eccc') + errorText(error));
              } finally {
                frame.close();
              }
            },
            error: error => {
              if (videoDecoder === decoder) failVideo(t('ui.ed5e458d7bc8', { p0: error.message }));
            },
          });
          videoDecoder = decoder;
          decoder.configure(videoDecoderConfig);
          videoConfigured = true;
        } catch (error) { failVideo(t('ui.c1302697e98f', { p0: errorText(error) }), true); }
      }

      if (message.type === 'video-frame' && message.data && videoConfigured && videoDecoder?.state === 'configured') {
        try {
          if (videoDecoder.decodeQueueSize >= 8 && !droppingVideo) {
            droppingVideo = true;
            socket.send(JSON.stringify({ type: 'request-keyframe' }));
          }
          if (droppingVideo) {
            if (!message.keyframe) return;
            if (!videoDecoderConfig) return;
            videoDecoder.reset();
            videoDecoder.configure(videoDecoderConfig);
            droppingVideo = false;
            waitingForKeyframe = true;
          }
          if (waitingForKeyframe && !message.keyframe) return;
          const packet = decodeBase64(message.data);
          videoDecoder.decode(new EncodedVideoChunk({ type: message.keyframe ? 'key' : 'delta', timestamp: message.timestamp ?? 0, data: message.keyframe && videoConfigBytes ? joinBytes(videoConfigBytes, packet) : packet }));
          waitingForKeyframe = false;
        } catch (error) { failVideo(t('ui.400595b4a03f', { p0: errorText(error) })); }
      }

      if (message.type === 'audio-config') {
        pcmConfigured = false;
        if (rtc && message.codec === 'opus') { audioConfigured = false; setAudioTransport('webrtc'); return; }
        setAudioTransport('websocket');
        setAudioActive(false);
        audioClockRef.current = 0;
        if (message.codec === 'pcm-s16le') {
          if (audioDecoder && audioDecoder.state !== 'closed') audioDecoder.close();
          audioDecoder = null;
          audioConfigured = false;
          pcmSampleRate = message.sampleRate || 48000;
          pcmChannels = message.channels || 2;
          pcmConfigured = pcmSampleRate > 0 && pcmChannels >= 1 && pcmChannels <= 2;
          if (!pcmConfigured && audioEnabledRef.current) setAudioNotice(t('ui.457a252ec013'));
          return;
        }
        if (!('AudioDecoder' in window)) {
          if (audioEnabledRef.current) setAudioNotice(t('ui.67a53ec39aa4'));
          return;
        }
        if (!message.data) return;
        try {
          if (audioDecoder && audioDecoder.state !== 'closed') audioDecoder.close();
          let decoder: AudioDecoder;
          decoder = new AudioDecoder({
            output: audio => {
              if (closed || audioDecoder !== decoder || !audioEnabledRef.current) { audio.close(); return; }
              try {
                const context = audioContextRef.current ?? new AudioContext({ sampleRate: audio.sampleRate, latencyHint: 'interactive' });
                audioContextRef.current = context;
                if (context.state !== 'running') {
                  setAudioNeedsGesture(true);
                  setAudioActive(false);
                  setAudioNotice(t('ui.3b0cbc5e4cdc'));
                  audio.close();
                  return;
                }
                if (audioClockRef.current - context.currentTime > 0.25) { audio.close(); return; }
                const buffer = context.createBuffer(audio.numberOfChannels, audio.numberOfFrames, audio.sampleRate);
                for (let channel = 0; channel < audio.numberOfChannels; channel += 1) {
                  const samples = new Float32Array(audio.numberOfFrames);
                  audio.copyTo(samples, { planeIndex: channel, format: 'f32-planar' });
                  buffer.copyToChannel(samples, channel);
                }
                const source = context.createBufferSource();
                source.buffer = buffer;
                source.connect(context.destination);
                const startAt = Math.max(context.currentTime + 0.025, audioClockRef.current);
                source.start(startAt);
                audioClockRef.current = startAt + buffer.duration;
                setAudioNeedsGesture(false);
                setAudioNotice('');
                markAudioPlayback();
              } catch (error) { setAudioActive(false); setAudioNotice(t('ui.93f3de906b00', { p0: errorText(error) })); }
              audio.close();
            },
            error: error => {
              if (audioDecoder === decoder) {
                audioConfigured = false;
                setAudioActive(false);
                if (audioEnabledRef.current) setAudioNotice(t('ui.d101328a6215', { p0: error.message }));
              }
            },
          });
          audioDecoder = decoder;
          const codec = message.codec === 'aac' ? 'mp4a.40.2' : message.codec === 'opus' ? 'opus' : null;
          if (!codec) throw new Error(t('ui.68f6fac0e28a'));
          audioClockRef.current = 0;
          decoder.configure({ codec, sampleRate: message.sampleRate || 48000, numberOfChannels: message.channels || 2, description: decodeBase64(message.data) });
          audioConfigured = true;
        } catch (error) {
          audioConfigured = false;
          setAudioActive(false);
          if (audioEnabledRef.current) setAudioNotice(t('ui.04b49ea56cd6', { p0: errorText(error) }));
        }
      }

      if (message.type === 'audio-frame' && message.data && pcmConfigured && audioEnabledRef.current) {
        try {
          const bytes = decodeBase64(message.data);
          const frameBytes = pcmChannels * 2;
          if (bytes.byteLength < frameBytes || bytes.byteLength % frameBytes !== 0) return;
          const context = audioContextRef.current ?? new AudioContext({ sampleRate: pcmSampleRate, latencyHint: 'interactive' });
          audioContextRef.current = context;
          if (context.state !== 'running') {
            setAudioActive(false);
            setAudioNeedsGesture(true);
            setAudioNotice(t('ui.3b0cbc5e4cdc'));
            return;
          }
          if (audioClockRef.current - context.currentTime > 0.25) return;
          const frames = bytes.byteLength / frameBytes;
          const buffer = context.createBuffer(pcmChannels, frames, pcmSampleRate);
          const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
          for (let channel = 0; channel < pcmChannels; channel += 1) {
            const samples = new Float32Array(frames);
            for (let frame = 0; frame < frames; frame += 1) samples[frame] = view.getInt16((frame * pcmChannels + channel) * 2, true) / 32768;
            buffer.copyToChannel(samples, channel);
          }
          const source = context.createBufferSource();
          source.buffer = buffer;
          source.connect(context.destination);
          const startAt = Math.max(context.currentTime + 0.02, audioClockRef.current);
          source.start(startAt);
          audioClockRef.current = startAt + buffer.duration;
          markAudioPlayback();
          setAudioNeedsGesture(false);
          setAudioNotice('');
        } catch (error) {
          setAudioActive(false);
          setAudioNotice(t('ui.93f3de906b00', { p0: errorText(error) }));
        }
        return;
      }

      if (message.type === 'audio-frame' && message.data && audioConfigured && audioDecoder?.state === 'configured') {
        try {
          if (audioDecoder.decodeQueueSize < 16) audioDecoder.decode(new EncodedAudioChunk({ type: 'key', timestamp: message.timestamp ?? 0, data: decodeBase64(message.data) }));
        } catch (error) {
          audioConfigured = false;
          setAudioActive(false);
          if (audioEnabledRef.current) setAudioNotice(t('ui.0d3affb22351', { p0: errorText(error) }));
        }
      }
    };
    // Native WebSocket.close() may wait for a half-open TCP connection for tens of
    // seconds. Abandon it locally and retry independently of its close handshake.
    function finishConnection() {
      if (closed || disconnected) return;
      disconnected = true;
      sendInputRef.current = () => false;
      socket.onopen = null; socket.onmessage = null; socket.onerror = null; socket.onclose = null;
      setControlReady(false); rtc?.close();
      setMetrics({ rttMs: null, fps: null, iceRttMs: null, packetsLost: null });
      window.clearInterval(heartbeatTimer); window.clearInterval(metricsTimer);
      if (rtcStartupTimer !== undefined) window.clearTimeout(rtcStartupTimer);
      releaseDecoders(); clearAudioActivity();
      setConnected(false); setAudioActive(false);
      setStatus(unsupportedVideo ? 'unsupported' : 'disconnected');
      socket.close();
      if (!unsupportedVideo && navigator.onLine && reconnectTimer === undefined) {
        reconnectTimer = window.setTimeout(() => {
          if (!closed) setRetry(value => value + 1);
        }, reconnectDelay(retryAttemptRef.current++));
      }
    }
    socket.onerror = () => { setStreamError(t('ui.5bd5372ebf55')); finishConnection(); };
    socket.onclose = finishConnection;

    return () => {
      closed = true;
      pendingImage.current = null;
      sendInputRef.current = () => false;
      rtc?.close(); rtcRef.current = null;
      window.clearInterval(heartbeatTimer); window.clearInterval(metricsTimer);
      if (rtcStartupTimer !== undefined) window.clearTimeout(rtcStartupTimer);
      socketRef.current = null;
      socket.onopen = null;
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
      socket.close();
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
      releaseDecoders();
      clearAudioActivity();
    };
  }, [id, retry, mode]);

  const audioState: SessionAudioState = !audioEnabled ? 'disabled' : audioNeedsGesture ? 'unlock' : audioNotice ? 'unavailable' : audioActive ? 'receiving' : !connected ? 'connecting' : 'waiting';
  const unlockAudio = () => {
    rtcRef.current?.unlockAudio();
    try {
      const context = audioContextRef.current ?? new AudioContext({ latencyHint: 'interactive' });
      audioContextRef.current = context;
      void context.resume().then(() => {
        if (context.state === 'running') { audioClockRef.current = context.currentTime; setAudioNeedsGesture(false); setAudioNotice(''); }
        else { setAudioNeedsGesture(true); setAudioNotice(t('ui.3b0cbc5e4cdc')); }
      }).catch(error => setAudioNotice(t('ui.5b373bfe7eaa', { p0: errorText(error) })));
    } catch (error) { setAudioNotice(t('ui.5b373bfe7eaa', { p0: errorText(error) })); }
  };
  unlockAudioRef.current = unlockAudio;
  return {
    imageRef, canvasRef, status, size, format, transport, nativeTouches, streamError, connected, inputReady, connectionGeneration, metrics, audioTransport, mode, audioUnavailableCount, audioNeedsGesture, audioNotice, audioActive, audioState,
    reconnect: () => { retryAttemptRef.current = 0; setRetry(value => value + 1); },
    send: (payload: Record<string, unknown>) => sendInputRef.current(payload),
    unlockAudio,

  };
}
