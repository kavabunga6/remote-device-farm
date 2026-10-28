import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';

const CONSOLE_WIDTH_KEY = 'rdf-console-width';
const CONSOLE_HEIGHT_KEY = 'rdf-console-height';


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

/** Measures the session workspace and owns its persisted resize controls. */
export function useSessionWorkspace({ size, toolTab, isPreparing, terminalOutputRef }: {
  size: { width: number; height: number };
  toolTab: string;
  isPreparing: boolean;
  terminalOutputRef: RefObject<HTMLDivElement | null>;
}) {
  const [workspaceMode, setWorkspaceMode] = useState<'split' | 'screen' | 'tools'>('split');
  const [compactWorkspace, setCompactWorkspace] = useState(() => window.matchMedia('(max-width: 1200px)').matches);
  const activeWorkspaceMode = compactWorkspace && workspaceMode === 'split' ? 'screen' : workspaceMode;
  useEffect(() => {
    const media = window.matchMedia('(max-width: 1200px)');
    const update = () => setCompactWorkspace(media.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  const changeWorkspaceMode = (mode: 'split' | 'screen' | 'tools') => setWorkspaceMode(mode);
  const [consoleWidth, setConsoleWidth] = useState(() => {
    const viewport = window.innerWidth;
    const fallback = viewport >= 1800 ? 600 : viewport >= 1200 ? 460 : 470;
    return readDimension(CONSOLE_WIDTH_KEY, fallback, 320, 5000);
  });
  const [consoleResized, setConsoleResized] = useState(() => {
    try { return window.localStorage.getItem(CONSOLE_WIDTH_KEY) !== null; } catch { return false; }
  });
  const [consoleHeight, setConsoleHeight] = useState(() => readDimension(CONSOLE_HEIGHT_KEY, 620, 180, 1000));
  const [consoleHeightResized, setConsoleHeightResized] = useState(() => {
    try { return window.localStorage.getItem(CONSOLE_HEIGHT_KEY) !== null; } catch { return false; }
  });
  const [visibleConsoleSize, setVisibleConsoleSize] = useState({ width: 0, height: 0 });
  const workspaceRef = useRef<HTMLDivElement>(null);
  const widthResizeRef = useRef<{ pointerId: number; x: number; start: number; value: number } | null>(null);
  const heightResizeRef = useRef<{ pointerId: number; y: number; start: number; value: number } | null>(null);
  const [stageSize, setStageSize] = useState({ width: 900, height: 650 });
  const [stageHorizontalPadding, setStageHorizontalPadding] = useState(0);
  const screenRef = useRef<HTMLDivElement>(null);
  const workspaceGap = () => workspaceRef.current ? Number.parseFloat(getComputedStyle(workspaceRef.current).columnGap) || 0 : 24;
  const maxConsoleWidth = () => Math.max(320, Math.floor((workspaceRef.current?.clientWidth ?? 1400) - 320 - workspaceGap()));
  const minConsoleWidth = () => {
    const workspace = workspaceRef.current;
    const viewer = Number.parseFloat(workspace?.style.getPropertyValue('--viewer-width') || '') || 320;
    return Math.min(maxConsoleWidth(), Math.max(320, Math.round((workspace?.clientWidth ?? 1400) - viewer - workspaceGap())));
  };
  const clampConsoleWidth = (value: number) => Math.max(minConsoleWidth(), Math.min(maxConsoleWidth(), Math.round(value)));
  const maxConsoleHeight = () => {
    const viewport = window.innerHeight;
    if (window.innerWidth <= 1200) return Math.max(180, Math.min(420, Math.floor(viewport * 0.44)));
    const fitted = Number.parseFloat(workspaceRef.current?.style.getPropertyValue('--session-console-output-fit') || '');
    if (Number.isFinite(fitted)) return Math.max(180, Math.min(1000, fitted));
    return Math.min(1000, window.innerHeight <= 800 ? Math.max(180, viewport - 430) : Math.max(200, viewport - 400));
  };
  const clampConsoleHeight = (value: number) => Math.max(180, Math.min(maxConsoleHeight(), Math.round(value)));

  const resetConsoleSize = () => {
    setConsoleResized(false);
    setConsoleHeightResized(false);
    setConsoleHeight(620);
    try {
      window.localStorage.removeItem(CONSOLE_WIDTH_KEY);
      window.localStorage.removeItem(CONSOLE_HEIGHT_KEY);
    } catch { /* Storage may be unavailable. */ }
  };

  const resizeConsoleWithKeyboard = (event: React.KeyboardEvent<HTMLDivElement>, dimension: 'width' | 'height') => {
    const increase = dimension === 'width' ? 'ArrowLeft' : 'ArrowDown';
    const decrease = dimension === 'width' ? 'ArrowRight' : 'ArrowUp';
    if (!['Home', 'End', increase, decrease].includes(event.key)) return;
    event.preventDefault();
    const current = dimension === 'width'
      ? workspaceRef.current?.querySelector<HTMLElement>('.terminal-panel')?.getBoundingClientRect().width ?? consoleWidth
      : terminalOutputRef.current?.getBoundingClientRect().height ?? consoleHeight;
    const minimum = dimension === 'width' ? minConsoleWidth() : 180;
    const maximum = dimension === 'width' ? maxConsoleWidth() : maxConsoleHeight();
    const next = Math.max(minimum, Math.min(maximum, Math.round(event.key === 'Home' ? minimum : event.key === 'End' ? maximum : current + (event.key === increase ? 24 : -24))));
    if (dimension === 'width') { setConsoleResized(true); setConsoleWidth(next); }
    else { setConsoleHeightResized(true); setConsoleHeight(next); }
    saveDimension(dimension === 'width' ? CONSOLE_WIDTH_KEY : CONSOLE_HEIGHT_KEY, next);
  };

  const startWidthResize = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.focus();
    const visibleWidth = clampConsoleWidth(workspaceRef.current?.querySelector<HTMLElement>('.terminal-panel')?.getBoundingClientRect().width ?? consoleWidth);
    setConsoleResized(true); setConsoleWidth(visibleWidth);
    widthResizeRef.current = { pointerId: event.pointerId, x: event.clientX, start: visibleWidth, value: visibleWidth };
  };
  const moveWidthResize = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = widthResizeRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    drag.value = clampConsoleWidth(drag.start + drag.x - event.clientX);
    setConsoleWidth(drag.value);
  };
  const endWidthResize = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = widthResizeRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    saveDimension(CONSOLE_WIDTH_KEY, drag.value);
    widthResizeRef.current = null;
  };
  const startHeightResize = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.focus();
    const visibleHeight = terminalOutputRef.current?.getBoundingClientRect().height ?? Math.min(consoleHeight, maxConsoleHeight());
    setConsoleHeightResized(true);
    setConsoleHeight(visibleHeight);
    heightResizeRef.current = { pointerId: event.pointerId, y: event.clientY, start: visibleHeight, value: visibleHeight };
  };
  const moveHeightResize = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = heightResizeRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    drag.value = clampConsoleHeight(drag.start + event.clientY - drag.y);
    setConsoleHeight(drag.value);
  };
  const endHeightResize = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = heightResizeRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    saveDimension(CONSOLE_HEIGHT_KEY, drag.value);
    heightResizeRef.current = null;
  };

  useEffect(() => {
    const stage = screenRef.current;
    if (!stage) return;
    const observer = new ResizeObserver(entries => {
      const { width, height } = entries[0].contentRect;
      setStageSize({ width, height });
      const style = getComputedStyle(stage);
      setStageHorizontalPadding(parseFloat(style.paddingLeft) + parseFloat(style.paddingRight));
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
          if (child === stage) continue;
          const box = child.getBoundingClientRect();
          // The vertical control bar overlays the stage; the single-row bar takes its own row.
          if (child.classList.contains('device-controls') && box.height >= box.width) continue;
          chrome += box.height / scale;
        }
        setPx('--session-viewer-chrome', chrome);

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
  }, [toolTab, activeWorkspaceMode, workspaceMode, isPreparing]);
  const frameWidth = Math.max(1, size.width);
  const frameHeight = Math.max(1, size.height);
  const viewerWidth = Math.max(320, Math.ceil(stageSize.height * frameWidth / frameHeight + stageHorizontalPadding + 2));
  const displayScale = Math.min(Math.max(0, stageSize.width) / frameWidth, Math.max(0, stageSize.height) / frameHeight);

  return { workspaceMode, activeWorkspaceMode, compactWorkspace, changeWorkspaceMode, consoleWidth, consoleResized, consoleHeight, consoleHeightResized, visibleConsoleSize, workspaceRef, screenRef, viewerWidth, displayScale, minConsoleWidth, maxConsoleWidth, maxConsoleHeight, resetConsoleSize, resizeConsoleWithKeyboard, startWidthResize, moveWidthResize, endWidthResize, startHeightResize, moveHeightResize, endHeightResize };
}
