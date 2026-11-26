import { Fragment, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { FloatingWindowMove, FloatingWindowResizeHandles } from './FloatingWorkspaceControls';
import { getDirection, t } from './i18n';
import { Icon } from './icons';
import type { DeskLayoutTemplate } from './deskLayoutTemplate';
import { constrainWidgetBounds, type useFloatingSessionWorkspace, type WidgetBounds } from './useFloatingSessionWorkspace';

type Placements<T extends string> = Partial<Record<T, WidgetBounds>>;

export const DESK_TOOL_DRAG_TYPE = 'application/x-rdf-desk-tool';

export function useDeskWidgetLayout<T extends string>(userId: string, layoutId: string | undefined, toolIds: readonly T[], template?: DeskLayoutTemplate | null) {
  const scope = layoutId && `rdf-session-desk-widget-v1:${encodeURIComponent(userId)}:${encodeURIComponent(layoutId)}`;
  const [layout, setLayout] = useState<{ scope?: string; placements: Placements<T> }>({ placements: {} });

  useLayoutEffect(() => {
    const placements: Placements<T> = {};
    if (scope) {
      for (const id of toolIds) {
        if (template?.widgets[id]) placements[id] = constrainWidgetBounds(template.widgets[id]);
        try {
          const storage = template ? window.sessionStorage : window.localStorage;
          const stored = storage.getItem(`${scope}:${id}`);
          if (!stored) continue;
          const bounds = JSON.parse(stored) as WidgetBounds | null;
          if (bounds && [bounds.left, bounds.top, bounds.width, bounds.height].every(Number.isFinite)) placements[id] = bounds;
          else if (bounds === null) delete placements[id];
        } catch { /* A corrupt or unavailable entry does not prevent opening the tools. */ }
      }
    }
    setLayout({ scope, placements });
  }, [scope, toolIds, template]);

  const saveBounds = (id: T, bounds?: WidgetBounds) => {
    if (!scope) return;
    try {
      const storage = template ? window.sessionStorage : window.localStorage;
      if (bounds || template) storage.setItem(`${scope}:${id}`, JSON.stringify(bounds ?? null));
      else storage.removeItem(`${scope}:${id}`);
    } catch { /* Keep the current layout usable when storage is unavailable. */ }
  };

  const setPlacement = (id: T, bounds?: WidgetBounds) => {
    setLayout(current => ({ scope, placements: { ...(current.scope === scope ? current.placements : {}), [id]: bounds } }));
    saveBounds(id, bounds);
  };

  const placements: Placements<T> = layout.scope === scope ? layout.placements : {};
  return { placements, setPlacement, saveBounds };
}

export function deskWidgetPlacement(viewport: HTMLElement, canvas: HTMLElement, clientX?: number, clientY?: number): WidgetBounds {
  const outer = viewport.getBoundingClientRect();
  const scene = canvas.getBoundingClientRect();
  const scaleX = scene.width / canvas.offsetWidth || 1;
  const scaleY = scene.height / canvas.offsetHeight || 1;
  const left = (outer.left - scene.left) / scaleX;
  const top = (outer.top - scene.top) / scaleY;
  const visibleWidth = outer.width / scaleX;
  const visibleHeight = outer.height / scaleY;
  const margin = 12;
  const width = Math.max(400, Math.min(680, visibleWidth - 2 * margin));
  const height = Math.max(360, Math.min(480, visibleHeight - 2 * margin));
  const x = clientX === undefined ? left + (visibleWidth - width) / 2 : (clientX - scene.left) / scaleX - 32;
  const y = clientY === undefined ? top + (visibleHeight - height) / 2 : (clientY - scene.top) / scaleY - 20;
  return constrainWidgetBounds({
    left: x,
    top: y,
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
