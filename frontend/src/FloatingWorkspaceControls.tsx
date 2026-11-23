import { Icon } from './icons';
import { t } from './i18n';
import type { WorkspaceWindowName } from './useFloatingSessionWorkspace';

export function WorkspaceDefaultButton({ selected, disabled, onSelect, className, size = 16 }: {
  selected: boolean;
  disabled?: boolean;
  onSelect: () => void;
  className: string;
  size?: number;
}) {
  return <button type="button" className={className} aria-label={t('session.workspace.defaultView')} aria-pressed={selected} disabled={disabled}
    title={t(selected ? 'session.workspace.clearDefault' : 'session.workspace.setDefault')} onClick={onSelect}><Icon name="star" size={size} /></button>;
}

export function FloatingWindowMove({ name, className }: { name: WorkspaceWindowName; className?: string }) {
  const label = t('session.workspace.moveWindow');
  return <button type="button" className={['floating-window-move', className].filter(Boolean).join(' ')}
    data-window-move={name} aria-label={label} title={label}>
    <Icon name="grip" size={18} />
  </button>;
}

const edges = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'] as const;

export function FloatingWindowResizeHandles({ name }: { name: WorkspaceWindowName }) {
  const label = t('session.workspace.resizeWindow');
  return <>{edges.map(direction => <button key={direction} type="button" className="floating-window-resize-handle"
    tabIndex={direction === 'se' ? 0 : -1} data-window-resize={name} data-direction={direction} aria-label={label} />)}</>;
}
