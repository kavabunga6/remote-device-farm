import { agentMessage } from './messages.mjs';

export const TRACE_SECONDS = 10;
export const MAX_TRACE_BYTES = 5 * 1024 * 1024;
const TRACE_CHUNK_BYTES = 48 * 1024;
const TRACE_LIFETIME_MS = 60_000;
const PROCESS_LIMIT = 20;

export function parseProcessSnapshot(output) {
  const lines = output.split(/\r?\n/);
  const header = lines.findLastIndex(line => /^PID\s+%CPU\s+RES\s+NAME$/.test(line.replace(/[\[\]]/g, ' ').trim()));
  if (header < 0) return null;
  const rows = [];
  for (const line of lines.slice(header + 1)) {
    const fields = /^\s*(\d+)\s+(\d+(?:\.\d+)?)%?\s+(\d+(?:\.\d+)?)([KMG]?)\s+(.{1,160})\s*$/i.exec(line);
    if (!fields) continue;
    const [, pid, cpu, memory, unit, name] = fields;
    const bytes = Number(memory) * ({ '': 1024, K: 1024, M: 1024 ** 2, G: 1024 ** 3 }[unit.toUpperCase()]);
    if (!Number.isSafeInteger(Number(pid)) || !Number.isFinite(Number(cpu)) || !Number.isFinite(bytes)) continue;
    rows.push({ pid: Number(pid), name: name.trim(), cpuPercent: Number(cpu), residentBytes: Math.round(bytes) });
    if (rows.length === PROCESS_LIMIT) break;
  }
  return rows;
}

export async function sampleAndroidProcesses(adb, serial, signal) {
  // Toybox's first CPU reading includes time before the sampling window.
  const result = await adb.run(serial, ['shell', 'top', '-b', '-n', '2', '-d', '1', '-m', String(PROCESS_LIMIT), '-o', 'PID,%CPU,RES,NAME', '-s', '2'],
    { timeoutMs: 5000, maxOutputBytes: 32 * 1024, signal });
  const processes = result.exitCode === 0 ? parseProcessSnapshot(result.stdout) : null;
  if (processes === null) throw new Error(agentMessage('performance.processUnavailable'));
  return { sampledAt: new Date().toISOString(), processes };
}

const TRACE_CONFIG = `
duration_ms: ${TRACE_SECONDS * 1000}
buffers { size_kb: 4096 fill_policy: RING_BUFFER }
data_sources {
  config {
    name: "linux.ftrace"
    ftrace_config {
      compact_sched { enabled: true }
      ftrace_events: "sched/sched_switch"
    }
  }
}
data_sources {
  config {
    name: "linux.process_stats"
    process_stats_config { scan_all_processes_on_start: true }
  }
}
data_sources { config { name: "android.surfaceflinger.frametimeline" } }
`;

export async function recordAndroidTrace(adb, serial, signal) {
  // exec-out preserves binary data and multiplexes stderr into stdout unless redirected.
  const result = await adb.run(serial, ['exec-out', `printf '%s' '${TRACE_CONFIG}' | perfetto --txt -c - -o - 2>/dev/null`],
    { timeoutMs: 20_000, maxOutputBytes: MAX_TRACE_BYTES, encoding: null, signal });
  if (result.exitCode !== 0 || !result.stdout.length || result.stdout[0] !== 0x0a) {
    throw new Error(agentMessage('performance.traceUnavailable'));
  }
  return result.stdout;
}

// Pull one bounded result at a time so a trace cannot fill the shared media socket.
export class AndroidTraceCapture {
  entry = null;

  async open(sessionId, traceId, capture) {
    if (typeof traceId !== 'string' || !/^[0-9a-f-]{36}$/.test(traceId)) throw new Error(agentMessage('performance.traceUnavailable'));
    if (this.entry) {
      const error = new Error(agentMessage('performance.busy'));
      error.code = 'performance_busy';
      throw error;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => this.release(sessionId, traceId), TRACE_LIFETIME_MS);
    timer.unref();
    const entry = { sessionId, traceId, controller, timer, bytes: null };
    this.entry = entry;
    try {
      const bytes = await capture(controller.signal);
      controller.signal.throwIfAborted();
      entry.bytes = bytes;
      return { size: bytes.length };
    } catch (error) {
      if (this.entry === entry) this.release(sessionId, traceId);
      throw error;
    }
  }

  read(sessionId, traceId, offset) {
    const entry = this.entry;
    if (!entry?.bytes || entry.sessionId !== sessionId || entry.traceId !== traceId ||
        !Number.isSafeInteger(offset) || offset < 0 || offset >= entry.bytes.length) {
      throw new Error(agentMessage('performance.traceUnavailable'));
    }
    return { chunk: entry.bytes.subarray(offset, offset + TRACE_CHUNK_BYTES).toString('base64') };
  }

  release(sessionId, traceId) {
    const entry = this.entry;
    if (!entry || entry.sessionId !== sessionId || entry.traceId !== traceId) return;
    this.entry = null;
    clearTimeout(entry.timer);
    entry.controller.abort();
  }

  dispose(sessionId = this.entry?.sessionId) {
    this.release(sessionId, this.entry?.traceId);
  }
}
