import { useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { snapFloatingWindow, type AlignmentGuide } from './floatingWindowSnap';
import type { DeskLayoutTemplate } from './deskLayoutTemplate';

export type FloatingWindowName = 'device' | 'tools';
type WidgetName = `widget:${string}`;
export type WorkspaceWindowName = FloatingWindowName | WidgetName;

const MAX_WINDOW_SIZE = 16_000;
// Stay below browser layout overflow limits, even at maximum zoom.
const MAX_SCENE_COORDINATE = 1_000_000;
const SCENE_LIMITS = { min: -MAX_SCENE_COORDINATE, max: MAX_SCENE_COORDINATE };
const floatingWindowLimits = {
  device: { minWidth: 240, minHeight: 260, maxWidth: MAX_WINDOW_SIZE, maxHeight: MAX_WINDOW_SIZE },
  tools: { minWidth: 400, minHeight: 360, maxWidth: MAX_WINDOW_SIZE, maxHeight: MAX_WINDOW_SIZE },
} as const;

type Size = { width: number; height: number };
type Position = { left: number; top: number };
type DeskCamera = Position & { zoom: number };
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
} & ({ kind: 'pan'; nativeScroll: Position } | (Handle & { startBounds: Bounds }));
type PanGesture = Extract<Gesture, { kind: 'pan' }>;
type WindowGesture = Exclude<Gesture, { kind: 'pan' }>;

type WorkspaceOptions = {
  active: boolean;
  userId: string;
  sessionId: string;
  layoutId?: string;
  layoutTemplate?: DeskLayoutTemplate | null;
  legacyDeviceId?: string;
  aspect?: number;
  viewportRef: RefObject<HTMLDivElement | null>;
  canvasRef: RefObject<HTMLDivElement | null>;
  deskGridRef: RefObject<HTMLDivElement | null>;
  deviceRef: RefObject<HTMLElement | null>;
  toolsRef: RefObject<HTMLElement | null>;
};

const DEFAULT_ASPECT = 9 / 19.5;
export const DESK_MIN_ZOOM = .5;
export const DESK_MAX_ZOOM = 2;
const DESK_GRID_CELL = 32;
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
    left: clamp(Number.isFinite(bounds.left) ? bounds.left : MARGIN, SCENE_LIMITS.min, SCENE_LIMITS.max),
    top: clamp(Number.isFinite(bounds.top) ? bounds.top : MARGIN, SCENE_LIMITS.min, SCENE_LIMITS.max),
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
  const left = west ? clamp(bounds.left + dx, Math.max(SCENE_LIMITS.min, right - limits.maxWidth), Math.min(SCENE_LIMITS.max, right - limits.minWidth)) : bounds.left;
  const top = north ? clamp(bounds.top + dy, Math.max(SCENE_LIMITS.min, bottom - limits.maxHeight), Math.min(SCENE_LIMITS.max, bottom - limits.minHeight)) : bounds.top;
  return constrain(handle.name, {
    left, top,
    width: west ? right - left : bounds.width + dx,
    height: north ? bottom - top : bounds.height + dy,
  });
}

function initialArrangement(viewport: HTMLElement, device: HTMLElement, aspect: number): Arrangement {
  const width = viewport.clientWidth || 1200;
  const height = viewport.clientHeight || 680;
  const horizontal = device.dataset.controlsEdge === 'top' || device.dataset.controlsEdge === 'bottom';
  const style = getComputedStyle(device);
  const toolbarWidth = Number.parseFloat(style.getPropertyValue('--device-controls-width')) || 70;
  const toolbarHeight = Number.parseFloat(style.getPropertyValue('--device-controls-height')) || 66;
  const frameInsets = 2 + 2 * (Number.parseFloat(style.getPropertyValue('--viewer-stage-padding')) || 12);
  const chromeWidth = frameInsets + (horizontal ? 0 : toolbarWidth);
  const chromeHeight = frameInsets + (horizontal ? toolbarHeight : 0);
  const deviceHeight = Math.max(floatingWindowLimits.device.minHeight, height - 2 * MARGIN);
  const deviceWidth = Math.min((deviceHeight - chromeHeight) * aspect + chromeWidth, width - floatingWindowLimits.tools.minWidth - 3 * MARGIN);
  const deviceWindow = constrain('device', { left: MARGIN, top: MARGIN, width: deviceWidth, height: deviceHeight });
  const toolLeft = deviceWindow.left + deviceWindow.width + MARGIN;
  const toolsWindow = constrain('tools', { left: toolLeft, top: MARGIN, width: width - toolLeft - MARGIN, height: height - 2 * MARGIN });
  return { windows: { device: deviceWindow, tools: toolsWindow }, front: 'tools' };
}

function readArrangement(key: string, getStorage = () => window.localStorage): SavedArrangement | null | undefined {
  try {
    const raw = getStorage().getItem(key);
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

function layoutStorage(userId: string, layoutId: string, temporary = false) {
  const account = encodeURIComponent(userId);
  const suffix = `${account}:${encodeURIComponent(layoutId)}`;
  const prefix = `rdf-session-floating-v3:${suffix}`;
  const resetKey = `${prefix}:reset`;
  const getStorage = () => temporary ? window.sessionStorage : window.localStorage;
  const generation = () => {
    try {
      const stored = getStorage().getItem(resetKey);
      return stored && /^\d{1,10}(?:-\d{1,10}){3}$/.test(stored) ? stored : 'initial';
    }
    catch { return 'initial'; }
  };
  const recordKey = (version: string, name: FloatingWindowName | 'base') => `${prefix}:${version}:${name}`;
  const write = (version: string, name: FloatingWindowName | 'base', value: Arrangement) => {
    try {
      const storage = getStorage();
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
      const device = readArrangement(recordKey(version, 'device'), getStorage);
      const tools = readArrangement(recordKey(version, 'tools'), getStorage);
      // Separate records let two tabs move different windows independently.
      if (device && tools) return {
        windows: { device: device.windows.device, tools: tools.windows.tools },
        front: device.updatedAt > tools.updatedAt ? device.front : tools.front,
      };
      return device ?? tools ?? readArrangement(recordKey(version, 'base'), getStorage)
        ?? (version !== 'initial' ? null : temporary ? undefined : readArrangement(`rdf-session-floating-v2:${suffix}`));
    },
    readLegacy(aspect: number) {
      return readArrangement(`rdf-session-floating-v1:${account}:${aspect.toFixed(4)}`);
    },
    reset() {
      const next = crypto.getRandomValues(new Uint32Array(4)).join('-');
      try {
        const storage = getStorage();
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
  if (target.getAttribute('role') === 'tablist' && target.scrollWidth > target.clientWidth) return null;
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

function createWorkspace(viewport: HTMLDivElement, plane: HTMLElement, canvas: HTMLDivElement, deskGrid: HTMLDivElement, panels: Panels, widgets: Map<WidgetName, WidgetRegistration>, initialAspect: number | undefined, userId: string, layoutId: string, template: DeskLayoutTemplate | null | undefined, cameraKey: string, onDeskZoom: (value: number) => void) {
  const listeners = new AbortController();
  const { signal } = listeners;
  const storage = layoutStorage(userId, layoutId, Boolean(template));
  let generation = storage.generation();
  const stored = storage.read(generation);
  const saved = stored === undefined ? fromTemplate() : stored;
  let aspect = initialAspect;
  let arrangement = saved ?? initialArrangement(viewport, panels.device, aspect ?? DEFAULT_ASPECT);
  let customized = Boolean(saved);
  let canMigrate = stored === undefined && !template;
  let zoom = 1;
  let origin: Position = { left: 0, top: 0 };
  let scrollRange = { left: 0, top: 0, right: 0, bottom: 0 };
  let content = { left: 0, top: 0, right: 0, bottom: 0 };
  let gesture: Gesture | null = null;
  let frame = 0;
  let pendingMove = false;
  let preventClick = false;
  let dockTarget: HTMLElement | null = null;
  let layerOrder: WorkspaceWindowName[] = [...widgets.keys()];
  let previewTargets: ReadonlyMap<WorkspaceWindowName, DOMRectReadOnly> | null = null;
  let previewedPanels = new Set<HTMLElement>();
  const guideLines = new Map<AlignmentGuide['axis'], HTMLDivElement>();
  resetBaseLayerOrder();

  function fromTemplate(): Arrangement | undefined {
    if (!template) return;
    return {
      windows: { device: constrain('device', template.windows.device), tools: constrain('tools', template.windows.tools) },
      front: template.front,
    };
  }

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

  function snapBounds(bounds: Bounds, scale: Size, handle?: Handle, shown = layerOrder.filter(visible)) {
    if (previewTargets) return { bounds, guides: [] };
    const neighbors: Bounds[] = [];
    for (const name of shown) {
      if (name === handle?.name) continue;
      const other = getBounds(name);
      if (other) neighbors.push(other);
    }
    const resize = handle?.kind === 'resize'
      ? { direction: handle.direction, ...floatingWindowLimits[windowName(handle.name) ? handle.name : 'tools'] }
      : undefined;
    return snapFloatingWindow(bounds, neighbors, {
      x: WINDOW_SNAP_DISTANCE / scale.width,
      y: WINDOW_SNAP_DISTANCE / scale.height,
    }, SCENE_LIMITS, resize);
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

  function sizeCanvas(point = currentScroll()) {
    const width = viewport.clientWidth;
    const height = viewport.clientHeight;
    const paddingX = Math.round(width / 2);
    const paddingY = Math.round(height / 2);
    const left = Math.min(0, (content.left - MARGIN) * zoom);
    const top = Math.min(0, (content.top - MARGIN) * zoom);
    const right = Math.max(width, (content.right + MARGIN) * zoom);
    const bottom = Math.max(height, (content.bottom + MARGIN) * zoom);
    // Native scroll coordinates stay positive. The scene origin moves when the visible area expands.
    const minX = Math.floor(Math.min(left, point.left) - paddingX);
    const minY = Math.floor(Math.min(top, point.top) - paddingY);
    const maxX = Math.ceil(Math.max(right, point.left + width) + paddingX);
    const maxY = Math.ceil(Math.max(bottom, point.top + height) + paddingY);
    origin = { left: -minX, top: -minY };
    scrollRange = { left: minX, top: minY, right: maxX - width, bottom: maxY - height };
    canvas.style.width = `${right / zoom}px`;
    canvas.style.height = `${bottom / zoom}px`;
    plane.style.setProperty('--scene-origin-x', `${origin.left}px`);
    plane.style.setProperty('--scene-origin-y', `${origin.top}px`);
    viewport.dataset.deskZoom = String(zoom);
    plane.style.setProperty('--desk-zoom', String(zoom));
    deskGrid.style.setProperty('--desk-grid-cell', `${DESK_GRID_CELL * zoom}px`);
    plane.style.width = `${maxX - minX}px`;
    plane.style.height = `${maxY - minY}px`;
    setNativeScroll(point);
  }

  function clearDeskZoom() {
    delete viewport.dataset.deskZoom;
    plane.style.removeProperty('--desk-zoom');
    deskGrid.style.removeProperty('--desk-grid-cell');
    deskGrid.style.removeProperty('transform');
  }

  function measureContent(shown: readonly WorkspaceWindowName[]) {
    const edges = { left: MARGIN, top: MARGIN, right: 0, bottom: 0 };
    for (const name of shown) {
      const bounds = getBounds(name);
      if (!bounds) continue;
      edges.left = Math.min(edges.left, bounds.left);
      edges.top = Math.min(edges.top, bounds.top);
      edges.right = Math.max(edges.right, bounds.left + bounds.width);
      edges.bottom = Math.max(edges.bottom, bounds.top + bounds.height);
    }
    return edges;
  }

  function paintWindow(panel: HTMLElement, bounds: Bounds, previous?: Bounds) {
    for (const edge of ['left', 'top', 'width', 'height'] as const) {
      if (bounds[edge] !== previous?.[edge]) panel.style[edge] = `${bounds[edge]}px`;
    }
  }

  function paint() {
    const shown = layerOrder.filter(visible);
    const front = shown.at(-1);
    for (const [index, name] of layerOrder.entries()) {
      const panel = getPanel(name);
      const bounds = getBounds(name);
      if (!panel || !bounds) continue;
      paintWindow(panel, bounds);
      panel.style.zIndex = String(index + 1);
      panel.toggleAttribute('data-front', name === front);
    }
    content = measureContent(shown);
    sizeCanvas();
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
    return { left: viewport.scrollLeft - origin.left, top: viewport.scrollTop - origin.top };
  }

  function setNativeScroll(point: Position) {
    viewport.scrollTo({ left: point.left + origin.left, top: point.top + origin.top, behavior: 'instant' });
    if (gesture?.kind !== 'pan') paintDeskGrid(point);
  }

  function constrainDeskScroll(point: Position): Position {
    const extent = (MAX_SCENE_COORDINATE + MAX_WINDOW_SIZE) * zoom;
    return { left: clamp(point.left, -extent, extent), top: clamp(point.top, -extent, extent) };
  }

  function paintDeskGrid(point: Position) {
    const cell = DESK_GRID_CELL * zoom;
    const phase = (offset: number) => ((-offset % cell) + cell) % cell;
    const transform = `translate3d(${phase(point.left)}px, ${phase(point.top)}px, 0px)`;
    if (deskGrid.style.transform !== transform) deskGrid.style.transform = transform;
  }

  function panPoint(active: PanGesture): Position {
    return constrainDeskScroll({
      left: active.startScroll.left - (active.client.left - active.startClient.left) / active.scale.width,
      top: active.startScroll.top - (active.client.top - active.startClient.top) / active.scale.height,
    });
  }

  function paintPan(active: PanGesture) {
    const point = panPoint(active);
    // Translate in viewport pixels so the canvas' existing zoom does not amplify the gesture.
    canvas.style.translate = `${active.nativeScroll.left - point.left}px ${active.nativeScroll.top - point.top}px 0px`;
    paintDeskGrid(point);
  }

  function scrollTo(point: Position, geometryChanged = false) {
    const { left, top } = constrainDeskScroll(point);
    if (geometryChanged || left < scrollRange.left || left > scrollRange.right || top < scrollRange.top || top > scrollRange.bottom) {
      sizeCanvas({ left, top });
      return;
    }
    setNativeScroll({ left, top });
  }

  function sceneStart() {
    return { left: Math.min(0, (content.left - MARGIN) * zoom), top: Math.min(0, (content.top - MARGIN) * zoom) };
  }

  function readDeskCamera(): DeskCamera | undefined {
    try {
      const saved = JSON.parse(window.sessionStorage.getItem(cameraKey) ?? 'null') as DeskCamera | null;
      if (saved && Number.isFinite(saved.zoom) && saved.zoom >= DESK_MIN_ZOOM && saved.zoom <= DESK_MAX_ZOOM &&
        Number.isFinite(saved.left) && Number.isFinite(saved.top)) return saved;
    } catch { /* Storage may be unavailable or contain an invalid value. */ }
    return undefined;
  }

  function saveDeskCamera() {
    try {
      const point = gesture?.kind === 'pan' ? panPoint(gesture) : currentScroll();
      window.sessionStorage.setItem(cameraKey, JSON.stringify({ zoom, ...point }));
    } catch { /* Storage may be unavailable. */ }
  }

  function cameraAvailable() {
    return !gesture && !previewTargets && !document.fullscreenElement && !viewport.hasAttribute('data-tab-drag');
  }

  function zoomAt(requested: number, anchor: Position) {
    const next = Math.min(DESK_MAX_ZOOM, Math.max(DESK_MIN_ZOOM, requested));
    if (zoom === next) return;
    const offset = currentScroll();
    const factor = next / zoom;
    zoom = next;
    scrollTo({
      left: (offset.left + anchor.left) * factor - anchor.left,
      top: (offset.top + anchor.top) * factor - anchor.top,
    }, true);
    onDeskZoom(zoom);
    saveDeskCamera();
  }

  function changeDeskZoom(action: -1 | 0 | 1) {
    if (!cameraAvailable()) return;
    if (action === 0) {
      zoom = 1;
      scrollTo(sceneStart(), true);
      onDeskZoom(zoom);
      saveDeskCamera();
      return;
    }
    zoomAt(Math.round(zoom * 100 + action * 10) / 100, { left: viewport.clientWidth / 2, top: viewport.clientHeight / 2 });
  }

  function scaleForWindows(scale = scaleFor(viewport, viewport.getBoundingClientRect())): Size {
    return { width: scale.width * zoom, height: scale.height * zoom };
  }

  function revealHandle(element: HTMLElement) {
    const outer = viewport.getBoundingClientRect();
    const inner = element.getBoundingClientRect();
    const scale = scaleFor(viewport, outer);
    const startX = outer.left + viewport.clientLeft * scale.width;
    const startY = outer.top + viewport.clientTop * scale.height;
    const left = inner.left < startX ? inner.left - startX : Math.max(0, inner.right - startX - viewport.clientWidth * scale.width);
    const top = inner.top < startY ? inner.top - startY : Math.max(0, inner.bottom - startY - viewport.clientHeight * scale.height);
    if (!left && !top) return;
    const offset = currentScroll();
    scrollTo({ left: offset.left + left / scale.width, top: offset.top + top / scale.height });
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

  function updateWindowGesture(active: WindowGesture, scroll = currentScroll()) {
    const left = (active.client.left - active.startClient.left) / active.scale.width;
    const top = (active.client.top - active.startClient.top) / active.scale.height;
    const delta = constrainedDelta(active, {
      left: (left + scroll.left - active.startScroll.left) / zoom,
      top: (top + scroll.top - active.startScroll.top) / zoom,
    });
    active.moved ||= active.kind === 'move' && !windowName(active.name)
      ? Math.hypot(left, top) >= WIDGET_DRAG_THRESHOLD
      : Math.abs(delta.left) + Math.abs(delta.top) >= 1;
    const panel = getPanel(active.name);
    const previous = getBounds(active.name);
    if (!panel || !previous) return false;
    const proposed = adjust(active, active.startBounds, delta);
    const target = active.kind === 'move' && !windowName(active.name) && active.moved ? findDockTarget(active.name, active.client) : null;
    const shown = layerOrder.filter(visible);
    const { bounds: next, guides } = active.moved && !target ? snapBounds(proposed, scaleForWindows(active.scale), active, shown) : { bounds: proposed, guides: [] };
    showDockTarget(target);
    showAlignmentGuides(guides);
    if (previous.left === next.left && previous.top === next.top && previous.width === next.width && previous.height === next.height) return false;
    setBounds(active.name, next);
    paintWindow(panel, next, previous);
    content = measureContent(shown);
    return true;
  }

  function edgeScrollPoint(active: WindowGesture, current: Position): Position {
    const rect = viewport.getBoundingClientRect();
    const offset = {
      left: (active.client.left - rect.left) / active.scale.width - viewport.clientLeft,
      top: (active.client.top - rect.top) / active.scale.height - viewport.clientTop,
    };
    const towardEdge = (speed: number, fromStart: number) => speed * fromStart > 0 ? speed : 0;
    const delta = constrainedDelta(active, {
      left: towardEdge(edgeSpeed(offset.left, viewport.clientWidth), active.client.left - active.startClient.left),
      top: towardEdge(edgeSpeed(offset.top, viewport.clientHeight), active.client.top - active.startClient.top),
    });
    return {
      left: current.left + delta.left,
      top: current.top + delta.top,
    };
  }

  function gestureFrame() {
    frame = 0;
    pendingMove = false;
    const active = gesture;
    if (!active) return;
    if (active.kind === 'pan') { paintPan(active); return; }

    const current = currentScroll();
    const wasMoved = active.moved;
    const point = wasMoved ? edgeScrollPoint(active, current) : current;
    let changed = updateWindowGesture(active, point);
    let scrolling = false;
    if (point.left !== current.left || point.top !== current.top) {
      scrollTo(point);
      const actual = currentScroll();
      if (actual.left !== point.left || actual.top !== point.top) changed = updateWindowGesture(active, actual) || changed;
      scrolling = actual.left !== current.left || actual.top !== current.top;
    }
    if (changed) saveWindow(active.name);
    if (scrolling || (!wasMoved && active.moved)) frame = requestAnimationFrame(gestureFrame);
  }

  function finishGesture(event?: PointerEvent) {
    const active = gesture;
    if (!active || (event && event.pointerId !== active.id)) return;
    if (event?.type === 'pointerup') active.client = { left: event.clientX, top: event.clientY };
    if (active.kind !== 'pan' && event && (event.type === 'pointerup' || pendingMove)) {
      if (updateWindowGesture(active)) saveWindow(active.name);
    }
    const docking = event?.type === 'pointerup' && dockTarget !== null;
    gesture = null;
    cancelAnimationFrame(frame);
    frame = 0;
    pendingMove = false;
    if (active.kind === 'pan') {
      canvas.style.removeProperty('translate');
      if (viewport.hasAttribute('data-desk')) {
        scrollTo(panPoint(active));
        saveDeskCamera();
      }
    } else if (active.moved && viewport.hasAttribute('data-desk')) sizeCanvas();
    viewport.removeAttribute('data-panning');
    viewport.removeAttribute('data-window-drag');
    showDockTarget(null);
    showAlignmentGuides();
    if (viewport.hasPointerCapture(active.id)) viewport.releasePointerCapture(active.id);
    if (event && active.kind !== 'pan' && !customized) restartSizing();
    if (docking && active.kind === 'move' && !windowName(active.name)) widgets.get(active.name)?.onDock?.();
  }

  function applyReset(saved?: Arrangement | null) {
    finishGesture();
    showAlignmentGuides();
    customized = Boolean(saved);
    canMigrate = false;
    arrangement = saved ?? initialArrangement(viewport, panels.device, aspect ?? DEFAULT_ASPECT);
    resetBaseLayerOrder();
    paint();
    scrollTo(sceneStart());
    saveDeskCamera();
  }

  function pointerDown(event: PointerEvent) {
    if (!(event.target instanceof Element) || event.target.closest(OVERLAY)) return;
    if (gesture || !event.isPrimary || event.defaultPrevented) return;
    const grabDesk = event.button === 2 && cameraAvailable();
    if (event.button !== 0 && !grabDesk) return;
    preventClick = false;
    const owner = grabDesk ? undefined : ownerOf(event.target);
    if (owner) raise(owner);
    const handle = owner ? findHandle(event.target) : null;
    const bounds = handle?.name === owner && owner ? getBounds(owner) : undefined;
    if (!(handle && bounds) && !grabDesk) return;
    event.preventDefault();
    if (grabDesk) event.stopPropagation();
    if (handle) {
      // Programmatic focus during a pointer gesture can inherit keyboard focus visibility.
      if (handle.kind === 'resize') handle.element.setAttribute('data-pointer-resize-focus', '');
      handle.element.focus({ preventScroll: true });
    }
    const client = { left: event.clientX, top: event.clientY };
    const base = { id: event.pointerId, startClient: client, client, startScroll: currentScroll(), scale: scaleFor(viewport, viewport.getBoundingClientRect()), moved: false };
    gesture = handle && bounds ? { ...base, ...handle, startBounds: bounds } : { ...base, kind: 'pan', nativeScroll: base.startScroll };
    viewport.setPointerCapture(event.pointerId);
    if (handle) viewport.setAttribute('data-window-drag', handle.kind);
    else viewport.setAttribute('data-panning', '');
    preventClick = Boolean(handle);
  }

  viewport.addEventListener('pointerdown', pointerDown, { capture: true, signal });
  viewport.addEventListener('pointermove', event => {
    const active = gesture;
    if (!active || active.id !== event.pointerId) return;
    if (active.kind === 'pan' && !(event.buttons & 2)) { finishGesture(event); return; }
    active.client = { left: event.clientX, top: event.clientY };
    pendingMove = true;
    if (!frame) frame = requestAnimationFrame(gestureFrame);
  }, { signal });
  for (const event of ['pointerup', 'pointercancel', 'lostpointercapture'] as const) viewport.addEventListener(event, finishGesture, { signal });
  viewport.addEventListener('contextmenu', event => {
    if (event.button === 2 && !document.fullscreenElement && event.target instanceof Element && !event.target.closest(OVERLAY)) event.preventDefault();
  }, { signal });
  const wheelArea = viewport.closest<HTMLElement>('.session-layout') ?? viewport;
  wheelArea.addEventListener('wheel', event => {
    if (!event.ctrlKey || !Number.isFinite(event.deltaY) || !event.deltaY ||
      document.fullscreenElement || !(event.target instanceof Element) || event.target.closest(OVERLAY)) return;
    event.preventDefault();
    event.stopPropagation();
    if (!cameraAvailable()) return;
    const rect = viewport.getBoundingClientRect();
    const scale = scaleFor(viewport, rect);
    const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.clientHeight : 1);
    zoomAt(zoom * 2 ** (-delta / 500), {
      left: (event.clientX - rect.left) / scale.width - viewport.clientLeft,
      top: (event.clientY - rect.top) / scale.height - viewport.clientTop,
    });
  }, { passive: false, signal });
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
  viewport.addEventListener('scroll', () => {
    const point = currentScroll();
    if (gesture?.kind !== 'pan') paintDeskGrid(point);
    else if (point.left !== gesture.nativeScroll.left || point.top !== gesture.nativeScroll.top) {
      gesture.nativeScroll = point;
      paintPan(gesture);
    }
    paintPreviews();
  }, { passive: true, signal });
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
    if (template || event.key !== storage.resetKey || event.storageArea !== window.localStorage) return;
    const next = storage.generation();
    if (next === generation) return;
    generation = next;
    applyReset(storage.read(generation));
  }, { signal });
  window.addEventListener('pagehide', saveDeskCamera, { signal });

  const observer = new ResizeObserver(restartSizing);
  observer.observe(viewport);
  const savedCamera = readDeskCamera();
  zoom = savedCamera?.zoom ?? 1;
  onDeskZoom(zoom);
  restartSizing();
  scrollTo(savedCamera ?? sceneStart());

  return {
    jump(name: WorkspaceWindowName) {
      const panel = getPanel(name);
      const bounds = getBounds(name);
      if (!panel || !bounds || !visible(name)) return;
      raise(name);
      const revealRight = getComputedStyle(panel).direction === 'rtl' && bounds.width * zoom > viewport.clientWidth;
      const left = revealRight ? (bounds.left + bounds.width + MARGIN) * zoom - viewport.clientWidth : (bounds.left - MARGIN) * zoom;
      const point = { left, top: (bounds.top - MARGIN) * zoom };
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
      const snapped = snapBounds(bounds, scaleForWindows());
      if (showGuides) showAlignmentGuides(snapped.guides);
      return snapped.bounds;
    },
    clearAlignmentGuides: showAlignmentGuides,
    snapshotLayout(): DeskLayoutTemplate {
      const { windows, front } = arrangement;
      return {
        windows: { device: { ...windows.device }, tools: { ...windows.tools } },
        front,
        widgets: Object.fromEntries(Array.from(widgets, ([name, widget]) => [name.slice('widget:'.length), { ...widget.bounds }])),
      };
    },
    saveCamera: saveDeskCamera,
    changeDeskZoom,
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
      if (viewport.isConnected && viewport.hasAttribute('data-desk')) saveDeskCamera();
      showAlignmentGuides();
      clearWindowPreviews();
      viewport.querySelector('[data-pointer-resize-focus]')?.removeAttribute('data-pointer-resize-focus');
      for (const panel of Object.values(panels)) clearWindowStyles(panel);
      for (const widget of widgets.values()) clearWindowStyles(widget.element);
      clearDeskZoom();
      for (const property of ['--scene-origin-x', '--scene-origin-y', 'width', 'height']) plane.style.removeProperty(property);
      canvas.style.removeProperty('width');
      canvas.style.removeProperty('height');
    },
  };
}

/** Owns free window geometry and active gestures without remounting the session media. */
export function useFloatingSessionWorkspace({ active, userId, sessionId, layoutId, layoutTemplate, legacyDeviceId, aspect, viewportRef, canvasRef, deskGridRef, deviceRef, toolsRef }: WorkspaceOptions) {
  const workspace = useRef<ReturnType<typeof createWorkspace> | null>(null);
  const widgets = useRef(new Map<WidgetName, WidgetRegistration>());
  const [deskZoom, setDeskZoom] = useState(1);
  const cameraKey = `rdf-session-desk-camera:${encodeURIComponent(userId)}:${encodeURIComponent(sessionId)}`;
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
    const plane = canvas?.parentElement;
    const deskGrid = deskGridRef.current;
    const device = deviceRef.current;
    const tools = toolsRef.current;
    if (!viewport || !plane || !canvas || !deskGrid || !device || !tools) return;
    const controller = createWorkspace(viewport, plane, canvas, deskGrid, { device, tools }, widgets.current, currentRatio.current, userId, layoutId, layoutTemplate, cameraKey, setDeskZoom);
    workspace.current = controller;
    return () => {
      controller.dispose();
      workspace.current = null;
    };
  }, [active, userId, layoutId, layoutTemplate, cameraKey, viewportRef, canvasRef, deskGridRef, deviceRef, toolsRef]);

  const actions = useMemo(() => ({
    jump: (name: WorkspaceWindowName) => workspace.current?.jump(name),
    previewWindows: (targets: ReadonlyMap<WorkspaceWindowName, DOMRectReadOnly>) => workspace.current?.previewWindows(targets),
    clearWindowPreviews: () => workspace.current?.clearWindowPreviews(),
    snapWidgetPlacement: (bounds: Bounds, showGuides = false) => workspace.current?.snapWidgetPlacement(bounds, showGuides) ?? bounds,
    clearAlignmentGuides: () => workspace.current?.clearAlignmentGuides(),
    snapshotLayout: () => workspace.current?.snapshotLayout(),
    changeDeskZoom: (action: -1 | 0 | 1) => workspace.current?.changeDeskZoom(action),
    saveCamera: () => workspace.current?.saveCamera(),
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
  return { ...actions, deskZoom };
}
