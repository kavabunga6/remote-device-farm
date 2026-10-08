import { setTimeout as delay } from 'node:timers/promises';

export async function waitForAndroidBoot(adb, serial, { signal, timeoutMs = 10 * 60_000, pollMs = 2000, probeTimeoutMs = 5000, isRunning, onProbe } = {}) {
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const probeSignal = () => AbortSignal.any([combined, AbortSignal.timeout(Math.min(timeoutMs, probeTimeoutMs))]);
  const assertRunning = async (signal) => {
    if (!isRunning) return;
    let running;
    try { running = await isRunning({ signal }); }
    catch { combined.throwIfAborted(); return; } // An unavailable control API does not prove the container exited.
    combined.throwIfAborted();
    if (running === false) throw new Error('Emulator container stopped before Android finished booting');
  };
  try {
    while (true) {
      combined.throwIfAborted();
      await assertRunning(probeSignal());
      const probe = probeSignal();
      let ready = false;
      try {
        // ADB connect retries internally. Bound each probe so it cannot hide a stopped container for minutes.
        await adb.connect(serial, { signal: probe });
        const result = await adb.run(serial, ['shell', 'getprop', 'sys.boot_completed'],
          { timeoutMs: Math.min(timeoutMs, probeTimeoutMs), maxOutputBytes: 4096, signal: probe });
        probe.throwIfAborted();
        await onProbe?.(result.exitCode === 0 ? 'sys.boot_completed=' + String(result.stdout).trim() : 'ADB: ' + String(result.stderr || result.stdout));
        ready = result.exitCode === 0 && String(result.stdout).trim() === '1';
      } catch (error) { await onProbe?.('ADB ещё не готов: ' + error.message); combined.throwIfAborted(); }
      if (ready) { await assertRunning(probeSignal()); return; }
      await delay(pollMs, undefined, { signal: combined });
    }
  } catch (error) {
    if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('Session startup cancelled');
    if (timeout.aborted) throw new Error('Android did not finish booting before the startup timeout');
    throw error;
  }
}
