import { t } from './i18n';
import type { LogEntry, LogLevel } from './api';

export const LEVEL_ORDER: Record<LogLevel, number> = { V: 0, D: 1, I: 2, W: 3, E: 4, F: 5 };
export const MAX_BUFFERED_ENTRIES = 5000;

export interface LogFilter {
  query: string;
  regex: boolean;
  matchCase: boolean;
  minLevel: LogLevel;
  tag: string | null;
  pid: number | null;
}

export type Matcher = { test: (text: string) => boolean; error: string | null; pattern: RegExp | null };

// Builds a matcher for the search box. A bad regular expression reports an error
// and matches everything, so a half-typed pattern does not blank the log.
export function buildMatcher(query: string, regex: boolean, matchCase: boolean): Matcher {
  if (!query) return { test: () => true, error: null, pattern: null };
  const flags = matchCase ? 'g' : 'gi';
  try {
    const source = regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(source, flags);
    return { test: text => { pattern.lastIndex = 0; return pattern.test(text); }, error: null, pattern };
  } catch (error) {
    return { test: () => true, error: error instanceof Error ? error.message : t('ui.f7b75d61d876'), pattern: null };
  }
}

export function filterEntries(entries: LogEntry[], filter: LogFilter, matcher: Matcher): LogEntry[] {
  const min = LEVEL_ORDER[filter.minLevel];
  return entries.filter(entry => {
    if (LEVEL_ORDER[entry.level] < min) return false;
    if (filter.tag !== null && entry.tag !== filter.tag) return false;
    if (filter.pid !== null && entry.pid !== filter.pid) return false;
    return matcher.test(entry.tag + ' ' + entry.message);
  });
}

// Splits text into plain and highlighted parts for the search matches.
export function highlightParts(text: string, pattern: RegExp | null): Array<{ text: string; hit: boolean }> {
  if (!pattern) return [{ text, hit: false }];
  const parts: Array<{ text: string; hit: boolean }> = [];
  let last = 0;
  pattern.lastIndex = 0;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    if (match[0] === '') { pattern.lastIndex += 1; continue; }
    if (match.index > last) parts.push({ text: text.slice(last, match.index), hit: false });
    parts.push({ text: match[0], hit: true });
    last = match.index + match[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last), hit: false });
  return parts.length ? parts : [{ text, hit: false }];
}

export function appendEntries(current: LogEntry[], incoming: LogEntry[]): LogEntry[] {
  if (!incoming.length) return current;
  const merged = current.concat(incoming);
  return merged.length > MAX_BUFFERED_ENTRIES ? merged.slice(merged.length - MAX_BUFFERED_ENTRIES) : merged;
}

export function formatLogLine(entry: LogEntry): string {
  return `${entry.ts} ${String(entry.pid).padStart(5)} ${String(entry.tid).padStart(5)} ${entry.level} ${entry.tag}: ${entry.message}`;
}
