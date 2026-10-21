import { useEffect, useMemo, useState, type KeyboardEvent, type ReactNode } from 'react';
import { t } from '../i18n';
import { Icon } from '../icons';
import type { TrafficEntry } from './debug-api';
import { trafficAddress, trafficPhase, trafficTree, type TrafficNode } from './traffic-entries';
import { TrafficStatus, trafficSize, trafficTime, trafficStarted } from './TrafficDetails';

export function TrafficList({ entries, mode, selectedId, onSelect, onOrderChange, searching, empty }: {
  entries: TrafficEntry[]; mode: 'sequence' | 'structure'; selectedId: number | null; onSelect: (id: number) => void; searching: boolean; empty: ReactNode; onOrderChange: (ids: number[]) => void;
}) {
  const [sort, setSort] = useState<{ key: 'startedAt' | 'status' | 'durationMs' | 'bytes'; descending: boolean }>({ key: 'startedAt', descending: false });
  const sorted = useMemo(() => entries.slice().sort((a, b) => {
    const value = (item: TrafficEntry) => sort.key === 'durationMs' ? item.durationMs ?? item.elapsedMs ?? null : item[sort.key];
    const first = value(a), second = value(b);
    if (first === null) return second === null ? a.id - b.id : 1;
    if (second === null) return -1;
    return (first - second || a.id - b.id) * (sort.descending ? -1 : 1);
  }), [entries, sort]);
  const tree = useMemo(() => trafficTree(entries), [entries]);
  const [branches, setBranches] = useState<Map<string, boolean>>(() => new Map());
  const navigation = useMemo(() => {
    if (mode === 'sequence') return sorted.map(entry => entry.id);
    const ids: number[] = [];
    const collect = (nodes: TrafficNode[]) => { for (const item of nodes) { collect(item.children); ids.push(...item.entries.map(row => row.entry.id)); } };
    collect(tree); return ids;
  }, [mode, sorted, tree]);
  useEffect(() => onOrderChange(navigation), [navigation, onOrderChange]);
  useEffect(() => {
    if (searching) return;
    const keys = new Set<string>();
    const collect = (nodes: TrafficNode[]) => { for (const item of nodes) { keys.add(item.key); collect(item.children); } };
    collect(tree);
    setBranches(previous => {
      const retained = new Map([...previous].filter(([key]) => keys.has(key)));
      return retained.size === previous.size ? previous : retained;
    });
  }, [tree, searching]);
  const navigate = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const buttons = Array.from(event.currentTarget.closest('.traffic-list')!.querySelectorAll<HTMLButtonElement>('.traffic-request'));
    const visible = buttons.filter(button => button.getClientRects().length > 0);
    const position = visible.indexOf(event.currentTarget);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? visible.length - 1 : position + (event.key === 'ArrowDown' ? 1 : -1);
    if (!visible[next]) return;
    event.preventDefault(); visible[next]!.focus(); visible[next]!.click(); visible[next]!.scrollIntoView({ block: 'nearest' });
  };
  const navigateTree = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const target = event.target as HTMLElement;
    if (!target.matches('summary,.traffic-request')) return;
    const branch = target.closest<HTMLDetailsElement>('.traffic-tree-node');
    const summary = target.matches('summary');
    let next: HTMLElement | undefined | null;
    if (event.key === 'ArrowLeft') {
      if (summary && branch?.open) branch.open = false;
      else next = (summary ? branch?.parentElement?.closest('.traffic-tree-node') : branch)?.querySelector<HTMLElement>(':scope > summary');
    } else if (event.key === 'ArrowRight') {
      if (!summary || !branch) return;
      if (!branch.open) branch.open = true;
      else next = branch.querySelector<HTMLElement>('.traffic-tree-children summary,.traffic-tree-children .traffic-request');
    } else {
      const visible = [...event.currentTarget.querySelectorAll<HTMLElement>('summary,.traffic-request')].filter(item => item.getClientRects().length > 0);
      const position = visible.indexOf(target);
      next = visible[event.key === 'Home' ? 0 : event.key === 'End' ? visible.length - 1 : position + (event.key === 'ArrowDown' ? 1 : -1)];
    }
    event.preventDefault(); event.stopPropagation();
    if (next) {
      next.focus(); next.scrollIntoView({ block: 'nearest' });
      if (next.matches('.traffic-request')) next.click();
    }
  };
  const request = (entry: TrafficEntry, label: string, treeMode = false) => <button type="button" className="traffic-request"
    data-entry-id={entry.id} aria-pressed={entry.id === selectedId} title={entry.url} onKeyDown={navigate} onClick={() => onSelect(entry.id)}>
    <span className="traffic-request-line"><span className="traffic-method">{entry.method}</span>
      {entry.method === 'CONNECT' && <Icon name="shield" size={13}/>}<span className="traffic-path">{entry.method === 'CONNECT' ? t('networkInspector.tunnel') : label}</span></span>
    <small>{!treeMode && <>{trafficAddress(entry).host}<span> · </span></>}<time dateTime={new Date(entry.startedAt * 1000).toISOString()}>{trafficStarted(entry.startedAt)}</time>
      {treeMode && <><span> · </span>{trafficTime(entry.durationMs ?? entry.elapsedMs)}<span> · </span>{trafficSize(entry.bytes)}</>}
      {!treeMode && <span className="traffic-compact-size"><span> · </span>{trafficSize(entry.bytes)}</span>}</small>
  </button>;
  const node = (item: TrafficNode, root = false) => <details className="traffic-tree-node" key={item.key} data-node-key={item.key} open={searching || (branches.get(item.key) ?? root)}
    onToggle={event => {
      if (searching) return;
      const open = event.currentTarget.open;
      setBranches(previous => {
        if (open === (previous.get(item.key) ?? root)) return previous;
        const next = new Map(previous);
        if (open === root) next.delete(item.key); else next.set(item.key, open);
        return next;
      });
    }}>
    <summary title={item.label}><Icon name={root ? 'server' : 'layers'} size={14}/><span>{item.label}</span><small>{item.count}</small></summary>
    <div className="traffic-tree-children">{item.children.map(child => node(child))}
      {item.entries.map(({ entry, label }) => <div key={entry.id} className="traffic-tree-leaf" data-selected={entry.id === selectedId} data-phase={trafficPhase(entry)}>
        {request(entry, label, true)}<TrafficStatus entry={entry}/></div>)}
    </div>
  </details>;
  const column = (key: typeof sort.key, label: string) => <th aria-sort={sort.key === key ? sort.descending ? 'descending' : 'ascending' : 'none'}>
    <button type="button" aria-label={t('networkInspector.sortBy', { p0: key === 'startedAt' ? t('networkInspector.started') : label })}
      title={t('networkInspector.sortBy', { p0: key === 'startedAt' ? t('networkInspector.started') : label })}
      onClick={() => setSort({ key, descending: sort.key === key ? !sort.descending : false })}>
      {label}{sort.key === key && <Icon name={sort.descending ? 'arrowDown' : 'arrowUp'} size={12}/>}</button></th>;
  return <div className="traffic-list" tabIndex={0} role="region" aria-label={t('networkInspector.requestList')}>
    {!entries.length ? empty : mode === 'structure' ? <div className="traffic-tree" onKeyDownCapture={navigateTree}>{tree.map(item => node(item, true))}</div> : <table className="traffic-sequence">
      <thead><tr>{column('startedAt', t('networkInspector.requestAndTime'))}{column('status', t('networkInspector.status'))}
        {column('durationMs', t('networkInspector.durationColumn'))}{column('bytes', t('networkInspector.sizeColumn'))}</tr></thead>
      <tbody>{sorted.map(entry => <tr key={entry.id} data-selected={entry.id === selectedId} data-phase={trafficPhase(entry)}>
        <td>{request(entry, trafficAddress(entry).pathname)}</td><td><TrafficStatus entry={entry}/></td>
        <td>{trafficTime(entry.durationMs ?? entry.elapsedMs)}</td><td>{trafficSize(entry.bytes)}</td></tr>)}</tbody>
    </table>}
  </div>;
}
