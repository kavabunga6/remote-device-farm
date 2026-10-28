import { t } from './i18n';
import { scheduleCaptureStop } from './capture-finalization';
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type { TouchIndicatorSnapshot } from './useTouchIndicator';

type ScreenSource = {
  format: 'image' | 'video';
  imageRef: RefObject<HTMLImageElement | null>;
  canvasRef: RefObject<HTMLCanvasElement | null>;
};

type CaptureOptions = ScreenSource & {
  sessionId: string;
  status: 'connecting' | 'live' | 'disconnected' | 'unsupported';
  getTouchIndicator?: () => TouchIndicatorSnapshot | null;
};

type ActiveRecording = {
  recorder: MediaRecorder;
  stream: MediaStream;
  drawTimer: number;
  clockTimer: number;
  drawFrame: () => void;
  cancelStop: (() => void) | null;
  stopping: boolean;
  chunks: Blob[];
  filename: string;
};

const RECORDING_FPS = 30;
const MAX_RECORDING_SIDE = 1280;
const MAX_RECORDING_MS = 10 * 60_000;
const MAX_RECORDING_BYTES = 256 * 1024 * 1024;
const WEBM_MIME_TYPES = ['video/webm;codecs=vp8', 'video/webm;codecs=vp9', 'video/webm'];

function canRecordWebM(): boolean {
  return typeof MediaRecorder !== 'undefined' && typeof MediaRecorder.isTypeSupported === 'function' &&
    typeof HTMLCanvasElement !== 'undefined' && typeof HTMLCanvasElement.prototype.captureStream === 'function' &&
    WEBM_MIME_TYPES.some(type => MediaRecorder.isTypeSupported(type));
}


function activeSource(source: ScreenSource): { element: CanvasImageSource; width: number; height: number } | null {
  if (source.format === 'video') {
    const canvas = source.canvasRef.current;
    return canvas && canvas.width > 0 && canvas.height > 0
      ? { element: canvas, width: canvas.width, height: canvas.height } : null;
  }
  const image = source.imageRef.current;
  return image?.complete && image.naturalWidth > 0 && image.naturalHeight > 0
    ? { element: image, width: image.naturalWidth, height: image.naturalHeight } : null;
}

function filename(sessionId: string, extension: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return 'device-' + sessionId.slice(0, 8) + '-' + stamp + '.' + extension;
}

function download(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  try {
    anchor.href = url;
    anchor.download = name;
    anchor.style.display = 'none';
    document.body.append(anchor);
    anchor.click();
  } finally {
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
}

async function pngBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return await new Promise((resolve, reject) => {
    canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error(t('ui.469fd601d2fb'))), 'image/png');
  });
}

function createRecorder(stream: MediaStream): MediaRecorder {
  for (const mimeType of WEBM_MIME_TYPES) {
    if (!MediaRecorder.isTypeSupported(mimeType)) continue;
    try { return new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 3_000_000 }); }
    catch { /* Try the next browser-supported WebM codec. */ }
  }
  throw new Error(t('ui.4ed67903538f'));
}

function drawTouchIndicator(context: CanvasRenderingContext2D, touch: TouchIndicatorSnapshot | null | undefined, left: number, top: number, width: number, height: number) {
  if (!touch) return;
  const radiusX = touch.radiusX * width, radiusY = touch.radiusY * height;
  if (!(radiusX > 0 && radiusY > 0 && Number.isFinite(radiusX + radiusY))) return;
  context.save();
  context.beginPath(); context.rect(left, top, width, height); context.clip();
  const lineWidth = Math.min(radiusX, radiusY) / 6;
  context.beginPath();
  context.ellipse(left + touch.x * width, top + touch.y * height, radiusX - lineWidth / 2, radiusY - lineWidth / 2, 0, 0, Math.PI * 2);
  context.fillStyle = '#38caa580'; context.fill();
  context.strokeStyle = '#fff'; context.lineWidth = lineWidth; context.stroke();
  context.restore();
}

export function useSessionCapture({ sessionId, status, format, imageRef, canvasRef, getTouchIndicator }: CaptureOptions) {
  const touchRef = useRef(getTouchIndicator);
  touchRef.current = getTouchIndicator;
  const sourceRef = useRef<ScreenSource>({ format, imageRef, canvasRef });
  sourceRef.current = { format, imageRef, canvasRef };
  const statusRef = useRef(status);
  statusRef.current = status;
  const recordingRef = useRef<ActiveRecording | null>(null);
  const mountedRef = useRef(true);
  const [recording, setRecording] = useState(false);
  const [saving, setSaving] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [error, setError] = useState('');
  const screenshotSupported = typeof HTMLCanvasElement !== 'undefined' &&
    typeof HTMLCanvasElement.prototype.toBlob === 'function';
  const recordingSupported = canRecordWebM();

  const takeScreenshot = useCallback(async () => {
    setError('');
    const source = statusRef.current === 'live' ? activeSource(sourceRef.current) : null;
    if (!source) { setError(t('ui.b94004a414ae')); return; }
    if (!screenshotSupported) { setError(t('ui.8be8517532e9')); return; }
    try {
      const canvas = document.createElement('canvas');
      canvas.width = source.width;
      canvas.height = source.height;
      const context = canvas.getContext('2d');
      if (!context) throw new Error(t('ui.d1efb0c8fc87'));
      context.drawImage(source.element, 0, 0, source.width, source.height);
      drawTouchIndicator(context, touchRef.current?.(), 0, 0, source.width, source.height);
      download(await pngBlob(canvas), filename(sessionId, 'png'));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('ui.0fb91b8f7247'));
    }
  }, [sessionId, screenshotSupported]);

  const stopRecording = useCallback(() => {
    const active = recordingRef.current;
    if (!active || active.stopping || active.recorder.state === 'inactive') return;
    active.stopping = true;
    if (mountedRef.current) { setRecording(false); setSaving(true); }
    try { active.drawFrame(); }
    catch { /* Finalize the recording even if its source became unreadable. */ }
    // Deliver the final canvas frame before pausing and draining the encoder.
    active.cancelStop = scheduleCaptureStop(() => {
      if (active.recorder.state !== 'inactive') active.recorder.stop();
    }, {
      stream: active.stream,
      pause: () => {
        window.clearInterval(active.drawTimer);
        window.clearInterval(active.clockTimer);
        if (active.recorder.state === 'recording') active.recorder.pause();
      },
    });
  }, []);

  const startRecording = useCallback(() => {
    if (recordingRef.current) return;
    setError('');
    const source = statusRef.current === 'live' ? activeSource(sourceRef.current) : null;
    if (!source) { setError(t('ui.b94004a414ae')); return; }
    if (!recordingSupported) {
      setError(t('ui.c258afb0c180'));
      return;
    }

    let stream: MediaStream | null = null;
    let drawTimer: number | null = null;
    let clockTimer: number | null = null;
    try {
      // A stable square frame contains both orientations without changing video dimensions.
      const canvas = document.createElement('canvas');
      const side = Math.min(MAX_RECORDING_SIDE, Math.max(source.width, source.height));
      canvas.width = side;
      canvas.height = side;
      const context = canvas.getContext('2d', { alpha: false });
      if (!context) throw new Error(t('ui.74ab5fa639a0'));
      context.imageSmoothingQuality = 'medium';
      const draw = () => {
        context.fillStyle = '#101819';
        context.fillRect(0, 0, side, side);
        const current = activeSource(sourceRef.current);
        if (current) {
          const scale = Math.min(side / current.width, side / current.height);
          const width = Math.max(1, Math.round(current.width * scale));
          const height = Math.max(1, Math.round(current.height * scale));
          const left = Math.floor((side - width) / 2), top = Math.floor((side - height) / 2);
          context.drawImage(current.element, left, top, width, height);
          drawTouchIndicator(context, touchRef.current?.(), left, top, width, height);
        }
        // Explicit requests also capture overlay-only changes on a static device frame.
        const track = stream?.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack | undefined;
        track?.requestFrame?.();
      };
      draw();
      stream = canvas.captureStream(RECORDING_FPS);
      const recorder = createRecorder(stream);
      const chunks: Blob[] = [];
      const active: ActiveRecording = {
        recorder, stream, drawTimer: 0, clockTimer: 0, drawFrame: draw, cancelStop: null, stopping: false, chunks,
        filename: filename(sessionId, 'webm'),
      };
      let recordedBytes = 0;
      recorder.ondataavailable = event => {
        if (event.data.size > 0) {
          chunks.push(event.data);
          recordedBytes += event.data.size;
          if (recordedBytes >= MAX_RECORDING_BYTES) {
            if (mountedRef.current) setError(t('ui.b823cf1eda97'));
            stopRecording();
          }
        }
      };
      recorder.onerror = () => {
        if (mountedRef.current) setError(t('ui.c56ba93806b1'));
        stopRecording();
      };
      recorder.onstop = () => {
        active.cancelStop?.();
        active.cancelStop = null;
        window.clearInterval(active.drawTimer);
        window.clearInterval(active.clockTimer);
        active.stream.getTracks().forEach(track => track.stop());
        const wasCurrent = recordingRef.current === active;
        if (wasCurrent) recordingRef.current = null;
        try {
          if (chunks.length) {
            download(new Blob(chunks, { type: recorder.mimeType || 'video/webm' }), active.filename);
          } else if (wasCurrent && mountedRef.current) setError(t('ui.deec5cb8f6db'));
        } catch (cause) {
          if (wasCurrent && mountedRef.current) {
            setError(cause instanceof Error ? cause.message : t('ui.fdd771e63f18'));
          }
        } finally {
          chunks.length = 0;
          if (wasCurrent && mountedRef.current) { setRecording(false); setSaving(false); }
        }
      };
      recorder.start(1000);
      draw();
      drawTimer = window.setInterval(draw, 1000 / RECORDING_FPS);
      active.drawTimer = drawTimer;
      const startedAt = Date.now();
      clockTimer = window.setInterval(() => {
        const elapsed = Date.now() - startedAt;
        if (mountedRef.current) setElapsedSeconds(Math.floor(elapsed / 1000));
        if (elapsed >= MAX_RECORDING_MS) {
          if (mountedRef.current) setError(t('ui.5689a32b3866'));
          stopRecording();
        }
      }, 1000);
      active.clockTimer = clockTimer;
      recordingRef.current = active;
      setElapsedSeconds(0);
      setRecording(true);
    } catch (cause) {
      if (drawTimer !== null) window.clearInterval(drawTimer);
      if (clockTimer !== null) window.clearInterval(clockTimer);
      stream?.getTracks().forEach(track => track.stop());
      setError(cause instanceof Error ? cause.message : t('ui.51b04e849b08'));
    }
  }, [sessionId, stopRecording, recordingSupported]);

  useEffect(() => {
    if (status === 'live' || !recordingRef.current) return;
    // A rotation briefly switches the decoder to "connecting". Give its next
    // keyframe time to arrive before finishing the recording.
    const timer = window.setTimeout(() => {
      if (statusRef.current === 'live' || !recordingRef.current) return;
      setError(t('ui.c36f354ab4eb'));
      stopRecording();
    }, status === 'connecting' ? 3000 : 1500);
    return () => window.clearTimeout(timer);
  }, [status, stopRecording]);

  useEffect(() => {
    mountedRef.current = true;
    setRecording(false);
    setSaving(false);
    setElapsedSeconds(0);
    return () => {
      mountedRef.current = false;
      const active = recordingRef.current;
      if (!active) return;
      recordingRef.current = null;
      active.cancelStop?.();
      active.cancelStop = null;
      window.clearInterval(active.drawTimer);
      window.clearInterval(active.clockTimer);
      if (active.recorder.state !== 'inactive') active.recorder.stop();
      else active.stream.getTracks().forEach(track => track.stop());
    };
  }, [sessionId]);

  return { takeScreenshot, startRecording, stopRecording, recording, saving, elapsedSeconds, error,
    screenshotSupported, recordingSupported, clearError: () => setError('') };
}
