import { validatePackageName } from './logcat-apps.mjs';
// Logcat snapshots for the web viewer. The viewer polls with a cursor instead of
// holding a long-lived adb process per browser tab.

export const LOGCAT_LEVELS = ['V', 'D', 'I', 'W', 'E', 'F'];
export const LOGCAT_BUFFERS = ['main', 'system', 'crash', 'radio'];
export const MAX_LOGCAT_LINES = 5000;
const TIMESTAMP = /^\d\d-\d\d \d\d:\d\d:\d\d\.\d{3}$/;
const LINE = /^(\d\d-\d\d \d\d:\d\d:\d\d\.\d{3})\s+(\d+)\s+(\d+)\s+([VDIWEFA])\s+(.+?)\s*: ?(.*)$/;

export function validateLogcatParams(params = {}) {
  const lines = params.lines === undefined ? 1000 : Number(params.lines);
  if (!Number.isInteger(lines) || lines < 1 || lines > MAX_LOGCAT_LINES) throw new Error('Invalid logcat line count');
  const minLevel = params.minLevel === undefined ? 'V' : params.minLevel;
  if (!LOGCAT_LEVELS.includes(minLevel)) throw new Error('Invalid logcat level');
  const buffers = params.buffers === undefined ? ['main', 'system', 'crash'] : params.buffers;
  if (!Array.isArray(buffers) || buffers.length < 1 || buffers.length > LOGCAT_BUFFERS.length ||
      new Set(buffers).size !== buffers.length || !buffers.every((name) => LOGCAT_BUFFERS.includes(name))) {
    throw new Error('Invalid logcat buffers');
  }
  let since = null;
  let skip = 0;
  if (params.since !== undefined && params.since !== null) {
    if (typeof params.since !== 'string' || !TIMESTAMP.test(params.since)) throw new Error('Invalid logcat cursor');
    since = params.since;
    skip = params.skip === undefined ? 0 : Number(params.skip);
    if (!Number.isInteger(skip) || skip < 0 || skip > MAX_LOGCAT_LINES * 10) throw new Error('Invalid logcat cursor');
  }
  const packageName = params.packageName === undefined ? null : validatePackageName(params.packageName);
  return { lines, minLevel, buffers, since, skip, packageName };
}

export function logcatArgv({ lines, minLevel, buffers, since, uid }) {
  if (uid !== undefined && (!Number.isSafeInteger(uid) || uid < 0 || uid > 2147483647)) throw new Error('Invalid Android UID');
  return ['logcat', '-d', '-v', 'threadtime', '-b', buffers.join(','), ...(uid === undefined ? [] : ['-v', 'uid']),
    ...(since ? ['-T', since] : ['-t', String(lines)]), `*:${minLevel}`];
}

export function parseLogcat(text) {
  const entries = [];
  for (const raw of String(text).split(/\r?\n/)) {
    if (!raw || raw.startsWith('--------- ')) continue;
    const match = LINE.exec(raw);
    if (match) {
      entries.push({
        ts: match[1], pid: Number(match[2]), tid: Number(match[3]),
        level: match[4] === 'A' ? 'F' : match[4], tag: match[5], message: match[6],
      });
    } else if (entries.length) {
      entries[entries.length - 1].message += '\n' + raw;
    }
  }
  return entries;
}

// Returns the entries newer than the cursor plus the next cursor.
export function pageLogcat(entries, { since, skip, lines }) {
  let rows = entries;
  if (since) {
    let toSkip = skip;
    rows = [];
    for (const entry of entries) {
      if (entry.ts === since && toSkip > 0) { toSkip -= 1; continue; }
      if (entry.ts < since) continue;
      rows.push(entry);
    }
  }
  if (rows.length > lines) rows = rows.slice(rows.length - lines);
  const last = rows.length ? rows[rows.length - 1].ts : since;
  let nextSkip = 0;
  if (last) {
    const at = entries.filter((entry) => entry.ts === last).length;
    nextSkip = at;
  }
  return { entries: rows, cursor: last ? { since: last, skip: nextSkip } : null };
}
