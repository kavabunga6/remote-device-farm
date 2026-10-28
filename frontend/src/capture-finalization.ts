type CaptureClock = Pick<Window, 'requestAnimationFrame' | 'cancelAnimationFrame' | 'setTimeout' | 'clearTimeout'>;
const FINAL_FRAME_DEADLINE_MS = 1000;

export function scheduleCaptureStop(finish: () => void, frameDelayMs: number, clock: CaptureClock = window): () => void {
  let done = false;
  let frame: number | null = null;
  let settleTimer: number | null = null;
  let deadlineTimer: number | null = null;
  const cancel = () => {
    done = true;
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
      if (!done) settleTimer = clock.setTimeout(finishOnce, frameDelayMs);
    });
  });
  return cancel;
}
