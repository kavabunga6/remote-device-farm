import { randomUUID } from 'node:crypto';
import { formatWithOptions } from 'node:util';

export type ApplicationLogLevel = 'debug' | 'info' | 'warning' | 'error';
export type ApplicationLogSource = 'server' | 'agent' | 'emulator';
export type ApplicationLogRecord = {
  id: string; occurredAt: string; level: ApplicationLogLevel; message: string; source: ApplicationLogSource;
};

export function redactLog(message: string, secrets: readonly string[] = []): string {
  let value = message
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g, '[REDACTED PRIVATE KEY]')
    .replace(/(\b(?:https?|postgres(?:ql)?|ldaps?):\/\/[^\s:@/]+:)[^\s@/]+@/gi, '$1[REDACTED]@')
    .replace(/\bBearer\s+[^\s,'"}]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:rdf[a-z]?_[A-Za-z0-9_-]{8,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/g, '[REDACTED TOKEN]')
    .replace(/((?:[\w-]*(?:password|passwd|secret|token|authorization|cookie|api[_-]?key|private[_-]?key)[\w-]*)["']?\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;}]+)/gi, '$1[REDACTED]');
  for (const secret of secrets) if (secret.length >= 4) value = value.split(secret).join('[REDACTED]');
  return value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').slice(0, 4096);
}

// This tail is bounded in both time-independent record count and message size.
// The epoch prevents a reconnect after server restart from skipping new records.
export class ApplicationLog {
  readonly epoch = randomUUID();
  private sequence = 0;
  private readonly records: ApplicationLogRecord[] = [];
  private readonly listeners = new Set<(record: ApplicationLogRecord) => void>();
  constructor(readonly capacity = 2000, private readonly secrets: readonly string[] = []) {}
  append(level: ApplicationLogLevel, message: string, source: ApplicationLogSource = 'server'): void {
    const record = { id: this.epoch + ':' + ++this.sequence, occurredAt: new Date().toISOString(), level, source, message: redactLog(message, this.secrets) };
    this.records.push(record);
    if (this.records.length > this.capacity) this.records.splice(0, this.records.length - this.capacity);
    for (const listener of this.listeners) {
      try { listener(record); } catch { /* A broken client cannot stop logging or other subscribers. */ }
    }
  }
  tail(cursor?: string): { records: ApplicationLogRecord[]; reset: boolean; gap: boolean } {
    const sequence = cursor?.startsWith(this.epoch + ':') ? Number(cursor.slice(this.epoch.length + 1)) : NaN;
    const reset = !!cursor && (!Number.isSafeInteger(sequence) || sequence > this.sequence);
    const first = Number(this.records[0]?.id.split(':')[1] || 1);
    const gap = !reset && Number.isSafeInteger(sequence) && sequence < first - 1;
    return { records: this.records.filter(record => !cursor || reset || Number(record.id.split(':')[1]) > sequence), reset, gap };
  }
  subscribe(listener: (record: ApplicationLogRecord) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  captureConsole(): () => void {
    const restores: (() => void)[] = [];
    for (const [method, level] of Object.entries({ debug: 'debug', log: 'info', info: 'info', warn: 'warning', error: 'error' } as const)) {
      const key = method as 'debug' | 'log' | 'info' | 'warn' | 'error';
      const original = console[key];
      const captured = (...args: unknown[]) => {
        original.apply(console, args);
        try { this.append(level, formatWithOptions({ depth: 3, maxArrayLength: 20, maxStringLength: 4096, getters: false }, ...args)); } catch { /* Logging must never fail the operation being logged. */ }
      };
      console[key] = captured;
      restores.push(() => { if (console[key] === captured) console[key] = original; });
    }
    return () => restores.forEach(restore => restore());
  }
}

export function logSecrets(env: NodeJS.ProcessEnv): string[] {
  return Object.entries(env).filter(([key]) => /password|passwd|secret|token|private|api_?key|database_url/i.test(key))
    .flatMap(([, value]) => value ? [value] : []);
}
