import { SessionVideo } from './session-video';
import { type StreamMessage } from './session-media';
import { SessionAudio } from './session-audio';
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
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : t('ui.b9f61453dd3f');
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

    const releaseDecoders = () => {
      video.reset();
      audio.reset();
    };

    const video = new SessionVideo({
      closed: () => closed, canvas: () => canvasRef.current, image: () => imageRef.current, pendingImage,
      frame: (format, width, height, transport) => {
        markFrame();
        if (width && height) setSize(previous => previous.width === width && previous.height === height ? previous : { width, height });
        setFormat(format); if (transport) setTransport(transport); setStatus('live');
      },
      connecting: () => { setTransport('scrcpy'); setStatus('connecting'); }, fail: failVideo,
      requestKeyframe: () => socket.send(JSON.stringify({ type: 'request-keyframe' })),
    });

    const audio = new SessionAudio({
      closed: () => closed,
      enabled: () => audioEnabledRef.current,
      context: audioContextRef, clock: audioClockRef,
      active: setAudioActive, needsGesture: setAudioNeedsGesture, notice: setAudioNotice,
      playback: markAudioPlayback, transport: setAudioTransport,
    }, Boolean(rtc));

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

      video.handle(message);

      if (message.type === 'error') {
        setStreamError(t('ui.f0a6f67a351c'));
      }
      if (message.type === 'audio-unavailable') {
        setAudioNotice(t('ui.85049ec8e7fd'));
        setAudioNeedsGesture(false);
        setAudioActive(false);
        setAudioUnavailableCount(value => value + 1);
      }

      audio.handle(message);
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
