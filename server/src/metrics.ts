import { createHash, timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from 'express';
import type { Pool } from 'pg';

// Prometheus text exposition (format 0.0.4). Labels are always bounded: host ids, session states, HTTP method and status class.

export type Labels = Record<string, string>;
export type Sample = { name: string; labels?: Labels; value: number };
export type Family = { name: string; help: string; type: 'gauge' | 'counter' | 'histogram'; samples: Sample[] };

export function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}

function escapeHelp(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n');
}

function formatValue(value: number): string {
  if (Number.isNaN(value)) return 'NaN';
  if (value === Infinity) return '+Inf';
  if (value === -Infinity) return '-Inf';
  return String(value);
}

function formatSample(sample: Sample): string {
  const labels = Object.entries(sample.labels ?? {}).map(([key, value]) => `${key}="${escapeLabelValue(value)}"`).join(',');
  return `${sample.name}${labels ? `{${labels}}` : ''} ${formatValue(sample.value)}`;
}

export function renderMetrics(families: Family[]): string {
  const lines: string[] = [];
  for (const family of families) {
    lines.push(`# HELP ${family.name} ${escapeHelp(family.help)}`, `# TYPE ${family.name} ${family.type}`);
    for (const sample of family.samples) lines.push(formatSample(sample));
  }
  return lines.join('\n') + '\n';
}

export const DURATION_BUCKETS = [60, 300, 900, 1800, 3600, 7200, 14400, 28800];

// `durations` are seconds; buckets are cumulative as Prometheus requires.
export function histogramFamily(name: string, help: string, durations: number[], bounds = DURATION_BUCKETS): Family {
  const samples: Sample[] = bounds.map(le => ({
    name: `${name}_bucket`, labels: { le: String(le) }, value: durations.filter(value => value <= le).length,
  }));
  samples.push({ name: `${name}_bucket`, labels: { le: '+Inf' }, value: durations.length });
  samples.push({ name: `${name}_sum`, value: durations.reduce((sum, value) => sum + value, 0) });
  samples.push({ name: `${name}_count`, value: durations.length });
  return { name, help, type: 'histogram', samples };
}

export function tokenMatches(header: string | undefined, token: string): boolean {
  const match = /^Bearer (.{1,512})$/.exec(header ?? '');
  if (!match) return false;
  // Hashing first gives equal-length buffers, so the compare is constant-time for any input length.
  const given = createHash('sha256').update(match[1]!).digest();
  const wanted = createHash('sha256').update(token).digest();
  return timingSafeEqual(given, wanted);
}

// ---- HTTP counters (process-local) ----
const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
const httpCounts = new Map<string, number>();
let loginFailures = 0;

export function statusClass(status: number): string {
  return status >= 100 && status < 600 ? `${Math.floor(status / 100)}xx` : 'other';
}

export function countRequest(method: string, status: number, path: string): void {
  const key = `${METHODS.has(method) ? method : 'OTHER'}|${statusClass(status)}`;
  httpCounts.set(key, (httpCounts.get(key) ?? 0) + 1);
  if (method === 'POST' && path === '/api/login' && status === 401) loginFailures++;
}

export const httpCounter: RequestHandler = (req, res, next) => {
  res.once('finish', () => countRequest(req.method, res.statusCode, req.path));
  next();
};

export function httpFamilies(): Family[] {
  const samples: Sample[] = [...httpCounts].sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => {
    const [method, cls] = key.split('|') as [string, string];
    return { name: 'rdf_http_requests_total', labels: { method, status_class: cls }, value };
  });
  return [
    { name: 'rdf_http_requests_total', help: 'HTTP requests handled since process start.', type: 'counter', samples },
    { name: 'rdf_login_failures_total', help: 'Rejected password logins since process start.', type: 'counter',
      samples: [{ name: 'rdf_login_failures_total', value: loginFailures }] },
  ];
}

export function resetHttpCounters(): void { httpCounts.clear(); loginFailures = 0; }

// ---- Database collection ----
const STATES = ['starting', 'running', 'stopping', 'stopped', 'failed'];

export async function collectFamilies(pool: Pick<Pool, 'query'>): Promise<Family[]> {
  const [states, hosts, durations] = await Promise.all([
    pool.query('SELECT state, count(*)::int AS n FROM sessions GROUP BY state'),
    pool.query(`SELECT h.id, h.status, extract(epoch FROM (now() - h.last_seen_at))::float8 AS seen_ago,
        count(hs.host_id)::int AS total, count(hs.session_id)::int AS used
      FROM hosts h LEFT JOIN host_slots hs ON hs.host_id=h.id GROUP BY h.id, h.status, h.last_seen_at ORDER BY h.id`),
    pool.query(`SELECT extract(epoch FROM (ended_at - COALESCE(started_at, created_at)))::float8 AS seconds
      FROM rental_history WHERE ended_at > now() - interval '24 hours'`),
  ]);
  const byState = new Map<string, number>(states.rows.map(row => [String(row.state), Number(row.n)]));
  const hostRows = hosts.rows as Array<{ id: string; status: string; seen_ago: number | null; total: number; used: number }>;
  const seconds = (durations.rows as Array<{ seconds: number }>).map(row => Math.max(0, Number(row.seconds)));
  return [
    { name: 'rdf_sessions', help: 'Sessions by state.', type: 'gauge',
      samples: STATES.map(state => ({ name: 'rdf_sessions', labels: { state }, value: byState.get(state) ?? 0 })) },
    { name: 'rdf_hosts_online', help: 'Hosts with a connected agent.', type: 'gauge',
      samples: [{ name: 'rdf_hosts_online', value: hostRows.filter(row => row.status === 'online').length }] },
    { name: 'rdf_hosts_total', help: 'Known hosts.', type: 'gauge', samples: [{ name: 'rdf_hosts_total', value: hostRows.length }] },
    { name: 'rdf_slots_total', help: 'Device slots per host.', type: 'gauge',
      samples: hostRows.map(row => ({ name: 'rdf_slots_total', labels: { host: row.id }, value: row.total })) },
    { name: 'rdf_slots_used', help: 'Occupied device slots per host.', type: 'gauge',
      samples: hostRows.map(row => ({ name: 'rdf_slots_used', labels: { host: row.id }, value: row.used })) },
    { name: 'rdf_agent_last_seen_seconds', help: 'Seconds since the last agent heartbeat.', type: 'gauge',
      samples: hostRows.filter(row => row.seen_ago !== null).map(row => ({
        name: 'rdf_agent_last_seen_seconds', labels: { host: row.id }, value: Math.max(0, Math.round(Number(row.seen_ago))),
      })) },
    // A rolling 24 h window, so the buckets can go down; use it with gauges, not rate().
    histogramFamily('rdf_session_duration_seconds', 'Duration of sessions that ended in the last 24 hours.', seconds),
    ...httpFamilies(),
  ];
}
