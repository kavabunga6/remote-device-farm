import { useEffect, useRef, useState, type RefObject } from 'react';

const SAMPLE_DELAY = 5000;

export function usePerformanceVisibility(panel: RefObject<HTMLElement | null>, active: boolean) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!active || !panel.current) {
      setVisible(false);
      return;
    }
    let intersecting = false;
    const update = () => setVisible(intersecting && document.visibilityState === 'visible');
    const observer = new IntersectionObserver(([entry]) => {
      intersecting = entry.isIntersecting;
      update();
    });
    observer.observe(panel.current);
    document.addEventListener('visibilitychange', update);
    return () => {
      observer.disconnect();
      document.removeEventListener('visibilitychange', update);
    };
  }, [active, panel]);
  return active && visible;
}

export function usePerformancePolling<T>(load: (signal: AbortSignal) => Promise<T>, enabled: boolean, intervalMs?: number) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const flight = useRef<{ controller: AbortController; done: Promise<void>; startedAt: number } | null>(null);

  useEffect(() => () => flight.current?.controller.abort(), [load]);
  useEffect(() => {
    if (!enabled) return;
    let stopped = false;
    let timer: number | undefined;
    let failures = 0;

    function schedule(startedAt: number) {
      if (stopped) return;
      const delay = (intervalMs ?? SAMPLE_DELAY) * Math.min(2 ** failures, 6);
      const elapsed = intervalMs !== undefined && failures === 0 ? performance.now() - startedAt : 0;
      timer = window.setTimeout(poll, Math.max(0, delay - elapsed));
    }

    function poll() {
      if (stopped || document.visibilityState !== 'visible') return;
      // The API may still be sampling after a pause. Let that request finish before sending another.
      const pending = flight.current;
      if (pending) {
        void pending.done.then(() => schedule(pending.startedAt));
        return;
      }
      const controller = new AbortController();
      const startedAt = performance.now();
      const done = load(controller.signal)
        .then(result => {
          if (controller.signal.aborted) return;
          failures = 0;
          setData(result);
          setError(null);
        })
        .catch(cause => {
          if (controller.signal.aborted) return;
          failures = Math.min(failures + 1, 3);
          setError(cause);
        })
        .finally(() => { flight.current = null; });
      flight.current = { controller, done, startedAt };
      void done.then(() => schedule(startedAt));
    }

    poll();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [enabled, intervalMs, load]);

  return { data, error, settle: () => flight.current?.done };
}
