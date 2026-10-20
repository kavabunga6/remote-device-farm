import { useMemo, useState, type KeyboardEvent } from 'react';
import { t } from '../i18n';
import { Icon } from '../icons';
import type { TrafficEntry } from './debug-api';
import { trafficAddress, trafficPhase, trafficTree, type TrafficNode } from './traffic-entries';
import { TrafficStatus, trafficSize, trafficTime, trafficStarted } from './TrafficDetails';

export function TrafficList({ entries, mode, selectedId, onSelect, searching }: {
  entries: TrafficEntry[]; mode: 'sequence' | 'structure'; selectedId: number | null; onSelect: (id: number) => void; searching: boolean;
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
  const navigate = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const buttons = Array.from(event.currentTarget.closest('.traffic-list')!.querySelectorAll<HTMLButtonElement>('.traffic-request'));
    const visible = buttons.filter(button => button.getClientRects().length > 0);
    const position = visible.indexOf(event.currentTarget);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? visible.length - 1 : position + (event.key === 'ArrowDown' ? 1 : -1);
    if (!visible[next]) return;
    event.preventDefault(); visible[next]!.focus(); visible[next]!.click(); visible[next]!.scrollIntoView({ block: 'nearest' });
  };
  const request = (entry: TrafficEntry, label: string, treeMode = false) => <button type="button" className="traffic-request"
    data-entry-id={entry.id} aria-pressed={entry.id === selectedId} title={entry.url} onKeyDown={navigate} onClick={() => onSelect(entry.id)}>
    <span className="traffic-request-line"><span className="traffic-method">{entry.method}</span>
      {entry.method === 'CONNECT' && <Icon name="shield" size={13}/>}<span className="traffic-path">{entry.method === 'CONNECT' ? t('networkInspector.tunnel') : label}</span></span>
    <small>{!treeMode && <>{trafficAddress(entry).host}<span> · </span></>}<time dateTime={new Date(entry.startedAt * 1000).toISOString()}>{trafficStarted(entry.startedAt)}</time>
      {treeMode && <><span> · </span>{trafficTime(entry.durationMs ?? entry.elapsedMs)}<span> · </span>{trafficSize(entry.bytes)}</>}
      {!treeMode && <span className="traffic-compact-size"><span> · </span>{trafficSize(entry.bytes)}</span>}</small>
  </button>;
  const node = (item: TrafficNode, root = false) => <details className="traffic-tree-node" key={item.key + searching} open={root || searching}>
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
    {mode === 'structure' ? <div className="traffic-tree">{tree.map(item => node(item, true))}</div> : <table className="traffic-sequence">
      <thead><tr>{column('startedAt', t('networkInspector.requestAndTime'))}{column('status', t('networkInspector.status'))}
        {column('durationMs', t('networkInspector.durationColumn'))}{column('bytes', t('networkInspector.sizeColumn'))}</tr></thead>
      <tbody>{sorted.map(entry => <tr key={entry.id} data-selected={entry.id === selectedId} data-phase={trafficPhase(entry)}>
        <td>{request(entry, trafficAddress(entry).path)}</td><td><TrafficStatus entry={entry}/></td>
        <td>{trafficTime(entry.durationMs ?? entry.elapsedMs)}</td><td>{trafficSize(entry.bytes)}</td></tr>)}</tbody>
    </table>}
  </div>;
}
