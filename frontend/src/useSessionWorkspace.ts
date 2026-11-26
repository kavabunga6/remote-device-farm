import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type RefObject } from 'react';

const CONSOLE_WIDTH_KEY = 'rdf-console-width';
const LANDSCAPE_CONSOLE_WIDTH_KEY = 'rdf-console-width-landscape';
const CONSOLE_HEIGHT_KEY = 'rdf-console-height';

type LayoutMode = 'split' | 'desk';
type WorkspaceMode = LayoutMode | 'screen' | 'tools';

function layoutMode(saved: string | null): LayoutMode | undefined {
  if (saved === 'split' || saved === 'float' || saved === 'dock') return 'split';
  if (saved === 'desk') return 'desk';
}

function readDefaultMode(key: string): LayoutMode | undefined {
  try {
    return layoutMode(window.localStorage.getItem(key));
  } catch { /* Storage may be unavailable. */ }
  return undefined;
}

function readSessionMode(key: string): WorkspaceMode | undefined {
  try {
    const saved = window.sessionStorage.getItem(key);
    return saved === 'screen' || saved === 'tools' ? saved : layoutMode(saved);
  } catch { /* Storage may be unavailable. */ }
  return undefined;
}

function readDimension(key: string, fallback: number, min: number, max: number): number {
  try {
    const value = Number(window.localStorage.getItem(key));
    return Number.isFinite(value) && value >= min && value <= max ? value : fallback;
  } catch {
    return fallback;
  }
}

function saveDimension(key: string, value: number): void {
  try { window.localStorage.setItem(key, String(value)); } catch { /* Storage may be unavailable. */ }
}

type ResizePointer = PointerEvent<HTMLDivElement>;
type ResizeDrag = { id: number; target: HTMLDivElement; key: string; start: number; value: number | null };
type ConsoleDimension = 'width' | 'height';

function completeResize(ref: RefObject<ResizeDrag | null>, event?: ResizePointer) {
  const drag = ref.current;
  if (!drag || event && (drag.id !== event.pointerId || drag.target !== event.currentTarget)) return;
  ref.current = null;
  if (drag.target.hasPointerCapture(drag.id)) drag.target.releasePointerCapture(drag.id);
  if (drag.value !== null) saveDimension(drag.key, drag.value);
}

function isResizing(ref: RefObject<ResizeDrag | null>) {
  const drag = ref.current;
  if (!drag) return false;
  if (drag.target.isConnected && drag.target.hasPointerCapture(drag.id)) return true;
  completeResize(ref);
  return false;
}

export function useWorkspaceDimension(key: string, fallback: number, min: number, max: number, enabled = true) {
  const [value, setValue] = useState(() => readDimension(key, fallback, min, max));
  const drag = useRef<(ResizeDrag & { offset: (event: ResizePointer) => number }) | null>(null);
  useLayoutEffect(() => {
    setValue(readDimension(key, fallback, min, max));
  }, [key, fallback, min, max]);
  useLayoutEffect(() => () => completeResize(drag), [enabled, key]);
  const clamp = (next: number) => Math.max(min, Math.min(max, Math.round(next)));
  const endResize = (event: ResizePointer) => completeResize(drag, event);
  const pointerHandlers = (getOffset: (event: ResizePointer) => (move: ResizePointer) => number) => ({
    onPointerDown(event: ResizePointer) {
      if (event.button !== 0 || !event.isPrimary || !enabled || isResizing(drag)) return;
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      event.currentTarget.focus({ preventScroll: true });
      drag.current = { id: event.pointerId, target: event.currentTarget, key, start: value, value: null, offset: getOffset(event) };
    },
    onPointerMove(event: ResizePointer) {
      const active = drag.current;
      if (!active || active.id !== event.pointerId || active.target !== event.currentTarget) return;
      const next = clamp(active.start + active.offset(event));
      if (!Number.isFinite(next) || next === (active.value ?? active.start)) return;
      active.value = next;
      setValue(next);
    },
    onPointerUp: endResize,
    onPointerCancel: endResize,
    onLostPointerCapture: endResize,
  });
  const resizeWithKeyboard = (event: KeyboardEvent<HTMLDivElement>, step: number, increase: string[], decrease: string[]) => {
    const { key: pressed } = event;
    if (!['Home', 'End', ...increase, ...decrease].includes(pressed)) return;
    event.preventDefault();
    if (!enabled || isResizing(drag)) return;
    const next = clamp(pressed === 'Home' ? min : pressed === 'End' ? max : value + (increase.includes(pressed) ? step : -step));
    setValue(next);
    saveDimension(key, next);
  };
  return { value, min, max, pointerHandlers, resizeWithKeyboard };
}

/** Measures the session workspace and owns its persisted resize controls. */
export function useSessionWorkspace({ size, horizontalControls, toolTab, isPreparing, shared, userId, sessionId, terminalOutputRef }: {
  size: { width: number; height: number };
  horizontalControls: boolean;
  toolTab: string;
  isPreparing: boolean;
  shared: boolean;
  userId: string;
  sessionId: string;
  terminalOutputRef: RefObject<HTMLDivElement | null>;
}) {
  const defaultModeKey = 'rdf-session-default-view:' + userId;
  const sessionModeKey = `rdf-session-view:${encodeURIComponent(userId)}:${encodeURIComponent(sessionId)}`;
  const [defaultWorkspaceMode, setDefaultWorkspaceMode] = useState(() => readDefaultMode(defaultModeKey));
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode>(() => readSessionMode(sessionModeKey) ?? defaultWorkspaceMode ?? 'split');
  const changeWorkspaceMode = useCallback((mode: WorkspaceMode) => {
    if (shared) return;
    setWorkspaceMode(mode);
    try { window.sessionStorage.setItem(sessionModeKey, mode); } catch { /* Storage may be unavailable. */ }
  }, [sessionModeKey, shared]);
  const activeWorkspaceMode = shared ? 'split' : workspaceMode;
  const deskActive = activeWorkspaceMode === 'desk' && !isPreparing;
  const defaultView = activeWorkspaceMode === defaultWorkspaceMode;
  const canSaveDefaultLayout = !shared && (activeWorkspaceMode === 'split' || activeWorkspaceMode === 'desk');
  const saveDefaultWorkspaceMode = () => {
    if (!canSaveDefaultLayout) return;
    const next = defaultView ? undefined : activeWorkspaceMode;
    setDefaultWorkspaceMode(next);
    try {
      if (next) window.localStorage.setItem(defaultModeKey, next);
      else window.localStorage.removeItem(defaultModeKey);
    } catch { /* Storage may be unavailable. */ }
  };
  const landscape = size.width > size.height;
  const widthKey = landscape ? LANDSCAPE_CONSOLE_WIDTH_KEY : CONSOLE_WIDTH_KEY;
  const [consoleWidths, setConsoleWidths] = useState<Record<string, number | null>>(() => ({
    [CONSOLE_WIDTH_KEY]: readDimension(CONSOLE_WIDTH_KEY, 0, 320, 5000) || null,
    [LANDSCAPE_CONSOLE_WIDTH_KEY]: readDimension(LANDSCAPE_CONSOLE_WIDTH_KEY, 0, 320, 5000) || null,
  }));
  const defaultConsoleWidth = window.innerWidth >= 1800 ? 600 : window.innerWidth >= 1200 ? 460 : 470;
  const consoleWidth = consoleWidths[widthKey] ?? defaultConsoleWidth;
  const consoleResized = consoleWidths[widthKey] !== null;
  const setConsoleWidth = (width: number | null) => setConsoleWidths(previous => ({ ...previous, [widthKey]: width }));
  const [consoleHeight, setConsoleHeight] = useState(() => readDimension(CONSOLE_HEIGHT_KEY, 620, 180, 1000));
  const [consoleHeightResized, setConsoleHeightResized] = useState(() => {
    try { return window.localStorage.getItem(CONSOLE_HEIGHT_KEY) !== null; } catch { return false; }
  });
  const [visibleConsoleSize, setVisibleConsoleSize] = useState({ width: 0, height: 0 });
  const workspaceRef = useRef<HTMLDivElement>(null);
  const consoleResize = useRef<(ResizeDrag & { dimension: ConsoleDimension; origin: number; scale: number }) | null>(null);
  useLayoutEffect(() => () => completeResize(consoleResize), [activeWorkspaceMode, isPreparing, shared, toolTab, widthKey]);
  const [stageSize, setStageSize] = useState({ width: 900, height: 650 });
  const [availableStageHeight, setAvailableStageHeight] = useState(650);
  const [viewerInsets, setViewerInsets] = useState(0);
  const screenRef = useRef<HTMLDivElement>(null);
  const workspaceGap = () => workspaceRef.current ? Number.parseFloat(getComputedStyle(workspaceRef.current).columnGap) || 0 : 24;
  const maxConsoleWidth = () => Math.max(320, Math.floor((workspaceRef.current?.clientWidth ?? 1400) - 320 - workspaceGap()));
  const minConsoleWidth = () => {
    const workspace = workspaceRef.current;
    const viewer = Number.parseFloat(workspace?.style.getPropertyValue('--viewer-width') || '') || 320;
    const width = workspace?.clientWidth ?? 1400;
    const gap = workspaceGap();
    const viewerFit = size.width > size.height ? viewer : Math.min(viewer, Math.max(320, width / 2 - gap));
    return Math.min(maxConsoleWidth(), Math.max(320, Math.round(width - viewerFit - gap)));
  };
  const maxConsoleHeight = () => {
    const viewport = window.innerHeight;
    if (window.innerWidth <= 1200) return Math.max(180, Math.min(420, Math.floor(viewport * 0.44)));
    const fitted = Number.parseFloat(workspaceRef.current?.style.getPropertyValue('--session-console-output-fit') || '');
    if (Number.isFinite(fitted)) return Math.max(180, Math.min(1000, fitted));
    return Math.min(1000, window.innerHeight <= 800 ? Math.max(180, viewport - 430) : Math.max(200, viewport - 400));
  };

  const resetConsoleSize = () => {
    completeResize(consoleResize);
    setConsoleWidth(null);
    setConsoleHeightResized(false);
    setConsoleHeight(620);
    try {
      window.localStorage.removeItem(widthKey);
      window.localStorage.removeItem(CONSOLE_HEIGHT_KEY);
    } catch { /* Storage may be unavailable. */ }
  };

  const visibleSize = (dimension: ConsoleDimension) => dimension === 'width'
    ? workspaceRef.current?.querySelector<HTMLElement>('.terminal-panel')?.offsetWidth ?? consoleWidth
    : terminalOutputRef.current?.offsetHeight ?? consoleHeight;
  const minSize = (dimension: ConsoleDimension) => dimension === 'width' ? minConsoleWidth() : 180;
  const maxSize = (dimension: ConsoleDimension) => dimension === 'width' ? maxConsoleWidth() : maxConsoleHeight();
  const clampSize = (dimension: ConsoleDimension, value: number) => Math.max(minSize(dimension), Math.min(maxSize(dimension), Math.round(value)));
  const resizeConsole = (dimension: ConsoleDimension, value: number) => {
    if (dimension === 'width') setConsoleWidth(value);
    else { setConsoleHeightResized(true); setConsoleHeight(value); }
  };
  const resizeConsoleWithKeyboard = (event: KeyboardEvent<HTMLDivElement>, dimension: ConsoleDimension) => {
    const increase = dimension === 'width' ? 'ArrowLeft' : 'ArrowDown';
    const decrease = dimension === 'width' ? 'ArrowRight' : 'ArrowUp';
    if (!['Home', 'End', increase, decrease].includes(event.key)) return;
    event.preventDefault();
    if (isResizing(consoleResize)) return;
    const next = event.key === 'Home' ? minSize(dimension) : event.key === 'End' ? maxSize(dimension)
      : clampSize(dimension, visibleSize(dimension) + (event.key === increase ? 24 : -24));
    resizeConsole(dimension, next);
    saveDimension(dimension === 'width' ? widthKey : CONSOLE_HEIGHT_KEY, next);
  };

  function startConsoleResize(event: ResizePointer, dimension: ConsoleDimension) {
    if (event.button !== 0 || !event.isPrimary || isResizing(consoleResize)) return;
    event.preventDefault();
    const workspace = workspaceRef.current;
    const scale = workspace?.offsetWidth ? workspace.getBoundingClientRect().width / workspace.offsetWidth : 1;
    const width = dimension === 'width';
    event.currentTarget.setPointerCapture(event.pointerId);
    consoleResize.current = {
      id: event.pointerId, target: event.currentTarget, dimension, scale: scale || 1,
      key: width ? widthKey : CONSOLE_HEIGHT_KEY, origin: width ? event.clientX : event.clientY,
      start: clampSize(dimension, visibleSize(dimension)), value: null,
    };
    event.currentTarget.focus({ preventScroll: true });
  }
  function moveConsoleResize(event: ResizePointer) {
    const drag = consoleResize.current;
    if (!drag || drag.id !== event.pointerId || drag.target !== event.currentTarget) return;
    const delta = drag.dimension === 'width' ? drag.origin - event.clientX : event.clientY - drag.origin;
    const next = clampSize(drag.dimension, drag.start + delta / drag.scale);
    if (next === (drag.value ?? drag.start)) return;
    drag.value = next;
    resizeConsole(drag.dimension, next);
  }
  const endConsoleResize = (event: ResizePointer) => completeResize(consoleResize, event);

  useEffect(() => {
    const stage = screenRef.current;
    if (!stage) return;
    const observer = new ResizeObserver(entries => {
      const { width, height } = entries[0].contentRect;
      if (!width || !height) return;
      setStageSize(previous => previous.width === width && previous.height === height ? previous : { width, height });
      // Include the rail and the stage padding in the desired card width.
      setViewerInsets(Math.round((stage.parentElement?.clientWidth ?? width) - width));
    });
    observer.observe(stage);
    return () => observer.disconnect();
  }, [isPreparing]);

  useLayoutEffect(() => {
    const workspace = workspaceRef.current;
    if (!workspace) return;
    const layout = workspace.closest<HTMLElement>('.session-layout');
    let frame = 0;
    const setPx = (name: string, value: number) => {
      const pixels = Math.floor(value) + 'px';
      if (workspace.style.getPropertyValue(name) !== pixels) workspace.style.setProperty(name, pixels);
    };
    const measure = () => {
      // The title, expiry warnings and shared-access banner may all change the workspace's top edge.
      const top = workspace.getBoundingClientRect().top + window.scrollY;
      // DOM rectangles include the user's CSS zoom. Values written back into style properties
      // must use layout pixels, otherwise a 125% interface enlarges the fitted height twice.
      const scale = Number.parseFloat(getComputedStyle(document.getElementById('root') ?? workspace).zoom) || 1;
      const page = workspace.closest<HTMLElement>('.session-main');
      const bottomPadding = page ? Number.parseFloat(getComputedStyle(page).paddingBottom) : 16;
      const available = Math.max(300, ((window.visualViewport?.height ?? window.innerHeight) - top) / scale - bottomPadding);
      const stage = screenRef.current;
      const viewer = workspace.querySelector<HTMLElement>('.viewer-panel');
      if (stage && viewer) {
        // Sum the rows around the stage instead of subtracting heights: the panel can be stretched to the
        // console's height, which would otherwise be counted as chrome and shrink the device.
        let chrome = 2;
        for (const child of Array.from(viewer.children)) {
          if (child === stage || child.classList.contains('floating-window-resize-handle') ||
            (!horizontalControls && child.classList.contains('device-controls'))) continue;
          if (child instanceof HTMLElement) chrome += child.offsetHeight;
        }
        setPx('--session-viewer-chrome', chrome);
        const style = getComputedStyle(stage);
        const padding = Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom);
        // Use viewport space, not the fitted landscape stage, to avoid a resize feedback loop.
        setAvailableStageHeight(Math.max(0, available - chrome - padding));
      }
      setPx('--session-fit-height', available);
      const output = terminalOutputRef.current;
      const terminal = workspace.querySelector<HTMLElement>('.terminal-panel');
      if (terminal && terminal.getBoundingClientRect().width > 0) {
        const terminalBox = terminal.getBoundingClientRect();
        const outputBox = output?.getBoundingClientRect();
        const width = Math.round(terminalBox.width / scale);
        const height = outputBox?.height ? Math.round(outputBox.height / scale) : null;
        if (outputBox?.height) {
          const chrome = (terminalBox.height - outputBox.height) / scale;
          setPx('--session-console-output-fit', Math.max(180, available - chrome));
        }
        setVisibleConsoleSize(previous => previous.width === width && (height === null || previous.height === height)
          ? previous : { width, height: height ?? previous.height });
      }
    };
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(measure); };
    const observer = new ResizeObserver(schedule);
    if (layout) observer.observe(layout);
    const heading = layout?.querySelector('.session-heading');
    if (heading) observer.observe(heading);
    const viewer = workspace.querySelector<HTMLElement>('.viewer-panel');
    if (viewer) observer.observe(viewer);
    const terminal = workspace.querySelector<HTMLElement>('.terminal-panel');
    if (terminal) observer.observe(terminal);
    if (terminalOutputRef.current) observer.observe(terminalOutputRef.current);
    window.addEventListener('resize', schedule);
    window.visualViewport?.addEventListener('resize', schedule);
    schedule();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener('resize', schedule);
      window.visualViewport?.removeEventListener('resize', schedule);
    };
  }, [toolTab, activeWorkspaceMode, isPreparing, shared, horizontalControls]);
  const frameWidth = Math.max(1, size.width);
  const frameHeight = Math.max(1, size.height);
  const viewerWidth = Math.max(320, Math.ceil((landscape ? availableStageHeight : stageSize.height) * frameWidth / frameHeight + viewerInsets + 2));
  const displayScale = Math.min(Math.max(0, stageSize.width) / frameWidth, Math.max(0, stageSize.height) / frameHeight);

  return { activeWorkspaceMode, deskActive, changeWorkspaceMode, defaultView, canSaveDefaultLayout, saveDefaultWorkspaceMode,
    consoleWidth, consoleResized, consoleHeight, consoleHeightResized, visibleConsoleSize, workspaceRef, screenRef, viewerWidth, displayScale,
    minConsoleWidth, maxConsoleWidth, maxConsoleHeight, resetConsoleSize, resizeConsoleWithKeyboard,
    startWidthResize: (event: ResizePointer) => startConsoleResize(event, 'width'), moveWidthResize: moveConsoleResize, endWidthResize: endConsoleResize,
    startHeightResize: (event: ResizePointer) => startConsoleResize(event, 'height'), moveHeightResize: moveConsoleResize, endHeightResize: endConsoleResize,
  };
}
