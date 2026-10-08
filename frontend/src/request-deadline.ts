export class RequestTimeoutError extends Error {
  constructor() { super(); this.name = 'RequestTimeoutError'; }
}

/** Bound both fetching and reading the response; release timers/listeners on every outcome. */
export async function withRequestDeadline<T>(operation: (signal: AbortSignal) => Promise<T>,
  options: { signal?: AbortSignal | null; timeoutMs?: number } = {}): Promise<T> {
  const controller = new AbortController();
  const cancel = () => controller.abort(options.signal?.reason);
  let rejectAbort!: (reason: unknown) => void;
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  const onAbort = () => rejectAbort(controller.signal.reason);
  controller.signal.addEventListener('abort', onAbort, { once: true });
  options.signal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(() => controller.abort(new RequestTimeoutError()), options.timeoutMs ?? 120_000);
  try {
    if (options.signal?.aborted) cancel();
    // Invoke only after checking cancellation. Racing also bounds adapters that ignore abort.
    const work = Promise.resolve().then(() => {
      if (controller.signal.aborted) throw controller.signal.reason;
      return operation(controller.signal);
    });
    return await Promise.race([work, aborted]);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', cancel);
    controller.signal.removeEventListener('abort', onAbort);
  }
}
