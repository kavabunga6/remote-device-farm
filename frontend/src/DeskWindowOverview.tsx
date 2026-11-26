import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { Icon } from './icons';
import { getLocale, t } from './i18n';
import { DESK_MAX_ZOOM, DESK_MIN_ZOOM, type useFloatingSessionWorkspace, type WorkspaceWindowName } from './useFloatingSessionWorkspace';
import './DeskWindowOverview.css';

export type DeskOverviewWindow = {
  name: WorkspaceWindowName;
  label: string;
  returnToTabs?: () => void;
};

const SHORTCUT = 'Alt+Shift+W';
const EXIT_KEYCAP = 'Esc';

export function DeskWindowOverview({ open, windows, onOpenChange, onSelect, onExitDesk, onSaveLayout, onResetLayout, workspace, zoom, onZoom }: {
  open: boolean;
  windows: readonly DeskOverviewWindow[];
  onOpenChange: (open: boolean) => void;
  onSelect: (name: WorkspaceWindowName) => void;
  onExitDesk: () => void;
  onSaveLayout?: () => boolean;
  onResetLayout: () => void;
  workspace: Pick<ReturnType<typeof useFloatingSessionWorkspace>, 'previewWindows' | 'clearWindowPreviews'>;
  zoom: number;
  onZoom: (action: -1 | 0 | 1) => void;
}) {
  const id = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const gridRef = useRef<HTMLOListElement>(null);
  const focusAfterDock = useRef<number | null>(null);
  const { previewWindows, clearWindowPreviews } = workspace;
  const title = t('session.workspace.overview');
  const exitLabel = t('session.workspace.leaveDesk');
  const zoomLabel = new Intl.NumberFormat(getLocale(), { style: 'percent' }).format(zoom);
  const zoomOutLabel = t('session.workspace.zoomOut');
  const zoomInLabel = t('session.workspace.zoomIn');
  const resetViewLabel = t('session.workspace.resetDeskView', { scale: zoomLabel });
  const resetLayoutLabel = t('session.workspace.resetFloating');
  const saveLayoutLabel = t('session.workspace.saveLayoutForEmulators');
  const [saveResult, setSaveResult] = useState<{ saved: boolean }>();

  useEffect(() => {
    if (!saveResult) return;
    const timer = window.setTimeout(() => setSaveResult(undefined), 4500);
    return () => window.clearTimeout(timer);
  }, [saveResult]);

  function fitPreviews(grid: HTMLOListElement) {
    // Project the existing windows into the dialog slots without remounting their content.
    const targets = new Map<WorkspaceWindowName, DOMRectReadOnly>();
    for (const slot of grid.querySelectorAll<HTMLElement>('[data-overview-slot]')) {
      targets.set(slot.dataset.overviewSlot as WorkspaceWindowName, slot.getBoundingClientRect());
    }
    previewWindows(targets);
  }

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    const grid = gridRef.current;
    if (!open || !dialog || !grid) return;

    dialog.showModal();
    grid.querySelector<HTMLButtonElement>('button[data-overview-window]')?.focus({ preventScroll: true });
    const refresh = () => fitPreviews(grid);
    const observer = new ResizeObserver(refresh);
    observer.observe(grid);
    observer.observe(dialog);
    dialog.addEventListener('scroll', refresh, { passive: true, capture: true });

    return () => {
      observer.disconnect();
      dialog.removeEventListener('scroll', refresh, true);
      clearWindowPreviews();
      if (dialog.open) dialog.close();
    };
  }, [open, previewWindows, clearWindowPreviews]);

  useLayoutEffect(() => {
    const grid = gridRef.current;
    if (!open || !grid) return;
    fitPreviews(grid);
    const pending = focusAfterDock.current;
    if (pending === null) return;
    focusAfterDock.current = null;
    const buttons = grid.querySelectorAll<HTMLButtonElement>('button[data-overview-window]');
    buttons.item(Math.min(pending, buttons.length - 1))?.focus({ preventScroll: true });
  });

  function close(selection?: WorkspaceWindowName) {
    clearWindowPreviews();
    dialogRef.current?.close();
    onOpenChange(false);
    if (selection) onSelect(selection);
  }

  return <>
    <div className="desk-command-bar" role="group" aria-label={t('session.workspace.desk')}>
      <span className="desk-exit-hint" id="desk-exit-hint">{t('session.workspace.deskExitHint')}</span>
      <button type="button" className="desk-overview-trigger" aria-label={title} aria-haspopup="dialog" aria-expanded={open}
        aria-controls={id} aria-keyshortcuts={SHORTCUT} title={`${title} (${SHORTCUT})`} onClick={() => onOpenChange(true)}>
        <Icon name="grid" size={16} /><span className="desk-overview-trigger-label">{title}</span>
      </button>
      <div className="desk-zoom">
        <button type="button" className="desk-zoom-out" aria-label={zoomOutLabel} title={zoomOutLabel}
          disabled={zoom <= DESK_MIN_ZOOM} onClick={() => onZoom(-1)}><Icon name="minus" size={16} /></button>
        <button type="button" className="desk-zoom-reset" aria-label={resetViewLabel} title={resetViewLabel}
          onClick={() => onZoom(0)}><bdi>{zoomLabel}</bdi></button>
        <button type="button" className="desk-zoom-in" aria-label={zoomInLabel} title={zoomInLabel}
          disabled={zoom >= DESK_MAX_ZOOM} onClick={() => onZoom(1)}><Icon name="plus" size={16} /></button>
      </div>
      <button type="button" className="desk-command-reset-layout" aria-label={resetLayoutLabel} title={resetLayoutLabel}
        onClick={onResetLayout}><Icon name="rotate" size={16} /></button>
      {onSaveLayout && <>
        <button type="button" className="desk-command-save" aria-label={saveLayoutLabel} title={saveLayoutLabel}
          onClick={() => setSaveResult({ saved: onSaveLayout() })}>
          <Icon name="save" size={16} /><span className="desk-command-save-label">{t('session.workspace.saveLayout')}</span>
        </button>
        <span className="desk-save-status" role="status" data-error={saveResult?.saved === false || undefined}>
          {saveResult && t(saveResult.saved ? 'session.workspace.layoutSaved' : 'session.workspace.layoutSaveFailed')}
        </span>
      </>}
      <button type="button" className="desk-command-exit" aria-label={exitLabel} aria-keyshortcuts="Escape" title={exitLabel} onClick={onExitDesk}>
        <Icon name="collapse" size={16} /><span className="desk-command-exit-label">{t('session.workspace.exitDeskShort')}</span>
        <kbd dir="ltr" aria-hidden="true">{EXIT_KEYCAP}</kbd>
      </button>
    </div>
    <dialog ref={dialogRef} className="desk-window-overview" id={id} aria-labelledby={`${id}-heading`}
      onCancel={event => { event.preventDefault(); close(); }}
      onClick={event => { if (event.target === event.currentTarget) close(); }}>
      <header className="desk-overview-heading">
        <h2 id={`${id}-heading`}>{title}</h2>
        <kbd className="desk-overview-shortcut" dir="ltr">{SHORTCUT}</kbd>
        <button type="button" className="desk-overview-close" aria-label={t('ui.a7a4033657e8')} onClick={() => close()}>
          <Icon name="close" size={20} />
        </button>
      </header>
      <ol ref={gridRef} className="desk-overview-grid">
        {windows.map(({ name, label, returnToTabs }, index) => <li className="desk-overview-tile" key={name}>
          <button type="button" className="desk-overview-window" data-overview-window={name} onClick={() => close(name)}>
            <span className="desk-overview-thumbnail" data-overview-slot={name} aria-hidden="true" />
            <span className="desk-overview-title">{label}</span>
          </button>
          {returnToTabs && <button type="button" className="desk-overview-dock" data-overview-dock={name}
            aria-label={t('session.workspace.overviewDock', { name: label })} title={t('session.workspace.dockTool')}
            onClick={() => { focusAfterDock.current = index; returnToTabs(); }}>
            <Icon name="close" size={16} />
          </button>}
        </li>)}
      </ol>
    </dialog>
  </>;
}
