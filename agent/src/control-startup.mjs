const transientCodes = new Set(['ENOENT','ECONNREFUSED','ECONNRESET','EPIPE','ETIMEDOUT']);
function dependencyCode(error) {
  if (transientCodes.has(error?.code)) return error.code;
  if (error?.message === 'Docker API request timed out') return 'DOCKER_API_TIMEOUT';
  if (error?.message === 'Docker API response aborted') return 'DOCKER_API_ABORTED';
  return 'UNKNOWN';
}

/** Keep IPC closed until Docker inspection and owned-image cleanup both finish. */
export async function initializeControl(control, {
  timeoutMs = 600_000, now = () => performance.now(),
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), report = record => console.warn(JSON.stringify(record)),
} = {}) {
  const deadline = now() + timeoutMs;
  for (const [phase, check] of [['docker', () => control.hostInfo()], ['image_check_cleanup', () => control.recoverImageChecks()]]) {
    let attempt = 0;
    for (;;) {
      try { await check(); break; }
      catch (error) {
        const code = dependencyCode(error);
        if (code === 'UNKNOWN' || now() >= deadline) {
          report({ event: 'control.startup_failed', phase, code });
          throw error;
        }
        report({ event: 'control.startup_waiting', phase, code, attempt: ++attempt });
        await sleep(Math.min(30_000, 1000 * 2 ** Math.min(attempt - 1, 5), deadline - now()));
        if (now() >= deadline) { report({ event: 'control.startup_failed', phase, code }); throw error; }
      }
    }
  }
}
