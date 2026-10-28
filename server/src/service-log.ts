import { diagnostic } from './diagnostics.js';
import { redactLog, type ApplicationLog } from './application-log.js';
import type { Pool } from 'pg';

export type ServiceLogCode = `session.${string}` | `container.${string}` | `image_cleanup.${string}` | 'api.internal_error' | 'websocket.upgrade_error' | 'adb.listener_error' | 'emulator_images.reconcile_failed' | 'emulator_images.catalog_failed' | 'agent.connected' | 'agent.disconnected' | 'agent.message_failed' | 'agent.provider_unavailable' | 'agent.provider_recovered';

export type ServiceLogEvent = {
  service: 'server' | 'agent' | 'emulator';
  severity: 'info' | 'warning' | 'error';
  code: ServiceLogCode;
  hostId?: string;
  sessionId?: string;
  message?: string;
};

const liveLogs = new WeakMap<Pick<Pool, 'query'>, ApplicationLog>();

export function connectServiceLog(pool: Pick<Pool, 'query'>, logs: ApplicationLog): () => void {
  liveLogs.set(pool, logs);
  return () => { if (liveLogs.get(pool) === logs) liveLogs.delete(pool); };
}

/** Emit before persistence so storage failures remain visible in the runtime tail. */
export function emitServiceLog(pool: Pick<Pool, 'query'>, event: ServiceLogEvent): void {
  const logs = liveLogs.get(pool);
  if (!logs) return;
  const context = [event.code, ...(event.hostId ? ['host=' + event.hostId] : []), ...(event.sessionId ? ['session=' + event.sessionId] : [])].join(' ');
  try { logs.append(event.severity, context + (event.message ? ': ' + event.message : ''), event.service); }
  catch { /* Runtime logging cannot change the operation being observed. */ }
}

export async function recordServiceLog(pool: Pick<Pool, 'query'>, event: ServiceLogEvent): Promise<void> {
  emitServiceLog(pool, event);
  await pool.query(
    'INSERT INTO service_logs(service,severity,code,host_id,session_id,message) VALUES($1,$2,$3,$4,$5,$6)',
    [event.service, event.severity, event.code, event.hostId || null, event.sessionId || null, redactLog(event.message || '')],
  );
}

/** Diagnostic writes must not change the outcome of a launch or cleanup. */
export async function sessionLog(pool: Pick<Pool, 'query'>, hostId: string, sessionId: string,
  code: ServiceLogCode, message: string, severity: 'info' | 'warning' | 'error' = 'info',
  service: 'server' | 'agent' | 'emulator' = 'server'): Promise<void> {
  try { await recordServiceLog(pool, { hostId, sessionId, code, message, severity, service }); }
  catch (error) { console.error(diagnostic('service-log.e80075a3a8', { p0: (error instanceof Error ? error.message : 'unknown storage error') })); }
}
