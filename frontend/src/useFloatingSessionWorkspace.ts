import { useLayoutEffect, useMemo, useRef, type RefObject } from 'react';

export type FloatingWindowName = 'device' | 'tools';

const MAX_WINDOW_SIZE = 16_000;
export const floatingWindowLimits = {
  device: { minWidth: 240, minHeight: 260, maxWidth: MAX_WINDOW_SIZE, maxHeight: MAX_WINDOW_SIZE },
  tools: { minWidth: 400, minHeight: 360, maxWidth: MAX_WINDOW_SIZE, maxHeight: MAX_WINDOW_SIZE },
} as const;

type Size = { width: number; height: number };
type Position = { left: number; top: number };
type Bounds = Size & Position;
type Direction = 'nw' | 'ne' | 'sw' | 'se';
type Panels = Record<FloatingWindowName, HTMLElement>;
type Arrangement = { windows: Record<FloatingWindowName, Bounds>; front: FloatingWindowName };
type Handle = { element: HTMLElement; name: FloatingWindowName } & (
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
  aspect: number;
  viewportRef: RefObject<HTMLDivElement | null>;
  canvasRef: RefObject<HTMLDivElement | null>;
  deviceRef: RefObject<HTMLElement | null>;
  toolsRef: RefObject<HTMLElement | null>;
};

const WINDOW_NAMES = ['device', 'tools'] as const;
const DEFAULT_ASPECT = 9 / 19.5;
const MARGIN = 12;
const SCROLL_EDGE = 40;
const SCROLL_SPEED = 18;
const ARROWS: Record<string, Position> = {
  ArrowLeft: { left: -1, top: 0 }, ArrowRight: { left: 1, top: 0 },
  ArrowUp: { left: 0, top: -1 }, ArrowDown: { left: 0, top: 1 },
};

function windowName(value: string | undefined): value is FloatingWindowName {
  return value === 'device' || value === 'tools';
}

function resizeDirection(value: string | undefined): value is Direction {
  return value === 'nw' || value === 'ne' || value === 'sw' || value === 'se';
}

function clamp(value: number, min: number, max: number) {
  return Math.round(Math.max(min, Math.min(max, value)));
}

function constrain(name: FloatingWindowName, bounds: Bounds): Bounds {
  const limits = floatingWindowLimits[name];
  return {
    left: clamp(bounds.left, 0, MAX_WINDOW_SIZE),
    top: clamp(bounds.top, 0, MAX_WINDOW_SIZE),
    width: clamp(bounds.width, limits.minWidth, limits.maxWidth),
    height: clamp(bounds.height, limits.minHeight, limits.maxHeight),
  };
}

function adjust(handle: Handle, bounds: Bounds, delta: Position): Bounds {
  if (handle.kind === 'move') {
    return constrain(handle.name, { ...bounds, left: bounds.left + delta.left, top: bounds.top + delta.top });
  }

  const limits = floatingWindowLimits[handle.name];
  const west = handle.direction.endsWith('w');
  const north = handle.direction.startsWith('n');
  const right = bounds.left + bounds.width;
  const bottom = bounds.top + bounds.height;
  const left = west ? clamp(bounds.left + delta.left, Math.max(0, right - limits.maxWidth), Math.min(MAX_WINDOW_SIZE, right - limits.minWidth)) : bounds.left;
  const top = north ? clamp(bounds.top + delta.top, Math.max(0, bottom - limits.maxHeight), Math.min(MAX_WINDOW_SIZE, bottom - limits.minHeight)) : bounds.top;
  return constrain(handle.name, {
    left, top,
    width: west ? right - left : bounds.width + delta.left,
    height: north ? bottom - top : bounds.height + delta.top,
  });
}

function initialArrangement(viewport: HTMLElement, device: HTMLElement, aspect: number): Arrangement {
  const width = viewport.clientWidth || 1200;
  const height = viewport.clientHeight || 680;
  const style = getComputedStyle(device);
  const chromeWidth = Number.parseFloat(style.getPropertyValue('--free-device-chrome-x')) || 76;
  const chromeHeight = Number.parseFloat(style.getPropertyValue('--free-device-chrome-y')) || 64;
  const deviceHeight = Math.max(floatingWindowLimits.device.minHeight, height - 2 * MARGIN);
  const deviceWidth = Math.min((deviceHeight - chromeHeight) * aspect + chromeWidth, width - floatingWindowLimits.tools.minWidth - 3 * MARGIN);
  const deviceWindow = constrain('device', { left: MARGIN, top: MARGIN, width: deviceWidth, height: deviceHeight });
  const toolLeft = deviceWindow.left + deviceWindow.width + MARGIN;
  const toolsWindow = constrain('tools', { left: toolLeft, top: MARGIN, width: width - toolLeft - MARGIN, height: height - 2 * MARGIN });
  return { windows: { device: deviceWindow, tools: toolsWindow }, front: 'tools' };
}

function readArrangement(key: string): Arrangement | null {
  try {
    const saved = JSON.parse(window.localStorage.getItem(key) ?? 'null') as Partial<Arrangement> | null;
    if (!saved?.windows || !windowName(saved.front)) return null;
    const { device, tools } = saved.windows;
    const valid = (bounds: Bounds | undefined) => bounds && [bounds.left, bounds.top, bounds.width, bounds.height].every(Number.isFinite);
    if (!valid(device) || !valid(tools)) return null;
    return { windows: { device: constrain('device', device), tools: constrain('tools', tools) }, front: saved.front };
  } catch { return null; }
}

function saveArrangement(key: string, value: Arrangement | null) {
  try {
    if (value) window.localStorage.setItem(key, JSON.stringify(value));
    else window.localStorage.removeItem(key);
  } catch { /* Storage can be unavailable. */ }
}

function findHandle(target: Element): Handle | null {
  const corner = target.closest<HTMLElement>('[data-window-resize][data-direction]');
  if (corner && windowName(corner.dataset.windowResize) && resizeDirection(corner.dataset.direction)) {
    return { element: corner, name: corner.dataset.windowResize, kind: 'resize', direction: corner.dataset.direction };
  }
  const grip = target.closest<HTMLElement>('[data-window-move]');
  if (!grip || !windowName(grip.dataset.windowMove)) return null;
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

function createWorkspace(viewport: HTMLDivElement, canvas: HTMLDivElement, panels: Panels, aspect: number, storageKey: string) {
  const listeners = new AbortController();
  const { signal } = listeners;
  const saved = readArrangement(storageKey);
  let arrangement = saved ?? initialArrangement(viewport, panels.device, aspect);
  let customized = saved !== null;
  let extra = { width: 0, height: 0 };
  let visibleWindows = '';
  let gesture: Gesture | null = null;
  let frame = 0;
  let pan = false;
  let preventClick = false;

  function visible(name: FloatingWindowName) {
    const panel = panels[name];
    return !panel.hidden && getComputedStyle(panel).display !== 'none';
  }

  function paint() {
    const shown = WINDOW_NAMES.filter(visible);
    const signature = shown.join(' ');
    if (signature !== visibleWindows) {
      extra = { width: 0, height: 0 };
      visibleWindows = signature;
    }
    const front = shown.includes(arrangement.front) ? arrangement.front : shown[0];
    for (const name of WINDOW_NAMES) {
      const { left, top, width, height } = arrangement.windows[name];
      Object.assign(panels[name].style, { left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px`, zIndex: name === front ? '2' : '1' });
      panels[name].toggleAttribute('data-front', name === front);
    }
    const horizontal = Math.max(0, ...shown.map(name => arrangement.windows[name].left + arrangement.windows[name].width));
    const vertical = Math.max(0, ...shown.map(name => arrangement.windows[name].top + arrangement.windows[name].height));
    canvas.style.width = `${Math.max(viewport.clientWidth, horizontal + MARGIN, extra.width)}px`;
    canvas.style.height = `${Math.max(viewport.clientHeight, vertical + MARGIN, extra.height)}px`;
  }

  function save() {
    customized = true;
    saveArrangement(storageKey, arrangement);
  }

  function raise(name: FloatingWindowName) {
    if (arrangement.front === name) return;
    arrangement.front = name;
    paint();
  }

  function restartSizing() {
    if (gesture && (viewport.clientWidth === 0 || viewport.clientHeight === 0 || gesture.kind !== 'pan' && !visible(gesture.name))) finishGesture();
    if (!customized && !gesture) arrangement.windows = initialArrangement(viewport, panels.device, aspect).windows;
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

  function makeRoom(point: Position) {
    extra = {
      width: Math.max(extra.width, point.left + viewport.clientWidth),
      height: Math.max(extra.height, point.top + viewport.clientHeight),
    };
    paint();
  }

  function updateGesture(active: Gesture) {
    const left = (active.client.left - active.startClient.left) / active.scale.width;
    const top = (active.client.top - active.startClient.top) / active.scale.height;
    if (active.kind === 'pan') {
      scrollTo({ left: active.startScroll.left - left, top: active.startScroll.top - top });
      return;
    }
    const delta = { left: left + viewport.scrollLeft - active.startScroll.left, top: top + viewport.scrollTop - active.startScroll.top };
    active.moved ||= Math.abs(delta.left) + Math.abs(delta.top) >= 1;
    arrangement.windows[active.name] = adjust(active, active.startBounds, delta);
    paint();
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
    const dx = edgeSpeed(offset.left, viewport.clientWidth);
    const dy = edgeSpeed(offset.top, viewport.clientHeight);
    if (!dx && !dy) return;
    const point = {
      left: clamp(viewport.scrollLeft + dx, 0, 2 * MAX_WINDOW_SIZE),
      top: clamp(viewport.scrollTop + dy, 0, 2 * MAX_WINDOW_SIZE),
    };
    if (point.left === viewport.scrollLeft && point.top === viewport.scrollTop) return;
    makeRoom(point);
    scrollTo(point);
    updateGesture(active);
    frame = requestAnimationFrame(autoScroll);
  }

  function finishGesture(event?: PointerEvent) {
    const active = gesture;
    if (!active || (event && event.pointerId !== active.id)) return;
    gesture = null;
    cancelAnimationFrame(frame);
    frame = 0;
    viewport.removeAttribute('data-panning');
    viewport.removeAttribute('data-window-drag');
    if (viewport.hasPointerCapture(active.id)) viewport.releasePointerCapture(active.id);
    if (active.kind !== 'pan' && active.moved) save();
  }

  function setPan(enabled: boolean) {
    if (pan !== enabled) finishGesture();
    pan = enabled;
    viewport.toggleAttribute('data-pan', enabled);
  }

  function pointerDown(event: PointerEvent) {
    if (!(event.target instanceof Element) || event.target.closest('dialog[open]')) return;
    if (pan) {
      event.preventDefault();
      event.stopPropagation();
    }
    if (gesture || event.button !== 0 || !event.isPrimary || (!pan && event.defaultPrevented)) return;
    preventClick = false;
    const owner = event.target.closest<HTMLElement>('[data-window]')?.dataset.window;
    if (!pan && windowName(owner)) raise(owner);
    const handle = pan ? null : findHandle(event.target);
    if (!handle && !pan) return;
    event.preventDefault();
    if (handle) handle.element.focus({ preventScroll: true });
    const client = { left: event.clientX, top: event.clientY };
    const base = { id: event.pointerId, startClient: client, client, startScroll: currentScroll(), scale: scaleFor(viewport, viewport.getBoundingClientRect()), moved: false };
    gesture = handle ? { ...base, ...handle, startBounds: arrangement.windows[handle.name] } : { ...base, kind: 'pan' };
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
    updateGesture(active);
    if (!frame && active.kind !== 'pan' && active.moved) frame = requestAnimationFrame(autoScroll);
  }, { signal });
  for (const event of ['pointerup', 'pointercancel', 'lostpointercapture'] as const) viewport.addEventListener(event, finishGesture, { signal });
  viewport.addEventListener('click', event => {
    if (event.target instanceof Element && event.target.closest('dialog[open]')) return;
    if (event.detail === 0 || !pan && !preventClick) return;
    preventClick = false;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, { capture: true, signal });
  viewport.addEventListener('focusin', event => {
    if (!(event.target instanceof Element) || event.target.closest('dialog[open]')) return;
    const owner = event.target.closest<HTMLElement>('[data-window]')?.dataset.window;
    if (windowName(owner)) raise(owner);
  }, { signal });
  viewport.addEventListener('keydown', event => {
    const offset = ARROWS[event.key];
    if (!offset || event.defaultPrevented || gesture || !(event.target instanceof Element)) return;
    if (event.target.closest('dialog[open]')) return;
    const handle = findHandle(event.target);
    if (!handle) return;
    event.preventDefault();
    event.stopPropagation();
    const step = event.shiftKey ? 32 : event.altKey ? 1 : 16;
    const delta = { left: offset.left * step, top: offset.top * step };
    arrangement.windows[handle.name] = adjust(handle, arrangement.windows[handle.name], delta);
    arrangement.front = handle.name;
    save();
    paint();
    revealHandle(handle.element);
  }, { signal });

  const observer = new ResizeObserver(restartSizing);
  observer.observe(viewport);
  paint();

  return {
    getSize(name: FloatingWindowName): Size {
      const { width, height } = arrangement.windows[name];
      return { width, height };
    },
    resize(name: FloatingWindowName, width: number, height: number) {
      if (!Number.isFinite(width) || !Number.isFinite(height)) return;
      arrangement.windows[name] = constrain(name, { ...arrangement.windows[name], width, height });
      arrangement.front = name;
      save();
      paint();
    },
    jump(name: FloatingWindowName) {
      if (!visible(name)) return;
      raise(name);
      const bounds = arrangement.windows[name];
      const revealRight = getComputedStyle(panels[name]).direction === 'rtl' && bounds.width > viewport.clientWidth;
      const left = revealRight ? bounds.left + bounds.width - viewport.clientWidth + MARGIN : bounds.left - MARGIN;
      const point = { left: Math.max(0, left), top: Math.max(0, bounds.top - MARGIN) };
      makeRoom(point);
      scrollTo(point);
    },
    reset() {
      finishGesture();
      customized = false;
      extra = { width: 0, height: 0 };
      arrangement = initialArrangement(viewport, panels.device, aspect);
      saveArrangement(storageKey, null);
      scrollTo({ left: 0, top: 0 });
      paint();
    },
    setPan,
    dispose() {
      listeners.abort();
      observer.disconnect();
      finishGesture();
      viewport.removeAttribute('data-pan');
      for (const name of WINDOW_NAMES) {
        const panel = panels[name];
        for (const property of ['left', 'top', 'width', 'height', 'z-index']) panel.style.removeProperty(property);
        panel.removeAttribute('data-front');
      }
      canvas.style.removeProperty('width');
      canvas.style.removeProperty('height');
    },
  };
}

/** Owns free window geometry and active gestures without remounting the session media. */
export function useFloatingSessionWorkspace({ active, userId, aspect, viewportRef, canvasRef, deviceRef, toolsRef }: WorkspaceOptions) {
  const workspace = useRef<ReturnType<typeof createWorkspace> | null>(null);
  const panRequested = useRef(false);
  const ratio = Number.isFinite(aspect) && aspect > 0 ? Math.max(.0001, Math.round(aspect * 10_000) / 10_000) : DEFAULT_ASPECT;

  useLayoutEffect(() => {
    if (!active) {
      panRequested.current = false;
      return;
    }
    const viewport = viewportRef.current;
    const canvas = canvasRef.current;
    const device = deviceRef.current;
    const tools = toolsRef.current;
    if (!viewport || !canvas || !device || !tools) return;
    const storageKey = `rdf-session-floating-v1:${encodeURIComponent(userId)}:${ratio.toFixed(4)}`;
    const controller = createWorkspace(viewport, canvas, { device, tools }, ratio, storageKey);
    workspace.current = controller;
    controller.setPan(panRequested.current);
    return () => {
      controller.dispose();
      workspace.current = null;
    };
  }, [active, ratio, userId, viewportRef, canvasRef, deviceRef, toolsRef]);

  return useMemo(() => ({
    getSize: (name: FloatingWindowName) => workspace.current?.getSize(name) ?? null,
    resize: (name: FloatingWindowName, width: number, height: number) => workspace.current?.resize(name, width, height),
    jump: (name: FloatingWindowName) => workspace.current?.jump(name),
    reset: () => workspace.current?.reset(),
    setPan: (enabled: boolean) => {
      if (!workspace.current) return;
      panRequested.current = enabled;
      workspace.current.setPan(enabled);
    },
  }), []);
}
