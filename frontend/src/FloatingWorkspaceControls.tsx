import { useId, useRef, useState, type FormEvent, type RefObject } from 'react';
import { Icon } from './icons';
import { t } from './i18n';
import { floatingWindowLimits, type FloatingWindowName, type useFloatingSessionWorkspace } from './useFloatingSessionWorkspace';

type FloatingWorkspace = ReturnType<typeof useFloatingSessionWorkspace>;

export function FloatingWorkspaceToolbar({ workspace, onDevice, onTools, onCommand }: {
  workspace: FloatingWorkspace;
  onDevice: () => void;
  onTools: () => void;
  onCommand?: () => void;
}) {
  const [panning, setPanning] = useState(false);
  const pan = (enabled: boolean) => {
    setPanning(enabled);
    workspace.setPan(enabled);
  };
  const navigate = (action: () => void) => {
    pan(false);
    action();
  };

  return <div className="floating-workspace-toolbar" role="group" aria-label={t('session.workspace.canvas')}>
    <div className="floating-workspace-actions">
      <button type="button" className="button ghost" onClick={() => navigate(onDevice)}>{t('session.workspace.goDevice')}</button>
      <button type="button" className="button ghost" onClick={() => navigate(onTools)}>{t('session.workspace.goTools')}</button>
      {onCommand && <button type="button" className="button ghost" onClick={() => navigate(onCommand)}>{t('session.workspace.goCommand')}</button>}
    </div>
    <div className="floating-workspace-actions">
      <button type="button" className="button ghost" aria-pressed={panning} onClick={() => pan(!panning)}>{t('session.workspace.pan')}</button>
      <button type="button" className="button ghost" onClick={() => navigate(workspace.reset)}>{t('session.workspace.resetFloating')}</button>
    </div>
  </div>;
}

const corners = ['nw', 'ne', 'sw', 'se'] as const;

export function FloatingWindowControls({ name, workspace, viewportRef }: {
  name: FloatingWindowName;
  workspace: FloatingWorkspace;
  viewportRef: RefObject<HTMLDivElement | null>;
}) {
  const dialogId = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const widthRef = useRef<HTMLInputElement>(null);
  const heightRef = useRef<HTMLInputElement>(null);
  const title = t(name === 'device' ? 'session.workspace.deviceWindow' : 'session.workspace.toolWindow');
  const dimensions = t('session.workspace.windowDimensions', { name: title });
  const limits = floatingWindowLimits[name];
  const setFields = (width: number, height: number) => {
    if (widthRef.current) widthRef.current.value = String(Math.max(limits.minWidth, Math.min(limits.maxWidth, Math.round(width))));
    if (heightRef.current) heightRef.current.value = String(Math.max(limits.minHeight, Math.min(limits.maxHeight, Math.round(height))));
  };
  const open = () => {
    const size = workspace.getSize(name);
    if (!size) return;
    setFields(size.width, size.height);
    dialogRef.current?.showModal();
    widthRef.current?.select();
  };
  const setPreset = (multiplier: number) => {
    const viewport = viewportRef.current;
    if (viewport) setFields((viewport.clientWidth - 30) * multiplier, (viewport.clientHeight - 30) * multiplier);
  };
  const apply = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const width = widthRef.current?.valueAsNumber;
    const height = heightRef.current?.valueAsNumber;
    if (width === undefined || height === undefined || !Number.isFinite(width) || !Number.isFinite(height)) return;
    workspace.resize(name, width, height);
    dialogRef.current?.close();
    workspace.jump(name);
  };

  return <>
    <div className="floating-window-bar">
      <button type="button" className="floating-window-move" data-window-move={name} title={t('session.workspace.moveWindow')}>
        <Icon name={name === 'device' ? 'monitor' : 'terminal'} size={16} />{title}
      </button>
      <button type="button" className="floating-window-size" data-size-window={name} aria-label={dimensions} onClick={open}>{t('session.workspace.windowSize')}</button>
      <span className="floating-window-move-fill" data-window-move={name} aria-hidden="true" />
    </div>
    {corners.map(corner => <button key={corner} type="button" className="floating-window-corner" tabIndex={corner === 'se' ? 0 : -1}
      data-window-resize={name} data-direction={corner} aria-label={t('session.workspace.resizeWindow')} title={t('session.workspace.resizeWindow')} />)}
    <dialog ref={dialogRef} className="floating-size-dialog" aria-labelledby={dialogId}>
      <form onSubmit={apply}>
        <header><h2 id={dialogId}>{dimensions}</h2><button type="button" className="button ghost" onClick={() => dialogRef.current?.close()}>{t('ui.a7a4033657e8')}</button></header>
        <div className="floating-size-fields">
          <label>{t('session.workspace.windowWidth')}<input ref={widthRef} type="number" min={limits.minWidth} max={limits.maxWidth} required /></label>
          <label>{t('session.workspace.windowHeight')}<input ref={heightRef} type="number" min={limits.minHeight} max={limits.maxHeight} required /></label>
        </div>
        <div className="floating-size-presets">
          <button type="button" className="button ghost" onClick={() => setPreset(1)}>{t('session.workspace.fitWindow')}</button>
          {name === 'tools' && <button type="button" className="button ghost" onClick={() => setPreset(1.5)}>{t('session.workspace.biggerWindow')}</button>}
        </div>
        <footer><button type="submit" className="button primary">{t('ui.e15f960d93eb')}</button></footer>
      </form>
    </dialog>
  </>;
}
