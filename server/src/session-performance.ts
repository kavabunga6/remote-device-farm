import type { Pool } from 'pg';
import { DEVICE_KINDS, devicePlaceholderProfile } from './device-session.js';

type CrashEvent = { session_id: string; code: string; message: string; occurred_at: Date };
type Rental = { session_id: string; profile_id: string; final_state: string | null; ended_at: Date | null };
const startupFailures = ['session.prepare_failed', 'session.start_failed', 'session.start_timeout'];

export function isEmulatorRental(profileId: string) {
  return !DEVICE_KINDS.some(kind => profileId === devicePlaceholderProfile(kind));
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function timestamp(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

export function containerSample(value: unknown) {
  if (!value || typeof value !== 'object') return null;
  const data = value as Record<string, unknown>;
  const sampledAt = timestamp(data.sampledAt);
  if (!sampledAt) return null;
  return {
    sampledAt,
    cpuCores: numberOrNull(data.cpuCores),
    throttlePercent: numberOrNull(data.throttlePercent),
    memoryBytes: numberOrNull(data.memoryBytes),
    memoryWorkingSetBytes: numberOrNull(data.memoryWorkingSetBytes),
    memoryLimitBytes: numberOrNull(data.memoryLimitBytes),
    readBytesPerSecond: numberOrNull(data.readBytesPerSecond),
    writeBytesPerSecond: numberOrNull(data.writeBytesPerSecond),
  };
}

export function processSnapshot(data: Record<string, unknown>) {
  const sampledAt = timestamp(data.sampledAt);
  if (!sampledAt || !Array.isArray(data.processes)) return null;
  const processes = data.processes.slice(0, 20).flatMap((row: unknown) => {
    if (!row || typeof row !== 'object') return [];
    const process = row as Record<string, unknown>;
    const pid = numberOrNull(process.pid);
    const cpuPercent = numberOrNull(process.cpuPercent);
    const residentBytes = numberOrNull(process.residentBytes);
    if (!pid || !Number.isSafeInteger(pid) || cpuPercent === null || residentBytes === null ||
        typeof process.name !== 'string' || !process.name.trim()) return [];
    return [{ pid, cpuPercent, residentBytes, name: process.name.replace(/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g, '').slice(0, 160) }];
  });
  return { sampledAt, processes };
}

async function crashEvents(pool: Pick<Pool, 'query'>, sessionIds: string[]) {
  const { rows } = await pool.query<CrashEvent>(
    `SELECT DISTINCT ON (session_id, code) session_id, code, message, occurred_at FROM service_logs
     WHERE session_id=ANY($1::uuid[]) AND code=ANY($2::text[])
     ORDER BY session_id, code, id DESC`,
    [sessionIds, ['container.state', 'session.unexpected_stop', 'session.container_missing', ...startupFailures]]);
  return rows;
}

function crashDetails(rows: CrashEvent[], failed: boolean) {
  const state = rows.find(row => row.code === 'container.state');
  const startup = rows.find(row => startupFailures.includes(row.code));
  const unexpected = startup ?? rows.find(row => row.code !== 'container.state');
  let data: Record<string, unknown> = {};
  if (state) {
    try {
      const parsed: unknown = JSON.parse(state.message);
      if (parsed && typeof parsed === 'object') data = parsed as Record<string, unknown>;
    } catch { /* Older or truncated diagnostics may not contain a structured state. */ }
  }
  const stopped = data.running === false;
  const exitCode = stopped && Number.isInteger(data.exitCode) ? Number(data.exitCode) : null;
  const oomKilled = stopped && typeof data.oomKilled === 'boolean' ? data.oomKilled : null;
  if (!unexpected && !failed && !(stopped && (oomKilled || (exitCode !== null && exitCode !== 0)))) return null;
  const occurredAt = timestamp(data.finishedAt);
  const event = unexpected ?? state;
  return {
    reason: oomKilled ? 'oom' : startup ? 'startup' : stopped ? 'exit' : 'lost',
    occurredAt: occurredAt && Date.parse(occurredAt) > 0 ? occurredAt
      : event ? new Date(event.occurred_at).toISOString() : null,
    exitCode,
    oomKilled,
    lastSample: containerSample(data.performance),
  };
}

export async function sessionCrash(pool: Pick<Pool, 'query'>, sessionId: string, failed: boolean, includeLogs: boolean) {
  const details = crashDetails(await crashEvents(pool, [sessionId]), failed);
  if (!details) return null;
  const logs = includeLogs ? await pool.query<{ message: string }>(
    `SELECT left(message, 500) AS message FROM service_logs
     WHERE session_id=$1 AND code IN ('container.stdout','container.stderr') ORDER BY id DESC LIMIT 12`, [sessionId]) : null;
  return { ...details, logs: logs?.rows.reverse().map(row => row.message) ?? [] };
}

export async function rentalCrashIds(pool: Pick<Pool, 'query'>, rentals: Rental[]) {
  const ended = rentals.filter(rental => rental.ended_at && isEmulatorRental(rental.profile_id));
  if (!ended.length) return new Set<string>();
  const events = await crashEvents(pool, ended.map(rental => rental.session_id));
  const bySession = new Map<string, CrashEvent[]>();
  for (const event of events) {
    const previous = bySession.get(event.session_id);
    if (previous) previous.push(event);
    else bySession.set(event.session_id, [event]);
  }
  return new Set(ended.filter(rental => crashDetails(bySession.get(rental.session_id) ?? [], rental.final_state === 'failed'))
    .map(rental => rental.session_id));
}
