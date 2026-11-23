import { Fragment, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { FloatingWindowMove, FloatingWindowResizeHandles } from './FloatingWorkspaceControls';
import { getDirection, t } from './i18n';
import { Icon } from './icons';
import { constrainWidgetBounds, type useFloatingSessionWorkspace, type WidgetBounds } from './useFloatingSessionWorkspace';

type Placements<T extends string> = Partial<Record<T, WidgetBounds>>;

export const DESK_TOOL_DRAG_TYPE = 'application/x-rdf-desk-tool';

export function useDeskWidgetLayout<T extends string>(userId: string, layoutId: string | undefined, toolIds: readonly T[]) {
  const scope = layoutId && `rdf-session-desk-widget-v1:${encodeURIComponent(userId)}:${encodeURIComponent(layoutId)}`;
  const [layout, setLayout] = useState<{ scope?: string; placements: Placements<T> }>({ placements: {} });

  useLayoutEffect(() => {
    const placements: Placements<T> = {};
    if (scope) {
      for (const id of toolIds) {
        try {
          const stored = window.localStorage.getItem(`${scope}:${id}`);
          if (!stored) continue;
          const bounds = JSON.parse(stored) as WidgetBounds | null;
          if (bounds && [bounds.left, bounds.top, bounds.width, bounds.height].every(Number.isFinite)) placements[id] = bounds;
        } catch { /* A corrupt or unavailable entry does not prevent opening the tools. */ }
      }
    }
    setLayout({ scope, placements });
  }, [scope, toolIds]);

  const saveBounds = (id: T, bounds?: WidgetBounds) => {
    if (!scope) return;
    try {
      if (bounds) window.localStorage.setItem(`${scope}:${id}`, JSON.stringify(bounds));
      else window.localStorage.removeItem(`${scope}:${id}`);
    } catch { /* Keep the current layout usable when storage is unavailable. */ }
  };

  const setPlacement = (id: T, bounds?: WidgetBounds) => {
    setLayout(current => ({ scope, placements: { ...(current.scope === scope ? current.placements : {}), [id]: bounds } }));
    saveBounds(id, bounds);
  };

  const placements: Placements<T> = layout.scope === scope ? layout.placements : {};
  return { placements, setPlacement, saveBounds };
}

export function deskWidgetPlacement(viewport: HTMLElement, clientX?: number, clientY?: number): WidgetBounds {
  const rect = viewport.getBoundingClientRect();
  const scale = rect.width / Math.max(1, viewport.offsetWidth) || 1;
  const margin = 12;
  const width = Math.max(400, Math.min(680, viewport.clientWidth - 2 * margin));
  const height = Math.max(360, Math.min(480, viewport.clientHeight - 2 * margin));
  const x = clientX === undefined ? (viewport.clientWidth - width) / 2 : (clientX - rect.left) / scale - viewport.clientLeft - 32;
  const y = clientY === undefined ? (viewport.clientHeight - height) / 2 : (clientY - rect.top) / scale - viewport.clientTop - 20;
  return constrainWidgetBounds({
    left: viewport.scrollLeft + Math.max(margin, Math.min(x, viewport.clientWidth - width - margin)),
    top: viewport.scrollTop + Math.max(margin, Math.min(y, viewport.clientHeight - height - margin)),
    width, height,
  });
}

export function DeskToolWidget({ id, label, placement, active, preview, dock, canvas, registerWidget, onDock, onBoundsChange, children }: {
  id: string;
  label: string;
  placement?: WidgetBounds;
  active: boolean;
  preview?: RefObject<HTMLDivElement | null>;
  dock: RefObject<HTMLElement | null>;
  canvas: RefObject<HTMLDivElement | null>;
  registerWidget: ReturnType<typeof useFloatingSessionWorkspace>['registerWidget'];
  onDock: () => void;
  onBoundsChange: (bounds: WidgetBounds) => void;
  children: ReactNode;
}) {
  // Moving the portal host preserves the mounted tool, its filters and its scroll state.
  const [host] = useState(() => document.createElement('section'));
  const name = `widget:${id}` as const;
  const labelId = `tool-tab-${id}`;
  const direction = getDirection();
  const handlers = useRef({ onBoundsChange, onDock });
  const geometry = useRef<{ placement: WidgetBounds; bounds: WidgetBounds } | null>(null);
  useLayoutEffect(() => { handlers.current = { onBoundsChange, onDock }; }, [onBoundsChange, onDock]);
  useLayoutEffect(() => { host.hidden = !active; }, [active, host]);

  useLayoutEffect(() => {
    const parent = placement ? canvas.current : preview ? preview.current : dock.current;
    if (!parent) return;
    host.className = placement || preview ? 'tool-panel terminal-panel desk-widget' : 'desk-tool-host';
    parent.append(host);
    if (preview) {
      host.dataset.widgetPreview = id;
      host.dir = direction;
      return () => {
        host.remove();
        delete host.dataset.widgetPreview;
        host.removeAttribute('dir');
      };
    }
    if (!placement) return () => host.remove();

    host.dataset.window = name;
    host.dir = direction;
    host.setAttribute('aria-labelledby', labelId);
    const bounds = geometry.current?.placement === placement ? geometry.current.bounds : placement;
    const unregister = registerWidget(name, host, bounds, {
      onChange: next => {
        geometry.current = { placement, bounds: next };
        handlers.current.onBoundsChange(next);
      },
      onDock: () => handlers.current.onDock(),
    });
    return () => {
      unregister();
      host.remove();
      delete host.dataset.window;
      host.removeAttribute('dir');
      host.removeAttribute('aria-labelledby');
    };
  }, [canvas, direction, dock, host, id, labelId, name, placement, preview, registerWidget]);

  return createPortal(<>
    {(placement || preview) && <div className="desk-widget-header" data-window-move={placement ? name : undefined}>
      <FloatingWindowMove name={name} />
      <span className="desk-widget-title" id={placement ? labelId : undefined}>{label}</span>
      <button type="button" className="desk-widget-dock" title={t('session.workspace.dockTool')}
        aria-label={t('session.workspace.dockTool')} onClick={onDock}><Icon name="layers" size={16} /></button>
    </div>}
    <Fragment key="body">{children}</Fragment>
    {placement && <FloatingWindowResizeHandles name={name} />}
  </>, host);
}
