import type { TrafficEntry } from './debug-api';

export type TrafficFilter = 'all' | 'http' | 'tunnels' | 'errors';

export function trafficAddress(entry: TrafficEntry) {
  try {
    const url = new URL(entry.url);
    return { host: url.host, origin: url.origin, path: url.pathname + url.search, pathname: url.pathname, search: url.search };
  } catch {
    return { host: entry.url, origin: entry.url, path: entry.url, pathname: entry.url, search: '' };
  }
}

function readable(value: string) {
  try { return decodeURIComponent(value); } catch { return value; }
}

export function filterTraffic(entries: TrafficEntry[], query: string, filter: TrafficFilter) {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return entries.filter(entry => {
    if (filter === 'http' && entry.method === 'CONNECT') return false;
    if (filter === 'tunnels' && entry.method !== 'CONNECT') return false;
    if (filter === 'errors' && entry.outcome !== 'error' && (entry.status === null || entry.status < 400)) return false;
    const text = (entry.method + ' ' + readable(entry.url) + ' ' + (entry.status ?? '')).toLowerCase();
    return terms.every(term => text.includes(term));
  }).slice().sort((a, b) => a.startedAt - b.startedAt || a.id - b.id);
}

export type TrafficNode = {
  key: string;
  label: string;
  count: number;
  children: TrafficNode[];
  entries: { entry: TrafficEntry; label: string }[];
};

export function trafficTree(entries: TrafficEntry[]): TrafficNode[] {
  const hosts = new Map<string, TrafficNode>();
  for (const entry of entries) {
    const { origin, pathname, search } = trafficAddress(entry);
    const existing = hosts.get(origin);
    let node: TrafficNode = existing ?? { key: JSON.stringify([origin]), label: origin, count: 0, children: [], entries: [] };
    if (!existing) hosts.set(origin, node);
    node.count++;
    if (entry.method === 'CONNECT') {
      node.entries.push({ entry, label: origin });
      continue;
    }
    const parts = pathname.split('/');
    const leaf = (parts.pop() || '/') + search;
    const folders = parts.filter(Boolean);
    // Deep paths stay inspectable without creating an unbounded nesting level.
    const groups = folders.slice(0, 8);
    const label = [...folders.slice(8), leaf].join('/');
    const key = [origin];
    for (const folder of groups) {
      key.push(folder);
      const id = JSON.stringify(key);
      let child: TrafficNode | undefined = node.children.find(item => item.key === id);
      if (!child) {
        child = { key: id, label: readable(folder) + '/', count: 0, children: [], entries: [] };
        node.children.push(child);
      }
      child.count++;
      node = child;
    }
    node.entries.push({ entry, label: readable(label) });
  }
  return [...hosts.values()];
}

export function trafficPhase(entry: TrafficEntry) {
  if (entry.outcome === 'error') return 'error' as const;
  if (entry.status !== null && entry.status >= 400) return 'httpError' as const;
  if (entry.outcome === 'open') return 'open' as const;
  if (entry.outcome === 'stopped') return 'stopped' as const;
  if (entry.outcome === 'complete') return 'complete' as const;
  if (entry.outcome === 'pending' || entry.durationMs === null)
    return ({ connect: 'connecting', send: 'sending', wait: 'waiting', receive: 'receiving' } as const)[entry.phase as 'connect' | 'send' | 'wait' | 'receive'] ?? 'pending';
  return 'unknown' as const;
}
