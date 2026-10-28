type CaptureClock = Pick<Window, 'requestAnimationFrame' | 'cancelAnimationFrame' | 'setTimeout' | 'clearTimeout'>;
const ENCODER_DRAIN_MS = 2000;
const FINAL_FRAME_DEADLINE_MS = 4000;
type FinalCapture = { stream?: MediaStream; pause?: () => void };
type FrameProcessor = new (options: { track: MediaStreamTrack; maxBufferSize: number }) => { readable: ReadableStream<VideoFrame> };

// A painted canvas is not necessarily delivered to its media track yet. Observe
// two fresh track frames when supported, without consuming the recorder's track.
function observeFinalFrames(stream: MediaStream | undefined, ready: () => void): () => void {
  const Processor = (globalThis as typeof globalThis & { MediaStreamTrackProcessor?: FrameProcessor }).MediaStreamTrackProcessor;
  const original = stream?.getVideoTracks()[0];
  if (!Processor || !original) { ready(); return () => {}; }
  let track: MediaStreamTrack | undefined;
  let reader: ReadableStreamDefaultReader<VideoFrame> | undefined;
  let cancelled = false;
  const cancel = () => {
    if (cancelled) return;
    cancelled = true;
    void reader?.cancel().catch(() => {});
    track?.stop();
  };
  try {
    track = original.clone();
    reader = new Processor({ track, maxBufferSize: 1 }).readable.getReader();
    void (async () => {
      try {
        for (let count = 0; count < 2; count++) {
          const { value, done } = await reader!.read();
          value?.close();
          if (done || cancelled) return;
        }
        ready();
      } catch { if (!cancelled) ready(); }
      finally { cancel(); }
    })();
  } catch { cancel(); ready(); }
  return cancel;
}

export function scheduleCaptureStop(finish: () => void, capture: FinalCapture = {}, clock: CaptureClock = window): () => void {
  let done = false;
  let cancelFrames: (() => void) | undefined;
  let frame: number | null = null;
  let settleTimer: number | null = null;
  let deadlineTimer: number | null = null;
  const cancel = () => {
    done = true;
    cancelFrames?.();
    if (frame !== null) clock.cancelAnimationFrame(frame);
    if (settleTimer !== null) clock.clearTimeout(settleTimer);
    if (deadlineTimer !== null) clock.clearTimeout(deadlineTimer);
    frame = settleTimer = deadlineTimer = null;
  };
  const finishOnce = () => {
    if (done) return;
    cancel();
    finish();
  };
  // Background tabs can suspend animation frames; finalization remains bounded.
  deadlineTimer = clock.setTimeout(finishOnce, FINAL_FRAME_DEADLINE_MS);
  frame = clock.requestAnimationFrame(() => {
    if (done) return;
    frame = clock.requestAnimationFrame(() => {
      frame = null;
      if (!done) cancelFrames = observeFinalFrames(capture.stream, () => {
        if (done) return;
        // Chromium stop() can discard frames still in its encoding queue
        // (crbug.com/719023). Stop feeding it before allowing that queue to drain.
        try { capture.pause?.(); } catch { /* Still finalize after a recorder error. */ }
        settleTimer = clock.setTimeout(finishOnce, ENCODER_DRAIN_MS);
      });
    });
  });
  return cancel;
}
