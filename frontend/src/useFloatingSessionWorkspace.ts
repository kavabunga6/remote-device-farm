import { useLayoutEffect, useMemo, useRef, type RefObject } from 'react';
import { snapFloatingWindow, type AlignmentGuide } from './floatingWindowSnap';

export type FloatingWindowName = 'device' | 'tools';
type WidgetName = `widget:${string}`;
export type WorkspaceWindowName = FloatingWindowName | WidgetName;

const MAX_WINDOW_SIZE = 16_000;
const floatingWindowLimits = {
  device: { minWidth: 240, minHeight: 260, maxWidth: MAX_WINDOW_SIZE, maxHeight: MAX_WINDOW_SIZE },
  tools: { minWidth: 400, minHeight: 360, maxWidth: MAX_WINDOW_SIZE, maxHeight: MAX_WINDOW_SIZE },
} as const;

type Size = { width: number; height: number };
type Position = { left: number; top: number };
type Bounds = Size & Position;
export type WidgetBounds = Bounds;
type WidgetOptions = {
  onChange?: (bounds: WidgetBounds) => void;
  onDock?: () => void;
};
type WidgetRegistration = WidgetOptions & { element: HTMLElement; bounds: WidgetBounds };
type Direction = 'n' | 'e' | 's' | 'w' | 'nw' | 'ne' | 'sw' | 'se';
type Panels = Record<FloatingWindowName, HTMLElement>;
type Arrangement = { windows: Record<FloatingWindowName, Bounds>; front: FloatingWindowName };
type SavedArrangement = Arrangement & { updatedAt: number };
type Handle = { element: HTMLElement; name: WorkspaceWindowName } & (
  { kind: 'move' } | { kind: 'resize'; direction: Direction }
);
type Gesture = {
  id: number;
  startClient: Position;
  client: Position;
  startScroll: Position;
  scale: Size;
  moved: boolean;
} & ({ kind: 'pan' } | (Handle & { startBounds: Bounds }));

type WorkspaceOptions = {
  active: boolean;
  userId: string;
  layoutId?: string;
  legacyDeviceId?: string;
  aspect?: number;
  viewportRef: RefObject<HTMLDivElement | null>;
  canvasRef: RefObject<HTMLDivElement | null>;
  deviceRef: RefObject<HTMLElement | null>;
  toolsRef: RefObject<HTMLElement | null>;
};

const DEFAULT_ASPECT = 9 / 19.5;
const MARGIN = 12;
const WIDGET_DRAG_THRESHOLD = 4;
const WINDOW_SNAP_DISTANCE = 16;
const SCROLL_EDGE = 40;
const SCROLL_SPEED = 18;
const OVERLAY = 'dialog[open],[popover]';
const RESIZE_DIRECTIONS: readonly string[] = ['n', 'e', 's', 'w', 'nw', 'ne', 'sw', 'se'];
const ARROWS: Record<string, Position> = {
  ArrowLeft: { left: -1, top: 0 }, ArrowRight: { left: 1, top: 0 },
  ArrowUp: { left: 0, top: -1 }, ArrowDown: { left: 0, top: 1 },
};

function windowName(value: string | undefined): value is FloatingWindowName {
  return value === 'device' || value === 'tools';
}

function workspaceWindowName(value: string | undefined): value is WorkspaceWindowName {
  return windowName(value) || Boolean(value?.startsWith('widget:') && value.length > 'widget:'.length);
}

function resizeDirection(value: string | undefined): value is Direction {
  return value !== undefined && RESIZE_DIRECTIONS.includes(value);
}

function clamp(value: number, min: number, max: number) {
  return Math.round(Math.max(min, Math.min(max, value)));
}

function constrain(name: WorkspaceWindowName, bounds: Bounds): Bounds {
  const limits = floatingWindowLimits[windowName(name) ? name : 'tools'];
  return {
    left: clamp(Number.isFinite(bounds.left) ? bounds.left : MARGIN, MARGIN, MAX_WINDOW_SIZE),
    top: clamp(Number.isFinite(bounds.top) ? bounds.top : MARGIN, MARGIN, MAX_WINDOW_SIZE),
    width: clamp(Number.isFinite(bounds.width) ? bounds.width : limits.minWidth, limits.minWidth, limits.maxWidth),
    height: clamp(Number.isFinite(bounds.height) ? bounds.height : limits.minHeight, limits.minHeight, limits.maxHeight),
  };
}

export function constrainWidgetBounds(bounds: WidgetBounds): WidgetBounds {
  return constrain('tools', bounds);
}

function constrainedDelta(handle: Handle, delta: Position): Position {
  if (handle.kind === 'move') return delta;
  return {
    left: /[ew]/.test(handle.direction) ? delta.left : 0,
    top: /[ns]/.test(handle.direction) ? delta.top : 0,
  };
}

function adjust(handle: Handle, bounds: Bounds, { left: dx, top: dy }: Position): Bounds {
  if (handle.kind === 'move') {
    return constrain(handle.name, { ...bounds, left: bounds.left + dx, top: bounds.top + dy });
  }

  const limits = floatingWindowLimits[windowName(handle.name) ? handle.name : 'tools'];
  const west = handle.direction.endsWith('w');
  const north = handle.direction.startsWith('n');
  const right = bounds.left + bounds.width;
  const bottom = bounds.top + bounds.height;
  const left = west ? clamp(bounds.left + dx, Math.max(MARGIN, right - limits.maxWidth), Math.min(MAX_WINDOW_SIZE, right - limits.minWidth)) : bounds.left;
  const top = north ? clamp(bounds.top + dy, Math.max(MARGIN, bottom - limits.maxHeight), Math.min(MAX_WINDOW_SIZE, bottom - limits.minHeight)) : bounds.top;
  return constrain(handle.name, {
    left, top,
    width: west ? right - left : bounds.width + dx,
    height: north ? bottom - top : bounds.height + dy,
  });
}

function initialArrangement(viewport: HTMLElement, device: HTMLElement, aspect: number): Arrangement {
  const width = viewport.clientWidth || 1200;
  const height = viewport.clientHeight || 680;
  const style = getComputedStyle(device);
  const chromeWidth = Number.parseFloat(style.getPropertyValue('--free-device-chrome-x')) || 76;
  const chromeHeight = Number.parseFloat(style.getPropertyValue('--free-device-chrome-y')) || 26;
  const deviceHeight = Math.max(floatingWindowLimits.device.minHeight, height - 2 * MARGIN);
  const deviceWidth = Math.min((deviceHeight - chromeHeight) * aspect + chromeWidth, width - floatingWindowLimits.tools.minWidth - 3 * MARGIN);
  const deviceWindow = constrain('device', { left: MARGIN, top: MARGIN, width: deviceWidth, height: deviceHeight });
  const toolLeft = deviceWindow.left + deviceWindow.width + MARGIN;
  const toolsWindow = constrain('tools', { left: toolLeft, top: MARGIN, width: width - toolLeft - MARGIN, height: height - 2 * MARGIN });
  return { windows: { device: deviceWindow, tools: toolsWindow }, front: 'tools' };
}

function readArrangement(key: string): SavedArrangement | null | undefined {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return undefined;
    if (raw.length > 2048) return null;
    const saved = JSON.parse(raw) as Partial<SavedArrangement> | null;
    if (!saved?.windows || !windowName(saved.front)) return null;
    const { device, tools } = saved.windows;
    const valid = (bounds: Bounds | undefined) => bounds && [bounds.left, bounds.top, bounds.width, bounds.height].every(Number.isFinite);
    if (!valid(device) || !valid(tools)) return null;
    return {
      windows: { device: constrain('device', device), tools: constrain('tools', tools) },
      front: saved.front,
      updatedAt: typeof saved.updatedAt === 'number' && Number.isFinite(saved.updatedAt) ? saved.updatedAt : 0,
    };
  } catch { return null; }
}

function layoutStorage(userId: string, layoutId: string) {
  const account = encodeURIComponent(userId);
  const suffix = `${account}:${encodeURIComponent(layoutId)}`;
  const prefix = `rdf-session-floating-v3:${suffix}`;
  const resetKey = `${prefix}:reset`;
  const generation = () => {
    try {
      const stored = window.localStorage.getItem(resetKey);
      return stored && /^\d{1,10}(?:-\d{1,10}){3}$/.test(stored) ? stored : 'initial';
    }
    catch { return 'initial'; }
  };
  const recordKey = (version: string, name: FloatingWindowName | 'base') => `${prefix}:${version}:${name}`;
  const write = (version: string, name: FloatingWindowName | 'base', value: Arrangement) => {
    try {
      const storage = window.localStorage;
      const key = recordKey(version, name);
      // Another tab can reset during a drag, before this tab receives the storage event.
      if (generation() !== version) return;
      storage.setItem(key, JSON.stringify({ ...value, updatedAt: Date.now() }));
      if (generation() !== version) storage.removeItem(key);
    } catch { /* Storage can be unavailable. */ }
  };
  return {
    resetKey, generation, write,
    read(version: string): Arrangement | null | undefined {
      const device = readArrangement(recordKey(version, 'device'));
      const tools = readArrangement(recordKey(version, 'tools'));
      // Separate records let two tabs move different windows independently.
      if (device && tools) return {
        windows: { device: device.windows.device, tools: tools.windows.tools },
        front: device.updatedAt > tools.updatedAt ? device.front : tools.front,
      };
      return device ?? tools ?? readArrangement(recordKey(version, 'base'))
        ?? (version === 'initial' ? readArrangement(`rdf-session-floating-v2:${suffix}`) : null);
    },
    readLegacy(aspect: number) {
      return readArrangement(`rdf-session-floating-v1:${account}:${aspect.toFixed(4)}`);
    },
    reset() {
      const next = crypto.getRandomValues(new Uint32Array(4)).join('-');
      try {
        const storage = window.localStorage;
        storage.setItem(resetKey, next);
        for (const key of Object.keys(storage)) {
          if (key !== resetKey && key.startsWith(`${prefix}:`) && !key.startsWith(`${prefix}:${generation()}:`)) storage.removeItem(key);
        }
      } catch { /* Storage can be unavailable. */ }
      return next;
    },
  };
}

function retireSerialLayouts(userId: string, layoutId: string, deviceId: string | undefined) {
  try {
    const storage = window.localStorage;
    const prefix = `rdf-session-floating-v2:${encodeURIComponent(userId)}:device%3A`;
    if (deviceId) {
      const previous = readArrangement(prefix + encodeURIComponent(deviceId));
      const current = layoutStorage(userId, layoutId);
      const version = current.generation();
      if (previous !== undefined && current.read(version) === undefined) {
        if (previous) current.write(version, 'base', previous);
        else current.reset();
      }
    }
    for (const key of Object.keys(storage)) if (/^rdf-session-floating-v2:[^:]+:device%3A/.test(key)) storage.removeItem(key);
  } catch { /* Storage can be unavailable. */ }
}

function findHandle(target: Element): Handle | null {
  const edge = target.closest<HTMLElement>('[data-window-resize][data-direction]');
  if (edge && workspaceWindowName(edge.dataset.windowResize) && resizeDirection(edge.dataset.direction)) {
    return { element: edge, name: edge.dataset.windowResize, kind: 'resize', direction: edge.dataset.direction };
  }
  const grip = target.closest<HTMLElement>('[data-window-move]');
  if (!grip || !workspaceWindowName(grip.dataset.windowMove)) return null;
  const control = target.closest('a[href],button,input,select,summary,textarea,[contenteditable]');
  if (control && control !== grip && grip.contains(control)) return null;
  return { element: grip, name: grip.dataset.windowMove, kind: 'move' };
}

function edgeSpeed(offset: number, length: number) {
  if (offset <= SCROLL_EDGE) return -clamp((SCROLL_EDGE - offset) / SCROLL_EDGE * SCROLL_SPEED, 0, SCROLL_SPEED);
  if (offset >= length - SCROLL_EDGE) return clamp((offset - length + SCROLL_EDGE) / SCROLL_EDGE * SCROLL_SPEED, 0, SCROLL_SPEED);
  return 0;
}

function scaleFor(viewport: HTMLElement, rect: DOMRect): Size {
  return { width: rect.width / viewport.offsetWidth || 1, height: rect.height / viewport.offsetHeight || 1 };
}

function clearWindowStyles(panel: HTMLElement) {
  for (const property of ['left', 'top', 'width', 'height', 'z-index']) panel.style.removeProperty(property);
  panel.removeAttribute('data-front');
}

function clearPreview(panel: HTMLElement) {
  panel.style.removeProperty('--workspace-window-preview');
  panel.removeAttribute('data-window-preview');
}

function containsPoint(rect: DOMRect, { left, top }: Position) {
  return left >= rect.left && left < rect.right && top >= rect.top && top < rect.bottom;
}

function createWorkspace(viewport: HTMLDivElement, canvas: HTMLDivElement, panels: Panels, widgets: Map<WidgetName, WidgetRegistration>, initialAspect: number | undefined, userId: string, layoutId: string) {
  const listeners = new AbortController();
  const { signal } = listeners;
  const storage = layoutStorage(userId, layoutId);
  let generation = storage.generation();
  const saved = storage.read(generation);
  let aspect = initialAspect;
  let arrangement = saved ?? initialArrangement(viewport, panels.device, aspect ?? DEFAULT_ASPECT);
  let customized = Boolean(saved);
  let canMigrate = saved === undefined;
  let gesture: Gesture | null = null;
  let frame = 0;
  let preventClick = false;
  let dockTarget: HTMLElement | null = null;
  let layerOrder: WorkspaceWindowName[] = [...widgets.keys()];
  let previewTargets: ReadonlyMap<WorkspaceWindowName, DOMRectReadOnly> | null = null;
  let previewedPanels = new Set<HTMLElement>();
  const guideLines = new Map<AlignmentGuide['axis'], HTMLDivElement>();
  resetBaseLayerOrder();

  function getPanel(name: WorkspaceWindowName) {
    return windowName(name) ? panels[name] : widgets.get(name)?.element;
  }

  function getBounds(name: WorkspaceWindowName) {
    return windowName(name) ? arrangement.windows[name] : widgets.get(name)?.bounds;
  }

  function setBounds(name: WorkspaceWindowName, bounds: Bounds) {
    if (windowName(name)) arrangement.windows[name] = bounds;
    else {
      const widget = widgets.get(name);
      if (widget) widget.bounds = bounds;
    }
  }

  function visible(name: WorkspaceWindowName) {
    const panel = getPanel(name);
    return panel && !panel.hidden && getComputedStyle(panel).display !== 'none';
  }

  function ownerOf(target: Element): WorkspaceWindowName | undefined {
    const owner = target.closest<HTMLElement>('[data-window]');
    const name = owner?.dataset.window;
    return workspaceWindowName(name) && getPanel(name) === owner ? name : undefined;
  }

  function snapBounds(bounds: Bounds, scale: Size, handle?: Handle) {
    if (previewTargets) return { bounds, guides: [] };
    const neighbors: Bounds[] = [];
    for (const name of layerOrder) {
      if (name === handle?.name || !visible(name)) continue;
      const other = getBounds(name);
      if (other) neighbors.push(other);
    }
    const resize = handle?.kind === 'resize'
      ? { direction: handle.direction, ...floatingWindowLimits[windowName(handle.name) ? handle.name : 'tools'] }
      : undefined;
    return snapFloatingWindow(bounds, neighbors, {
      x: WINDOW_SNAP_DISTANCE / scale.width,
      y: WINDOW_SNAP_DISTANCE / scale.height,
    }, { min: MARGIN, max: MAX_WINDOW_SIZE }, resize);
  }

  function showAlignmentGuides(guides: readonly AlignmentGuide[] = []) {
    for (const [axis, line] of guideLines) {
      if (guides.some(guide => guide.axis === axis)) continue;
      line.remove();
      guideLines.delete(axis);
    }
    for (const { axis, position, start, end } of guides) {
      let line = guideLines.get(axis);
      if (!line) {
        line = document.createElement('div');
        line.dataset.windowAlignmentGuide = axis;
        line.setAttribute('aria-hidden', 'true');
        guideLines.set(axis, line);
        canvas.append(line);
      }
      const vertical = axis === 'x';
      line.style.left = `${vertical ? position : start}px`;
      line.style.top = `${vertical ? start : position}px`;
      line.style[vertical ? 'height' : 'width'] = `${end - start}px`;
    }
  }

  function paintPreviews() {
    if (!previewTargets) return;
    const canvasRect = canvas.getBoundingClientRect();
    const zoom = scaleFor(canvas, canvasRect);
    const originX = canvasRect.left + canvas.clientLeft * zoom.width;
    const originY = canvasRect.top + canvas.clientTop * zoom.height;
    const transforms = new Map<HTMLElement, string>();
    for (const [name, target] of previewTargets) {
      const panel = getPanel(name);
      const bounds = getBounds(name);
      if (!panel || !bounds || !visible(name) || target.width <= 0 || target.height <= 0) continue;
      const width = bounds.width * zoom.width;
      const height = bounds.height * zoom.height;
      const scale = Math.min(target.width / width, target.height / height);
      const x = (target.left - originX + (target.width - width * scale) / 2) / zoom.width - bounds.left;
      const y = (target.top - originY + (target.height - height * scale) / 2) / zoom.height - bounds.top;
      if (![x, y, scale].every(Number.isFinite)) continue;
      transforms.set(panel, `translate(${x}px, ${y}px) scale(${scale})`);
    }
    for (const panel of previewedPanels) if (!transforms.has(panel)) clearPreview(panel);
    for (const [panel, transform] of transforms) {
      panel.style.setProperty('--workspace-window-preview', transform);
      panel.setAttribute('data-window-preview', '');
    }
    previewedPanels = new Set(transforms.keys());
  }

  function clearWindowPreviews() {
    previewTargets = null;
    for (const panel of previewedPanels) clearPreview(panel);
    previewedPanels.clear();
  }

  function paint() {
    const shown = new Set(layerOrder.filter(visible));
    const front = [...shown].at(-1);
    let horizontal = 0;
    let vertical = 0;
    for (const [index, name] of layerOrder.entries()) {
      const panel = getPanel(name);
      const bounds = getBounds(name);
      if (!panel || !bounds) continue;
      const { left, top, width, height } = bounds;
      Object.assign(panel.style, { left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px`, zIndex: String(index + 1) });
      panel.toggleAttribute('data-front', name === front);
      if (shown.has(name)) {
        horizontal = Math.max(horizontal, left + width);
        vertical = Math.max(vertical, top + height);
      }
    }
    canvas.style.width = `${Math.max(viewport.clientWidth, horizontal + MARGIN)}px`;
    canvas.style.height = `${Math.max(viewport.clientHeight, vertical + MARGIN)}px`;
    paintPreviews();
  }

  function save(name: FloatingWindowName | 'base') {
    customized = true;
    canMigrate = false;
    storage.write(generation, name, arrangement);
  }

  function saveWindow(name: WorkspaceWindowName) {
    if (windowName(name)) {
      save(name);
    } else {
      const widget = widgets.get(name);
      if (widget) widget.onChange?.(widget.bounds);
    }
  }

  function setLayerFront(name: WorkspaceWindowName) {
    if (windowName(name)) arrangement.front = name;
    layerOrder = [...layerOrder.filter(layer => layer !== name), name];
  }

  function raise(name: WorkspaceWindowName) {
    if (layerOrder.at(-1) === name) return;
    setLayerFront(name);
    paint();
  }

  function resetBaseLayerOrder() {
    const front = arrangement.front;
    layerOrder = [front === 'device' ? 'tools' : 'device', front, ...layerOrder.filter(name => !windowName(name))];
  }

  function restartSizing() {
    if (gesture && (viewport.clientWidth === 0 || viewport.clientHeight === 0 || gesture.kind !== 'pan' && !visible(gesture.name))) finishGesture();
    if (!customized && !gesture) {
      const legacy = canMigrate && aspect !== undefined && storage.readLegacy(aspect);
      if (legacy) {
        arrangement = legacy;
        resetBaseLayerOrder();
        save('base');
      } else {
        arrangement.windows = initialArrangement(viewport, panels.device, aspect ?? DEFAULT_ASPECT).windows;
      }
    }
    paint();
  }

  function currentScroll(): Position {
    return { left: viewport.scrollLeft, top: viewport.scrollTop };
  }

  function scrollTo(point: Position) {
    viewport.scrollTo({ ...point, behavior: 'instant' });
  }

  function revealHandle(element: HTMLElement) {
    const outer = viewport.getBoundingClientRect();
    const inner = element.getBoundingClientRect();
    const scale = scaleFor(viewport, outer);
    const startX = outer.left + viewport.clientLeft * scale.width;
    const startY = outer.top + viewport.clientTop * scale.height;
    const left = inner.left < startX ? inner.left - startX : Math.max(0, inner.right - startX - viewport.clientWidth * scale.width);
    const top = inner.top < startY ? inner.top - startY : Math.max(0, inner.bottom - startY - viewport.clientHeight * scale.height);
    if (left || top) scrollTo({ left: viewport.scrollLeft + left / scale.width, top: viewport.scrollTop + top / scale.height });
  }

  function showDockTarget(target: HTMLElement | null) {
    if (target === dockTarget) return;
    dockTarget?.removeAttribute('data-dock-target');
    dockTarget = target;
    dockTarget?.setAttribute('data-dock-target', '');
  }

  function findDockTarget(name: WidgetName, point: Position) {
    if (!containsPoint(viewport.getBoundingClientRect(), point)) return null;
    const target = panels.tools.querySelector<HTMLElement>('[data-widget-dock]');
    if (!target || !containsPoint(target.getBoundingClientRect(), point)) return null;
    const moving = getPanel(name);
    const hit = document.elementsFromPoint(point.left, point.top).find(element => !moving?.contains(element));
    return hit && target.contains(hit) ? target : null;
  }

  function updateDockTarget(active: Gesture) {
    if (active.kind !== 'move' || windowName(active.name) || !active.moved) return;
    showDockTarget(findDockTarget(active.name, active.client));
  }

  function updateGesture(active: Gesture, scroll = currentScroll()) {
    const left = (active.client.left - active.startClient.left) / active.scale.width;
    const top = (active.client.top - active.startClient.top) / active.scale.height;
    if (active.kind === 'pan') {
      scrollTo({ left: active.startScroll.left - left, top: active.startScroll.top - top });
      return false;
    }
    const delta = constrainedDelta(active, { left: left + scroll.left - active.startScroll.left, top: top + scroll.top - active.startScroll.top });
    active.moved ||= active.kind === 'move' && !windowName(active.name)
      ? Math.hypot(left, top) >= WIDGET_DRAG_THRESHOLD
      : Math.abs(delta.left) + Math.abs(delta.top) >= 1;
    const previous = getBounds(active.name);
    if (!previous) return false;
    const proposed = adjust(active, active.startBounds, delta);
    const returningToTabs = active.kind === 'move' && !windowName(active.name) && active.moved && findDockTarget(active.name, active.client);
    const { bounds: next, guides } = active.moved && !returningToTabs ? snapBounds(proposed, active.scale, active) : { bounds: proposed, guides: [] };
    showAlignmentGuides(guides);
    if (previous.left === next.left && previous.top === next.top && previous.width === next.width && previous.height === next.height) return false;
    setBounds(active.name, next);
    paint();
    return true;
  }

  function autoScroll() {
    frame = 0;
    const active = gesture;
    if (!active || active.kind === 'pan') return;
    const rect = viewport.getBoundingClientRect();
    const offset = {
      left: (active.client.left - rect.left) / active.scale.width - viewport.clientLeft,
      top: (active.client.top - rect.top) / active.scale.height - viewport.clientTop,
    };
    const delta = constrainedDelta(active, {
      left: edgeSpeed(offset.left, viewport.clientWidth),
      top: edgeSpeed(offset.top, viewport.clientHeight),
    });
    if (!delta.left && !delta.top) return;
    const current = currentScroll();
    const point = {
      left: delta.left ? clamp(current.left + delta.left, 0, 2 * MAX_WINDOW_SIZE) : current.left,
      top: delta.top ? clamp(current.top + delta.top, 0, 2 * MAX_WINDOW_SIZE) : current.top,
    };
    if (point.left === current.left && point.top === current.top) return;
    // Extend the canvas only as far as the window edge can move, then let native scrolling clamp.
    let changed = updateGesture(active, point);
    scrollTo(point);
    const actual = currentScroll();
    if (actual.left !== point.left || actual.top !== point.top) changed = updateGesture(active, actual) || changed;
    if (changed) saveWindow(active.name);
    updateDockTarget(active);
    if (actual.left !== current.left || actual.top !== current.top) frame = requestAnimationFrame(autoScroll);
  }

  function finishGesture(event?: PointerEvent) {
    const active = gesture;
    if (!active || (event && event.pointerId !== active.id)) return;
    if (event?.type === 'pointerup' && active.kind !== 'pan') {
      active.client = { left: event.clientX, top: event.clientY };
      if (updateGesture(active)) saveWindow(active.name);
    }
    gesture = null;
    cancelAnimationFrame(frame);
    frame = 0;
    viewport.removeAttribute('data-panning');
    viewport.removeAttribute('data-window-drag');
    showDockTarget(null);
    showAlignmentGuides();
    if (viewport.hasPointerCapture(active.id)) viewport.releasePointerCapture(active.id);
    if (event && !customized) restartSizing();
    if (event?.type === 'pointerup' && active.kind === 'move' && active.moved && !windowName(active.name)
      && findDockTarget(active.name, active.client)) widgets.get(active.name)?.onDock?.();
  }

  function applyReset(saved?: Arrangement | null) {
    finishGesture();
    showAlignmentGuides();
    customized = Boolean(saved);
    canMigrate = false;
    arrangement = saved ?? initialArrangement(viewport, panels.device, aspect ?? DEFAULT_ASPECT);
    resetBaseLayerOrder();
    scrollTo({ left: 0, top: 0 });
    paint();
  }

  function pointerDown(event: PointerEvent) {
    if (!(event.target instanceof Element) || event.target.closest(OVERLAY)) return;
    if (gesture || event.button !== 0 || !event.isPrimary || event.defaultPrevented) return;
    const grabDesk = viewport.hasAttribute('data-desk') && event.target === canvas;
    if (grabDesk) {
      event.preventDefault();
      event.stopPropagation();
    }
    preventClick = false;
    const owner = ownerOf(event.target);
    if (owner) raise(owner);
    const handle = owner ? findHandle(event.target) : null;
    const bounds = handle?.name === owner && owner ? getBounds(owner) : undefined;
    if (!(handle && bounds) && !grabDesk) return;
    event.preventDefault();
    if (handle) {
      // Programmatic focus during a pointer gesture can inherit keyboard focus visibility.
      if (handle.kind === 'resize') handle.element.setAttribute('data-pointer-resize-focus', '');
      handle.element.focus({ preventScroll: true });
    }
    const client = { left: event.clientX, top: event.clientY };
    const base = { id: event.pointerId, startClient: client, client, startScroll: currentScroll(), scale: scaleFor(viewport, viewport.getBoundingClientRect()), moved: false };
    gesture = handle && bounds ? { ...base, ...handle, startBounds: bounds } : { ...base, kind: 'pan' };
    viewport.setPointerCapture(event.pointerId);
    if (handle) viewport.setAttribute('data-window-drag', handle.kind);
    else viewport.setAttribute('data-panning', '');
    preventClick = true;
  }

  viewport.addEventListener('pointerdown', pointerDown, { capture: true, signal });
  viewport.addEventListener('pointermove', event => {
    const active = gesture;
    if (!active || active.id !== event.pointerId) return;
    active.client = { left: event.clientX, top: event.clientY };
    const changed = updateGesture(active);
    if (active.kind !== 'pan') {
      if (changed) saveWindow(active.name);
      updateDockTarget(active);
      if (!frame && active.moved) frame = requestAnimationFrame(autoScroll);
    }
  }, { signal });
  for (const event of ['pointerup', 'pointercancel', 'lostpointercapture'] as const) viewport.addEventListener(event, finishGesture, { signal });
  viewport.addEventListener('click', event => {
    if (event.target instanceof Element && event.target.closest(OVERLAY)) return;
    if (event.detail === 0 || !preventClick) return;
    preventClick = false;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, { capture: true, signal });
  viewport.addEventListener('focusin', event => {
    if (!(event.target instanceof Element) || event.target.closest(OVERLAY)) return;
    const owner = ownerOf(event.target);
    if (owner) raise(owner);
  }, { signal });
  viewport.addEventListener('focusout', event => {
    if (event.target instanceof HTMLElement) event.target.removeAttribute('data-pointer-resize-focus');
  }, { signal });
  viewport.addEventListener('scroll', paintPreviews, { passive: true, signal });
  viewport.addEventListener('keydown', event => {
    const offset = ARROWS[event.key];
    if (!offset || event.defaultPrevented || gesture || !(event.target instanceof Element)) return;
    if (event.target.closest(OVERLAY)) return;
    const handle = findHandle(event.target);
    if (!handle || ownerOf(event.target) !== handle.name) return;
    const bounds = getBounds(handle.name);
    if (!bounds) return;
    event.preventDefault();
    event.stopPropagation();
    handle.element.removeAttribute('data-pointer-resize-focus');
    const step = event.shiftKey ? 32 : event.altKey ? 1 : 16;
    const delta = constrainedDelta(handle, { left: offset.left * step, top: offset.top * step });
    if (!delta.left && !delta.top) return;
    setBounds(handle.name, adjust(handle, bounds, delta));
    setLayerFront(handle.name);
    saveWindow(handle.name);
    paint();
    revealHandle(handle.element);
  }, { signal });
  window.addEventListener('storage', event => {
    if (event.key !== storage.resetKey || event.storageArea !== window.localStorage) return;
    const next = storage.generation();
    if (next === generation) return;
    generation = next;
    applyReset(storage.read(generation));
  }, { signal });

  const observer = new ResizeObserver(restartSizing);
  observer.observe(viewport);
  restartSizing();

  return {
    jump(name: WorkspaceWindowName) {
      const panel = getPanel(name);
      const bounds = getBounds(name);
      if (!panel || !bounds || !visible(name)) return;
      raise(name);
      const revealRight = getComputedStyle(panel).direction === 'rtl' && bounds.width > viewport.clientWidth;
      const left = revealRight ? bounds.left + bounds.width - viewport.clientWidth + MARGIN : bounds.left - MARGIN;
      const point = { left: Math.max(0, left), top: Math.max(0, bounds.top - MARGIN) };
      scrollTo(point);
    },
    previewWindows(targets: ReadonlyMap<WorkspaceWindowName, DOMRectReadOnly>) {
      finishGesture();
      showAlignmentGuides();
      previewTargets = targets;
      paintPreviews();
    },
    clearWindowPreviews,
    snapWidgetPlacement(bounds: Bounds, showGuides: boolean) {
      const scale = scaleFor(viewport, viewport.getBoundingClientRect());
      const snapped = snapBounds(bounds, scale);
      if (showGuides) showAlignmentGuides(snapped.guides);
      return snapped.bounds;
    },
    clearAlignmentGuides: showAlignmentGuides,
    reset() {
      generation = storage.reset();
      applyReset();
    },
    setAspect(next: number | undefined) {
      if (next === undefined || next === aspect) return;
      aspect = next;
      if (!customized) restartSizing();
    },
    addWidget(name: WidgetName) {
      setLayerFront(name);
      paint();
    },
    removeWidget(name: WidgetName, element: HTMLElement) {
      if (gesture && gesture.kind !== 'pan' && gesture.name === name) finishGesture();
      layerOrder = layerOrder.filter(layer => layer !== name);
      clearWindowStyles(element);
      paint();
    },
    dispose() {
      listeners.abort();
      observer.disconnect();
      finishGesture();
      showAlignmentGuides();
      clearWindowPreviews();
      viewport.querySelector('[data-pointer-resize-focus]')?.removeAttribute('data-pointer-resize-focus');
      for (const panel of Object.values(panels)) clearWindowStyles(panel);
      for (const widget of widgets.values()) clearWindowStyles(widget.element);
      canvas.style.removeProperty('width');
      canvas.style.removeProperty('height');
    },
  };
}

/** Owns free window geometry and active gestures without remounting the session media. */
export function useFloatingSessionWorkspace({ active, userId, layoutId, legacyDeviceId, aspect, viewportRef, canvasRef, deviceRef, toolsRef }: WorkspaceOptions) {
  const workspace = useRef<ReturnType<typeof createWorkspace> | null>(null);
  const widgets = useRef(new Map<WidgetName, WidgetRegistration>());
  const ratio = aspect !== undefined && Number.isFinite(aspect) && aspect > 0 ? Math.max(.0001, Math.round(aspect * 10_000) / 10_000) : undefined;
  const currentRatio = useRef(ratio);
  useLayoutEffect(() => {
    if (layoutId) retireSerialLayouts(userId, layoutId, legacyDeviceId);
  }, [userId, layoutId, legacyDeviceId]);
  useLayoutEffect(() => {
    currentRatio.current = ratio;
    workspace.current?.setAspect(ratio);
  }, [ratio]);

  useLayoutEffect(() => {
    if (!active || !layoutId) return;
    const viewport = viewportRef.current;
    const canvas = canvasRef.current;
    const device = deviceRef.current;
    const tools = toolsRef.current;
    if (!viewport || !canvas || !device || !tools) return;
    const controller = createWorkspace(viewport, canvas, { device, tools }, widgets.current, currentRatio.current, userId, layoutId);
    workspace.current = controller;
    return () => {
      controller.dispose();
      workspace.current = null;
    };
  }, [active, userId, layoutId, viewportRef, canvasRef, deviceRef, toolsRef]);

  return useMemo(() => ({
    jump: (name: WorkspaceWindowName) => workspace.current?.jump(name),
    previewWindows: (targets: ReadonlyMap<WorkspaceWindowName, DOMRectReadOnly>) => workspace.current?.previewWindows(targets),
    clearWindowPreviews: () => workspace.current?.clearWindowPreviews(),
    snapWidgetPlacement: (bounds: Bounds, showGuides = false) => workspace.current?.snapWidgetPlacement(bounds, showGuides) ?? bounds,
    clearAlignmentGuides: () => workspace.current?.clearAlignmentGuides(),
    registerWidget(name: WidgetName, element: HTMLElement, bounds: WidgetBounds, options?: WidgetOptions) {
      const previous = widgets.current.get(name);
      if (previous) workspace.current?.removeWidget(name, previous.element);
      const registration = { ...options, element, bounds: constrainWidgetBounds(bounds) };
      widgets.current.set(name, registration);
      workspace.current?.addWidget(name);
      return () => {
        if (widgets.current.get(name) !== registration) return;
        widgets.current.delete(name);
        workspace.current?.removeWidget(name, element);
      };
    },
    reset: () => workspace.current?.reset(),
  }), []);
}
