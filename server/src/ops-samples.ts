import type { Pool } from 'pg';

type Queryable = Pick<Pool, 'query'>;

export const RETENTION_DAYS = 14;

// Records current slot usage of every host and drops samples older than the retention window.
export async function sampleOnce(pool: Queryable, now = new Date()): Promise<void> {
  await pool.query(
    `INSERT INTO ops_samples(host_id,at,used,total)
     SELECT h.id,$1::timestamptz,count(hs.session_id)::int,count(hs.host_id)::int
       FROM hosts h LEFT JOIN host_slots hs ON hs.host_id=h.id GROUP BY h.id
     ON CONFLICT (host_id,at) DO NOTHING`, [now.toISOString()]);
  await pool.query(`DELETE FROM ops_samples WHERE at < $1::timestamptz - make_interval(days => $2)`, [now.toISOString(), RETENTION_DAYS]);
}

export function startSampler(pool: Queryable, seconds: number): () => Promise<void> {
  if (seconds <= 0) return () => Promise.resolve();
  let running: Promise<void> | null = null;
  const run = () => {
    if (running) return;
    running = sampleOnce(pool).catch(() => console.error('Ops sample failed')).finally(() => { running = null; });
  };
  run();
  const timer = setInterval(run, seconds * 1000);
  timer.unref();
  return () => { clearInterval(timer); return running ?? Promise.resolve(); };
}

export type SeriesPoint = { at: string; used: number; total: number };
export type HostSeries = { hostId: string; hostName: string; points: SeriesPoint[] };
export type Summary = {
  generatedAt: string;
  utilization24h: { bucketMinutes: number; series: HostSeries[] };
  utilization14d: { bucketMinutes: number; series: HostSeries[] };
  sessionsPerDay: Array<{ day: string; count: number }>;
  duration: { count: number; avgSeconds: number | null; p90Seconds: number | null };
  startsByHourUtc: number[];
  peakHourUtc: number | null;
  topUsers: Array<{ username: string; sessions: number; minutes: number }>;
  failures: { last24h: number; last14d: number };
  sampleCount: number;
};

const round = (value: number, digits = 2): number => Math.round(value * 10 ** digits) / 10 ** digits;

async function series(pool: Queryable, now: string, windowHours: number, bucketMinutes: number): Promise<HostSeries[]> {
  const bucket = bucketMinutes * 60;
  const result = await pool.query(
    `SELECT s.host_id, COALESCE(h.display_name, h.name, s.host_id) AS host_name,
            to_timestamp(floor(extract(epoch FROM s.at)/$3)*$3) AS bucket,
            avg(s.used)::float8 AS used, avg(s.total)::float8 AS total
       FROM ops_samples s LEFT JOIN hosts h ON h.id=s.host_id
      WHERE s.at > $1::timestamptz - make_interval(hours => $2) AND s.at <= $1::timestamptz
      GROUP BY s.host_id, host_name, bucket ORDER BY s.host_id, bucket`, [now, windowHours, bucket]);
  const byHost = new Map<string, HostSeries>();
  for (const row of result.rows) {
    const entry: HostSeries = byHost.get(row.host_id) ?? { hostId: row.host_id, hostName: row.host_name, points: [] };
    entry.points.push({ at: new Date(row.bucket).toISOString(), used: round(Number(row.used)), total: round(Number(row.total)) });
    byHost.set(row.host_id, entry);
  }
  return [...byHost.values()];
}

export async function computeSummary(pool: Queryable, now = new Date()): Promise<Summary> {
  const at = now.toISOString();
  const [u24, u14, perDay, dur, hours, top, fail, count] = await Promise.all([
    series(pool, at, 24, 15),
    series(pool, at, 24 * RETENTION_DAYS, 120),
    pool.query(`SELECT to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD') AS day, count(*)::int AS n FROM rental_history
                 WHERE created_at > $1::timestamptz - interval '14 days' AND created_at <= $1::timestamptz GROUP BY day`, [at]),
    pool.query(`SELECT count(*)::int AS n, avg(d)::float8 AS avg, percentile_cont(0.9) WITHIN GROUP (ORDER BY d)::float8 AS p90
                  FROM (SELECT extract(epoch FROM (ended_at - COALESCE(started_at, created_at))) AS d FROM rental_history
                         WHERE ended_at IS NOT NULL AND ended_at > $1::timestamptz - interval '14 days' AND ended_at <= $1::timestamptz) x`, [at]),
    pool.query(`SELECT extract(hour FROM created_at AT TIME ZONE 'UTC')::int AS h, count(*)::int AS n FROM rental_history
                 WHERE created_at > $1::timestamptz - interval '14 days' AND created_at <= $1::timestamptz GROUP BY h`, [at]),
    pool.query(`SELECT owner_username AS username, count(*)::int AS sessions,
                       sum(extract(epoch FROM (COALESCE(ended_at, $1::timestamptz) - COALESCE(started_at, created_at))))::float8/60 AS minutes
                  FROM rental_history WHERE created_at > $1::timestamptz - interval '14 days' AND created_at <= $1::timestamptz
                 GROUP BY owner_user_id, owner_username ORDER BY minutes DESC, username LIMIT 10`, [at]),
    // A failure is a session that ended in the failed state or that logged a session.failed event.
    pool.query(`SELECT count(DISTINCT sid) FILTER (WHERE t > $1::timestamptz - interval '24 hours')::int AS d1,
                       count(DISTINCT sid)::int AS d14
                  FROM (SELECT session_id::text AS sid, COALESCE(ended_at, created_at) AS t FROM rental_history WHERE final_state='failed'
                        UNION ALL SELECT target_id, occurred_at FROM audit_events WHERE action='session.failed' AND target_id IS NOT NULL) f
                 WHERE t > $1::timestamptz - interval '14 days' AND t <= $1::timestamptz`, [at]),
    pool.query(`SELECT count(*)::int AS n FROM ops_samples WHERE at > $1::timestamptz - interval '14 days'`, [at]),
  ]);
  const counts = new Map<string, number>(perDay.rows.map(row => [String(row.day), Number(row.n)]));
  const sessionsPerDay: Summary['sessionsPerDay'] = [];
  for (let offset = 13; offset >= 0; offset--) {
    const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - offset)).toISOString().slice(0, 10);
    sessionsPerDay.push({ day, count: counts.get(day) ?? 0 });
  }
  const startsByHourUtc = Array.from({ length: 24 }, () => 0);
  for (const row of hours.rows) startsByHourUtc[Number(row.h)] = Number(row.n);
  const max = Math.max(...startsByHourUtc);
  const d = dur.rows[0] ?? {};
  return {
    generatedAt: at,
    utilization24h: { bucketMinutes: 15, series: u24 },
    utilization14d: { bucketMinutes: 120, series: u14 },
    sessionsPerDay,
    duration: { count: Number(d.n ?? 0), avgSeconds: d.avg == null ? null : Math.round(d.avg), p90Seconds: d.p90 == null ? null : Math.round(d.p90) },
    startsByHourUtc,
    peakHourUtc: max > 0 ? startsByHourUtc.indexOf(max) : null,
    topUsers: top.rows.map(row => ({ username: String(row.username), sessions: Number(row.sessions), minutes: Math.round(Number(row.minutes)) })),
    failures: { last24h: Number(fail.rows[0]?.d1 ?? 0), last14d: Number(fail.rows[0]?.d14 ?? 0) },
    sampleCount: Number(count.rows[0]?.n ?? 0),
  };
}
