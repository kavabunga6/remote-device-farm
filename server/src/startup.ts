const nodeCodes = new Set(['ECONNREFUSED','ECONNRESET','ENOTFOUND','EAI_AGAIN','ETIMEDOUT','EHOSTUNREACH','ENETUNREACH','EPIPE','ENOMEM','ENOSPC','EACCES','EPERM','EIO','EADDRINUSE','EADDRNOTAVAIL','CERT_HAS_EXPIRED','UNABLE_TO_VERIFY_LEAF_SIGNATURE','DEPTH_ZERO_SELF_SIGNED_CERT','ERR_TLS_CERT_ALTNAME_INVALID']);
const transientCodes = new Set(['ECONNREFUSED','ECONNRESET','ENOTFOUND','EAI_AGAIN','ETIMEDOUT','EHOSTUNREACH','ENETUNREACH','EPIPE','DB_CONNECTION_TIMEOUT','57P01','57P02','57P03','53300']);
export type StartupPhase = 'configuration' | 'database' | 'migrations' | 'registry' | 'profile_secrets' | 'authentication' | 'listeners' | 'api' | 'shutdown';

function errorCode(error: unknown, seen = new Set<unknown>()): string {
  if (!error || typeof error !== 'object' || seen.has(error)) return 'UNKNOWN';
  seen.add(error);
  // Never log messages, stacks, SQL, request values, addresses or arbitrary error properties.
  const fields = Object.getOwnPropertyDescriptors(error);
  const code = fields.code?.value;
  if (typeof code === 'string' && (nodeCodes.has(code) || /^(?:08|22|23|28|40|42|53|55|57|58|XX)[A-Z0-9]{3}$/.test(code))) return code;
  if (fields.message?.value === 'Connection terminated due to connection timeout') return 'DB_CONNECTION_TIMEOUT';
  const cause = errorCode(fields.cause?.value, seen);
  if (cause !== 'UNKNOWN') return cause;
  if (Array.isArray(fields.errors?.value)) for (const item of fields.errors.value.slice(0, 8)) {
    const nested = errorCode(item, seen);
    if (nested !== 'UNKNOWN') return nested;
  }
  return 'UNKNOWN';
}

export class StartupFailure extends Error {
  constructor(readonly phase: StartupPhase, cause: unknown) { super('startup_failed', { cause }); }
}

export function operationalError(error: unknown, phase: StartupPhase): string {
  return JSON.stringify({ phase: error instanceof StartupFailure ? error.phase : phase, code: errorCode(error) });
}

/** Retry dependency availability only. Configuration, authentication and schema errors fail immediately. */
export async function waitForStartupDependency(check: () => Promise<unknown>, options: {
  timeoutMs?: number; now?: () => number; sleep?: (ms: number) => Promise<void>;
  onRetry?: (details: string) => void;
} = {}): Promise<void> {
  const { timeoutMs = 600_000, now = () => performance.now(), sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), onRetry = () => {} } = options;
  const deadline = now() + timeoutMs;
  let attempts = 0;
  for (;;) {
    try { await check(); return; }
    catch (error) {
      const code = errorCode(error);
      if (!(transientCodes.has(code) || code.startsWith('08')) || now() >= deadline) throw error;
      onRetry(JSON.stringify({ phase: 'database', code, attempt: ++attempts }));
      await sleep(Math.min(30_000, 1000 * 2 ** Math.min(attempts - 1, 5), deadline - now()));
      if (now() >= deadline) throw error;
    }
  }
}
