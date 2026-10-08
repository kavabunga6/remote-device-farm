/** One owned background read; refresh invalidates stale results and disposal aborts it. */
export function createPollingTask<T>(read: (signal: AbortSignal) => Promise<T>,
  apply: (value: T, signal: AbortSignal) => void | Promise<void>) {
  type Flight = { controller: AbortController; promise: Promise<void> };
  let active = true;
  let current: Flight | null = null;
  const run = (): Promise<void> => {
    if (!active) return Promise.resolve();
    if (current) return current.promise;
    const flight: Flight = { controller: new AbortController(), promise: Promise.resolve() };
    current = flight;
    flight.promise = Promise.resolve().then(() => { flight.controller.signal.throwIfAborted(); return read(flight.controller.signal); })
      .then(value => { if (active && current === flight) return apply(value, flight.controller.signal); })
      .catch(() => { /* Retain the last snapshot; the next tick can recover. */ })
      .finally(() => { if (current === flight) current = null; });
    return flight.promise;
  };
  const invalidate = () => { const old = current; current = null; old?.controller.abort(); };
  return {
    run,
    refresh: () => { invalidate(); return run(); },
    dispose: () => { active = false; invalidate(); },
  };
}
