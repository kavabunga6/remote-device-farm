// Dev mock for the ops feature. Return true when the request was handled.
// `state` is shared by all mocks (user, sessions, hosts, profiles); `send(res, status, body)` writes JSON.
function buildSummary(now) {
  const series = (hostId, hostName, hours, bucketMin, total, phase) => {
    const points = [];
    const step = bucketMin * 60000;
    const end = Math.floor(now / step) * step;
    for (let t = end - hours * 3600000 + step; t <= end; t += step) {
      const hour = new Date(t).getHours() + new Date(t).getMinutes() / 60;
      const wave = Math.sin(((hour + phase) / 24) * Math.PI * 2 - 1.5) * 0.5 + 0.5;
      const used = Math.round(wave * total * 10) / 10;
      // A gap in the middle shows how missing samples render.
      if (hostId === 'h2' && t > end - hours * 3600000 * 0.55 && t < end - hours * 3600000 * 0.45) continue;
      points.push({ at: new Date(t).toISOString(), used, total });
    }
    return { hostId, hostName, points };
  };
  const per = [3, 5, 4, 7, 6, 2, 0, 1, 8, 9, 5, 6, 4, 7];
  const day = i => new Date(now - (13 - i) * 86400000).toISOString().slice(0, 10);
  return {
    generatedAt: new Date(now).toISOString(),
    utilization24h: { bucketMinutes: 15, series: [series('h1', 'worker-01', 24, 15, 4, 0), series('h2', 'lab-2', 24, 15, 6, 5)] },
    utilization14d: { bucketMinutes: 120, series: [series('h1', 'worker-01', 24 * 14, 120, 4, 0), series('h2', 'lab-2', 24 * 14, 120, 6, 5)] },
    sessionsPerDay: per.map((count, i) => ({ day: day(i), count })),
    duration: { count: 57, avgSeconds: 2520, p90Seconds: 6300 },
    startsByHourUtc: Array.from({ length: 24 }, (_, h) => (h === 9 ? 12 : h > 6 && h < 17 ? 4 : 0)),
    peakHourUtc: 9,
    topUsers: [
      { username: 'worker-01', sessions: 21, minutes: 1310 },
      { username: 'ivan.petrov', sessions: 14, minutes: 640 },
      { username: 'qa-bot', sessions: 9, minutes: 215 },
    ],
    failures: { last24h: 1, last14d: 3 },
    sampleCount: 20000,
  };
}

export default function handle(_req, res, path, method, state, send) {
  if (method === 'GET' && path === '/admin/ops/summary') {
    if (process.env.MOCK_OPS_EMPTY === '1') {
      const s = buildSummary(state.now);
      send(res, 200, { ...s, utilization24h: { bucketMinutes: 15, series: [] }, utilization14d: { bucketMinutes: 120, series: [] },
        sessionsPerDay: s.sessionsPerDay.map(d => ({ ...d, count: 0 })), duration: { count: 0, avgSeconds: null, p90Seconds: null },
        peakHourUtc: null, topUsers: [], failures: { last24h: 0, last14d: 0 }, sampleCount: 0 });
    } else send(res, 200, buildSummary(Date.now()));
    return true;
  }
  return false;
}
