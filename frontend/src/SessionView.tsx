import { TranslatedText } from './TranslatedText';
import { useSessionAdb } from './useSessionAdb';
import { useSessionWorkspace, useWorkspaceDimension } from './useSessionWorkspace';
import { useFloatingSessionWorkspace, type WorkspaceWindowName } from './useFloatingSessionWorkspace';
import { FloatingWindowMove, FloatingWindowResizeHandles, WorkspaceDefaultButton } from './FloatingWorkspaceControls';
import { DESK_TOOL_DRAG_TYPE, DeskToolWidget, deskWidgetPlacement, useDeskWidgetLayout } from './DeskToolWidget';
import { DeskWindowOverview, type DeskOverviewWindow } from './DeskWindowOverview';
import { readDeskLayoutTemplateForSession, saveDeskLayoutTemplate } from './deskLayoutTemplate';
import { downloadFile as downloadKeyFile } from './browser-files';
import { bindHorizontalWheel } from './horizontal-wheel';
import { can } from './permissions';
import { localizeText, getDirection, getLocale, t } from './i18n';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type DragEvent, type ReactNode } from 'react';
import { api, ApiError, KNOWN_ERRORS, type DeviceSession, type Profile, type User } from './api';
import { Icon } from './icons';
import { useNotifications } from './notifications';
import { lastLaunch } from './CreateSessionModal';
import { SessionStartupProgress } from './SessionStartupProgress';
import { SessionStatusBadge } from './SessionStatusBadge';
import { LogcatPanel } from './LogcatPanel';
import { DeviceInfoPanel } from './DeviceInfoPanel';
import { EnvPanel } from './tools/EnvPanel';
import { NetworkPanel } from './tools/NetworkPanel';
import { PerformancePanel } from './tools/PerformancePanel';
import { WebViewsPanel } from './tools/WebViewsPanel';
import { AppsPanel } from './tools/AppsPanel';
import { ShareControl, SharedBanner } from './ShareControl';
import { accessOf } from './share-api';
import { useSessionAudience } from './useSessionAudience';
import { audienceDescription } from './session-audience';
import { CONSOLE_CATEGORIES, getConsoleCommands } from './console-commands';
import { useSessionConsole } from './useSessionConsole';
import { useSessionCapture } from './useSessionCapture';
import { useSessionStream, type ConnectionMode } from './useSessionStream';
import { SessionAudioControl, SessionMediaStatus } from './SessionMediaStatus';
import { DeviceControls, useDeviceControlsPosition } from './DeviceControls';
import { DeviceTextInput } from './DeviceTextInput';
import { hasCapability, type Capability } from './devices';
import './ConsoleResize.css';
import './FloatingWorkspace.css';
import { useTouchIndicator } from './useTouchIndicator';
import './TouchIndicator.css';

const TOOL_TAB_IDS = ['console', 'logs', 'info', 'env', 'apps', 'traffic', 'webviews', 'performance'] as const;
type ToolTabId = typeof TOOL_TAB_IDS[number];
// Each tool needs a device capability; physical phones may offer fewer than emulators.
function toolTabs(): ReadonlyArray<readonly [ToolTabId, string, Capability]> { return [
  ['console', t('ui.a58f47dbc474'), 'shell'], ['logs', t('ui.1ebab145dea4'), 'logs'], ['info', t('ui.bd38d43cf415'), 'device-info'], ['env', t('ui.d606a9df2b84'), 'env'], ['apps', t('ui.39c4b42c8d11'), 'install'], ['traffic', t('networkInspector.title'), 'network'], ['webviews', t('webviews.title'), 'shell'],
  ['performance', t('performance.title'), 'shell'],
]; }

function focusToolTab(tab: HTMLButtonElement) {
  const tabs = tab.parentElement;
  tab.focus({ preventScroll: true });
  if (!tabs || tabs.scrollWidth <= tabs.clientWidth) return;
  const strip = tabs.getBoundingClientRect();
  const scale = strip.width / tabs.offsetWidth || 1;
  const start = strip.left + tabs.clientLeft * scale;
  const end = start + tabs.clientWidth * scale;
  const bounds = tab.getBoundingClientRect();
  const offset = bounds.left < start ? bounds.left - start : Math.max(0, bounds.right - end);
  if (offset) tabs.scrollBy({ left: offset / scale, behavior: 'instant' });
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : t('ui.b9f61453dd3f');
}

function timeLabel(value: string | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : new Intl.DateTimeFormat(getLocale(), { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function hasVisibleOverlay() {
  return Array.from(document.querySelectorAll('dialog[open], [popover]:popover-open, [aria-modal=true]'))
    .some(element => element.getClientRects().length > 0);
}

export function SessionView({ sessionId, user, profiles, onBack, onNotFound, onRelease, onKill, onObserved, onUpdated }: {
  sessionId: string; user: User; profiles: Profile[]; onBack: () => void; onNotFound: (id: string) => void; onRelease: (session: DeviceSession) => void; onKill?: (session: DeviceSession) => void; onObserved: (session: DeviceSession) => void; onUpdated: () => void;
}) {
  const [session, setSession] = useState<DeviceSession | null>(null);
  const isPreparing = !session || session.status === 'starting';
  // Shared viewers (access view/control) get no owner tools; the server enforces this too.
  const access = accessOf(session);
  const shared = access === 'view' || access === 'control';
  const audience = useSessionAudience(session, user);
  const readOnly = access === 'view' || !can(user, 'sessions.control');
  const toolPermission: Record<ToolTabId, string> = { console: 'sessions.console', logs: 'sessions.logcat', info: 'sessions.view', env: 'sessions.env', apps: 'sessions.files', traffic: 'sessions.console', webviews: 'sessions.console', performance: 'sessions.console' };
  const toolAllowed = (id: ToolTabId) => can(user, toolPermission[id])
    && (id !== 'traffic' || (can(user, 'sessions.env') && session?.deviceKind !== 'usb-android'))
    && (id !== 'performance' || (!shared && (session?.deviceKind ?? 'emulator') === 'emulator'));
  const canReadEnvironment = session?.id === sessionId && session.status === 'running' && !shared && can(user, 'sessions.env') && hasCapability(session, 'env');
  const [sessionError, setSessionError] = useState('');
  const [busy, setBusy] = useState('');
  const { notify, notifyError } = useNotifications();
  const [recreate, setRecreate] = useState<'idle' | 'ask' | 'busy'>('idle');
  const canRecreate = Boolean(session && !shared && can(user, 'sessions.create') && can(user, 'sessions.stop') && session.ownerId === user.id && session.status === 'running' && (!session.deviceKind || session.deviceKind === 'emulator'));
  const recreateSession = async () => {
    if (!session) return;
    setRecreate('busy');
    try {
      await api.releaseSession(session.id);
      const saved = lastLaunch();
      const gpuMode = session.gpuMode ?? (saved.profileId === session.profileId ? saved.gpuMode : undefined);
      let created: DeviceSession | null = null;
      for (let attempt = 0; attempt < 20 && !created; attempt++) {
        try { created = await api.createSession(session.hostId, session.profileId, session.adbKeyId ?? null, gpuMode, {}, session.launchOptions); }
        catch (cause) {
          // The freed slot is handed back asynchronously; wait for it instead of failing.
          if (!(cause instanceof ApiError && cause.status === 409 && cause.message === KNOWN_ERRORS.no_free_slots)) throw cause;
          await new Promise(resolve => window.setTimeout(resolve, 1500));
        }
      }
      if (!created) throw new Error(t('ui.c5dfd40e013e'));
      window.location.hash = '/session/' + encodeURIComponent(created.id);
    } catch (cause) {
      setRecreate('idle');
      notifyError(t('ui.cdf3a4a1e59e'), cause);
    }
  };

  const {
    command, setCommand, shellHistory, setShellHistory, shellBusy,
    suggestionsOpen, setSuggestionsOpen, suggestionIndex, setSuggestionIndex,
    catalogOpen, setCatalogOpen, catalogQuery, setCatalogQuery, catalogCategory, setCatalogCategory,
    consoleNotice, setConsoleNotice, setHistoryIndex, commandInputRef, terminalOutputRef,
    suggestions, catalogResults, insertConsoleHint, runCommand, handleCommandKeyDown,
  } = useSessionConsole(sessionId, session?.status === 'running', !shared && can(user, 'sessions.console') && hasCapability(session, 'shell'));

  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState<string[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dragDepthRef = useRef(0);
  const categoryStripRef = useRef<HTMLDivElement>(null);
  const { adbPortAccess, adbPublicKey, setAdbPublicKey, adbUserKey, adbKeyLoaded, newAdbKey, setNewAdbKey, privateKeyDownloaded, setPrivateKeyDownloaded, publicKeyDownloaded, setPublicKeyDownloaded, showCustomAdbKey, setShowCustomAdbKey, confirmKeyRotation, setConfirmKeyRotation, adbBusy, adbError, setAdbError, adbMenuOpen, setAdbMenuOpen, adbCopied, adbMenuRef, closeAdbMenu, loadAdbPublicKey, requestAdbPortAccess, createAdbUserKey, revokeAdbPortAccess, copyAdbCommand } = useSessionAdb(sessionId, session, user);
  const [sessionActionsOpen, setSessionActionsOpen] = useState(false);
  const sessionMetadataRef = useRef<HTMLDetailsElement>(null);
  const pointerStartRef = useRef<{ x: number; y: number; time: number; pointerId: number; live: boolean; lastMoveAt: number; lastX: number; lastY: number } | null>(null);
  const audioEnabled = session?.audioEnabled ?? false;
  const networkEnabled = session?.networkEnabled !== false;
  const [imageFrameReady, setImageFrameReady] = useState(false);
  const [connectionMode, setConnectionMode] = useState<ConnectionMode>('websocket');
  const stream = useSessionStream(sessionId, audioEnabled, connectionMode);
  const isRunning = session?.status === 'running';
  const canControl = isRunning && !readOnly && stream.inputReady;
  const landscape = stream.size.width > stream.size.height;
  const profile = profiles.find(candidate => candidate.id === session?.profileId);
  const deviceType = session?.deviceType ?? profile?.deviceType;
  const resolution = /^(\d+)\s*[xх×]\s*(\d+)$/i.exec(profile?.resolution?.trim() ?? '');
  const largeDevice = deviceType === 'tv' || deviceType === 'desktop' || deviceType === 'automotive';
  const wideControls = largeDevice || (resolution ? Number(resolution[1]) > Number(resolution[2]) : landscape);
  const controlsScope = session?.deviceId == null
    ? `profile:${session?.profileId ?? ''}` : `physical:${deviceType ?? 'mobile'}`;
  const controlsPlacement = useDeviceControlsPosition(user.id, controlsScope, wideControls ? 'top' : 'left');
  const horizontalControls = controlsPlacement.edge === 'top' || controlsPlacement.edge === 'bottom';
  const [toolTab, setToolTab] = useState<ToolTabId>('console');
  const { activeWorkspaceMode, deskActive, changeWorkspaceMode, defaultView, canSaveDefaultLayout, saveDefaultWorkspaceMode,
    consoleWidth, consoleResized, consoleHeight, consoleHeightResized, visibleConsoleSize, workspaceRef, screenRef,
    viewerWidth, displayScale, minConsoleWidth, maxConsoleWidth, maxConsoleHeight, resetConsoleSize, resizeConsoleWithKeyboard,
    startWidthResize, moveWidthResize, endWidthResize, startHeightResize, moveHeightResize, endHeightResize,
  } = useSessionWorkspace({ size: stream.size, horizontalControls, toolTab, isPreparing, shared, userId: user.id, sessionId, terminalOutputRef });
  const deskTrigger = useRef<HTMLButtonElement>(null);
  const wasDeskActive = useRef(false);
  const [windowOverviewOpen, setWindowOverviewOpen] = useState(false);
  const floatingCanvasRef = useRef<HTMLDivElement>(null);
  const deskGridRef = useRef<HTMLDivElement>(null);
  const floatingDeviceRef = useRef<HTMLElement>(null);
  const floatingToolsRef = useRef<HTMLElement>(null);
  const widgetDockRef = useRef<HTMLDivElement>(null);
  const draggedTool = useRef<ToolTabId | null>(null);
  const [deskDragImage] = useState(() => {
    const image = new Image(1, 1);
    image.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
    return image;
  });
  const dragSurfaceRef = useRef<HTMLDivElement>(null);
  const [previewTool, setPreviewTool] = useState<ToolTabId | null>(null);
  const focusTool = useRef<ToolTabId | null>(null);
  const [savedDeskLayout] = useState(() => readDeskLayoutTemplateForSession(user.id, sessionId));
  const emulated = Boolean(session && session.deviceId == null && !shared);
  const layoutTemplate = emulated ? savedDeskLayout : null;
  const workspaceLayoutId = session
    ? (session.deviceId == null ? (layoutTemplate ? `session:${sessionId}` : `profile:${session.profileId}`) : `physical:${session.deviceType ?? 'mobile'}`)
    : undefined;
  const widgetLayout = useDeskWidgetLayout(user.id, workspaceLayoutId, TOOL_TAB_IDS, layoutTemplate);
  const floatingWorkspace = useFloatingSessionWorkspace({
    active: deskActive, userId: user.id, sessionId,
    layoutId: workspaceLayoutId, layoutTemplate,
    legacyDeviceId: session?.deviceId ?? undefined,
    aspect: stream.status === 'live' ? stream.size.width / Math.max(1, stream.size.height) : undefined,
    viewportRef: workspaceRef, canvasRef: floatingCanvasRef, deskGridRef, deviceRef: floatingDeviceRef, toolsRef: floatingToolsRef,
  });
  const { jump: jumpFloating, snapWidgetPlacement, clearAlignmentGuides, saveCamera } = floatingWorkspace;
  const leaveDesk = useCallback(() => {
    saveCamera();
    changeWorkspaceMode('split');
  }, [changeWorkspaceMode, saveCamera]);
  useEffect(() => {
    if (!deskActive) { setWindowOverviewOpen(false); return; }
    const handleOverviewShortcut = (event: KeyboardEvent) => {
      if (event.code !== 'KeyW' || !event.altKey || !event.shiftKey || event.ctrlKey || event.metaKey ||
        event.defaultPrevented || event.isComposing || event.repeat || document.fullscreenElement || draggedTool.current ||
        workspaceRef.current?.matches('[data-window-drag],[data-panning]')) return;
      if (!windowOverviewOpen && (hasVisibleOverlay() || (event.target instanceof Element &&
        event.target.closest('input, textarea, select, [contenteditable]:not([contenteditable=false])')))) return;
      event.preventDefault();
      event.stopPropagation();
      setWindowOverviewOpen(!windowOverviewOpen);
    };
    document.addEventListener('keydown', handleOverviewShortcut, true);
    return () => document.removeEventListener('keydown', handleOverviewShortcut, true);
  }, [deskActive, windowOverviewOpen, workspaceRef]);
  useLayoutEffect(() => {
    if (deskActive) workspaceRef.current?.focus({ preventScroll: true });
    else if (wasDeskActive.current) deskTrigger.current?.focus({ preventScroll: true });
    wasDeskActive.current = deskActive;
  }, [deskActive, workspaceRef]);
  useEffect(() => {
    if (!deskActive) return;
    const leaveOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.repeat || event.isComposing || document.fullscreenElement) return;
      if (hasVisibleOverlay()) return;
      event.preventDefault();
      leaveDesk();
    };
    document.addEventListener('keydown', leaveOnEscape);
    return () => document.removeEventListener('keydown', leaveOnEscape);
  }, [deskActive, leaveDesk]);
  const openDesk = () => {
    if (sessionMetadataRef.current) sessionMetadataRef.current.open = false;
    setAdbMenuOpen(false);
    changeWorkspaceMode('desk');
  };
  const showFloatingWindow = (name: WorkspaceWindowName) => {
    jumpFloating(name);
    const panel = floatingCanvasRef.current?.querySelector<HTMLElement>(`[data-window="${name}"]`);
    panel?.querySelector<HTMLButtonElement>('button[data-window-move]')?.focus({ preventScroll: true });
  };
  const canResizeDevice = !shared && !deskActive && !isPreparing && activeWorkspaceMode !== 'tools';
  const deviceSize = useWorkspaceDimension(`rdf-device-frame-percent:${encodeURIComponent(user.id)}`, 100, 35, 100, canResizeDevice);
  const frameScale = displayScale * (shared || deskActive ? 1 : deviceSize.value / 100);
  const dimensionLabel = new Intl.NumberFormat(getLocale(), { style: 'percent' }).format(deviceSize.value / 100);
  const touchIndicator = useTouchIndicator(sessionId, canReadEnvironment && !stream.nativeTouches);
  useEffect(() => {
    pointerStartRef.current = null; touchIndicator.clear();
  }, [canControl, stream.connectionGeneration, sessionId, touchIndicator.clear]);
  const capture = useSessionCapture({ sessionId, status: stream.status, format: stream.format, imageRef: stream.imageRef, canvasRef: stream.canvasRef, getTouchIndicator: touchIndicator.getSnapshot });
  const captureReady = stream.status === 'live' && (stream.format === 'video'
    ? Boolean(stream.canvasRef.current?.width && stream.canvasRef.current.height)
    : imageFrameReady && Boolean(stream.imageRef.current?.complete && stream.imageRef.current.naturalWidth));
  const captureSupportNotice = !capture.screenshotSupported && !capture.recordingSupported
    ? t('ui.761ff0dc284c')
    : !capture.screenshotSupported ? t('ui.d43948061cab')
    : !capture.recordingSupported ? t('ui.dc2d2aeb3fe0') : '';
  useEffect(() => {
    if (!capture.error) return;
    notifyError(t('ui.dacc89aa60b5'), capture.error);
    capture.clearError();
  }, [capture.error, capture.clearError, notifyError]);
  const mediaNoticeSeen = useRef(new Set<string>());
  useEffect(() => {
    if (session?.status !== 'running' || stream.status !== 'live') return;
    const messages = [captureSupportNotice, audioEnabled ? stream.audioNotice : ''].filter(Boolean);
    for (const message of messages) {
      const key = `media:${sessionId}:${message}`;
      if (mediaNoticeSeen.current.has(key)) continue;
      mediaNoticeSeen.current.add(key);
      notify({ kind: 'info', title: message, key });
    }
  }, [session?.status, stream.status, stream.audioNotice, audioEnabled, captureSupportNotice, sessionId, notify]);

  const sessionRequest = useRef({ active: false, pending: false, missing: false });
  const refresh = useCallback(async () => {
    const request = sessionRequest.current;
    if (!request.active || request.pending || request.missing) return;
    request.pending = true;
    try {
      const next = await api.session(sessionId);
      if (!request.active) return;
      onObserved(next);
      setSession(next); setSessionError('');
    } catch (error) {
      if (!request.active) return;
      if (error instanceof ApiError && error.status === 404) {
        request.missing = true;
        onNotFound(sessionId);
      } else setSessionError(errorText(error));
    } finally { request.pending = false; }
  }, [sessionId, onNotFound, onObserved]);

  useEffect(() => {
    const request = { active: true, pending: false, missing: false };
    sessionRequest.current = request;
    setSession(null); setSessionError(''); void refresh();
    const timer = window.setInterval(() => void refresh(), 5000);
    return () => { request.active = false; window.clearInterval(timer); };
  }, [refresh]);

  useEffect(() => {
    if (stream.audioUnavailableCount > 0) {
      notifyError(t('ui.0c30ab349215'), t('ui.85049ec8e7fd'));
      void refresh();
    }
  }, [stream.audioUnavailableCount, refresh, notifyError]);

  const sendInput = useCallback((payload: Record<string, unknown>) => {
    if (!canControl) return false;
    // Interactive commands must never escape a disconnected stream through HTTP.
    return stream.send(payload);
  }, [stream, canControl]);

  const navKey = (keyCode: number) => sendInput({ kind: 'key', keyCode });

  const deviceKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!canControl || (deskActive && event.key === 'Escape')) return;
    const navigationKeys: Partial<Record<string, number>> = {
      Escape: 4, Backspace: 4, ArrowUp: 19, ArrowDown: 20, ArrowLeft: 21, ArrowRight: 22,
    };
    const keyCode = event.key === 'Enter' ? (session?.deviceType === 'tv' ? 23 : 66) : navigationKeys[event.key];
    if (typeof keyCode !== 'number') return;
    event.preventDefault();
    navKey(keyCode);
  };

  const point = (event: React.PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    return {
      x: Math.max(0, Math.min(stream.size.width - 1, Math.round((event.clientX - rect.left) / rect.width * stream.size.width))),
      y: Math.max(0, Math.min(stream.size.height - 1, Math.round((event.clientY - rect.top) / rect.height * stream.size.height))),
    };
  };

  const pointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!canControl || !event.isPrimary || event.button !== 0 || pointerStartRef.current) return;
    const position = point(event);
    if (!position) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    touchIndicator.down(event);
    const live = (stream.format === 'video' || stream.nativeTouches) && sendInput({ kind: 'touch', action: 'down', pointerId: 0, ...position });
    pointerStartRef.current = { ...position, time: Date.now(), pointerId: event.pointerId, live, lastMoveAt: 0, lastX: position.x, lastY: position.y };
    event.currentTarget.focus({ preventScroll: true });
  };

  const pointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const start = pointerStartRef.current;
    if (!start || start.pointerId !== event.pointerId || !canControl) return;
    touchIndicator.move(event);
    if (!start.live) return;
    const now = performance.now();
    if (now - start.lastMoveAt < 20) return;
    const position = point(event);
    if (!position || (position.x === start.lastX && position.y === start.lastY)) return;
    if (sendInput({ kind: 'touch', action: 'move', pointerId: 0, ...position })) {
      start.lastMoveAt = now; start.lastX = position.x; start.lastY = position.y;
    }
  };

  const pointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    touchIndicator.end(event);
    const start = pointerStartRef.current;
    if (!start || start.pointerId !== event.pointerId) return;
    pointerStartRef.current = null;
    if (!canControl) return;
    const end = point(event);
    if (start.live) {
      if (end && (end.x !== start.lastX || end.y !== start.lastY)) sendInput({ kind: 'touch', action: 'move', pointerId: 0, ...end });
      sendInput({ kind: 'touch', action: 'up', pointerId: 0, x: end?.x ?? start.lastX, y: end?.y ?? start.lastY });
    } else if (end) {
      const distance = Math.hypot(end.x - start.x, end.y - start.y);
      if (distance < Math.max(12, stream.size.width * 0.012)) sendInput({ kind: 'tap', x: end.x, y: end.y });
      else sendInput({ kind: 'swipe', x1: start.x, y1: start.y, x2: end.x, y2: end.y, durationMs: Math.max(80, Math.min(3000, Date.now() - start.time)) });
    }
  };

  const pointerCancel = (event: React.PointerEvent<HTMLDivElement>) => {
    touchIndicator.cancel(event);
    const start = pointerStartRef.current;
    if (start?.pointerId === event.pointerId) {
      pointerStartRef.current = null;
      if (start.live) sendInput({ kind: 'touch', action: 'up', pointerId: 0, x: start.lastX, y: start.lastY });
    }
  };

  const toggleRotate = async () => {
    if (!session) return;
    setBusy('rotate');
    const currentLandscape = stream.status === 'live' ? landscape : session.orientation === 'landscape';
    try { setSession(await api.rotate(sessionId, currentLandscape ? 'portrait' : 'landscape')); onUpdated(); }
    catch (error) { notifyError(t('ui.3b3e6c347bba'), error); }
    finally { setBusy(''); }
  };

  const toggleAudio = async () => {
    if (!session) return;
    if (!audioEnabled) stream.unlockAudio();
    setBusy('audio');
    try { setSession(await api.setAudio(sessionId, !audioEnabled)); onUpdated(); }
    catch (error) { notifyError(t('ui.d778cc5cd6cc'), error); }
    finally { setBusy(''); }
  };

  const toggleNetwork = async () => {
    if (!session) return;
    setBusy('network');
    try { setSession(await api.setNetwork(sessionId, !networkEnabled)); onUpdated(); }
    catch (error) { notifyError(t('ui.eea79795f97a'), error); }
    finally { setBusy(''); }
  };

  const uploadFiles = async (files: FileList | File[]) => {
    if (!can(user, 'sessions.files')) return;
    if (session?.status !== 'running' || shared) return;
    const selected = Array.from(files);
    if (!selected.length) return;
    dragDepthRef.current = 0;
    setDragging(false);
    const accepted = selected.filter(file => {
      if (file.size > 0 && file.size <= 50 * 1024 * 1024) return true;
      notify({ kind: 'error', title: t('ui.b485d1f3c68f'), message: t('ui.0244ca56afe2'), details: file.name, key: `upload-size:${file.name}` });
      return false;
    });
    setUploading(items => [...items, ...accepted.map(file => file.name)]);
    for (const file of accepted) {
      notify({ kind: 'info', pending: true, title: t('ui.4b0aa1987966'), message: t('ui.f97cf7f88906', { p0: file.name, p1: sessionId.slice(0, 8) }), key: `upload:${sessionId}:${file.name}` });
      try {
        await api.uploadFile(sessionId, file);
        notify({ kind: 'success', title: /\.(apk|apks)$/i.test(file.name) ? t('ui.014571e5fcf7') : t('ui.f9a949a75427'), message: t('ui.f97cf7f88906', { p0: file.name, p1: sessionId.slice(0, 8) }), key: `upload:${sessionId}:${file.name}` });
      }
      catch (error) { notify({ kind: 'error', title: t('ui.47935cf9164f'), message: t('ui.f97cf7f88906', { p0: file.name, p1: sessionId.slice(0, 8) }), details: errorText(error), key: `upload:${sessionId}:${file.name}` }); }
      finally { setUploading(items => items.filter(name => name !== file.name)); }
    }
  };

  useEffect(() => {
    if (sessionMetadataRef.current) sessionMetadataRef.current.open = false;
    const closeOnOutside = (event: PointerEvent) => {
      const details = sessionMetadataRef.current;
      if (details?.open && event.target instanceof Node && !details.contains(event.target)) details.open = false;
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      const details = sessionMetadataRef.current;
      if (event.key !== 'Escape' || !details?.open) return;
      event.preventDefault();
      event.stopPropagation();
      details.open = false;
      details.querySelector('summary')?.focus();
    };
    document.addEventListener('pointerdown', closeOnOutside, true);
    document.addEventListener('keydown', closeOnEscape, true);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutside, true);
      document.removeEventListener('keydown', closeOnEscape, true);
    };
  }, [sessionId]);

  const isFileDrag = (event: React.DragEvent) =>
    Array.from(event.dataTransfer.types).includes('Files') || event.dataTransfer.files.length > 0;
  const dragEnter = (event: React.DragEvent<HTMLDivElement>) => {
    if (!can(user, 'sessions.files') || !isFileDrag(event)) return;
    event.preventDefault();
    dragDepthRef.current += 1;
    setDragging(true);
  };
  const dragOver = (event: React.DragEvent<HTMLDivElement>) => {
    if (!can(user, 'sessions.files') || !isFileDrag(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  };
  const dragLeave = (event: React.DragEvent<HTMLDivElement>) => {
    if (!dragDepthRef.current) return;
    event.preventDefault();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setDragging(false);
  };
  const dropFiles = (event: React.DragEvent<HTMLDivElement>) => {
    if (!can(user, 'sessions.files') || !isFileDrag(event)) return;
    event.preventDefault();
    dragDepthRef.current = 0;
    setDragging(false);
    if (can(user, 'sessions.files')) void uploadFiles(event.dataTransfer.files);
  };

  const chooseDeviceFiles = (apkOnly = false) => {
    const input = fileInputRef.current;
    if (!input) return;
    input.accept = apkOnly ? '.apk,.apks' : '';
    input.click();
  };

  const availableToolTabs = toolTabs().filter(([id, , capability]) => hasCapability(session, capability) && toolAllowed(id));
  const dockedToolTabs = availableToolTabs.filter(([id]) => !deskActive || !widgetLayout.placements[id]);
  const dockedTool = dockedToolTabs.some(([id]) => id === toolTab) ? toolTab : dockedToolTabs[0]?.[0];
  useEffect(() => {
    if (!deskActive && dockedTool && dockedTool !== toolTab) setToolTab(dockedTool);
  }, [deskActive, dockedTool, toolTab]);
  const toolPlacement = (id: ToolTabId) => deskActive && availableToolTabs.some(([availableId]) => availableId === id)
    ? widgetLayout.placements[id] : undefined;
  const previewedTool = deskActive && dockedToolTabs.some(([id]) => id === previewTool) ? previewTool : null;
  const toolActive = (id: ToolTabId) => activeWorkspaceMode !== 'screen' && (dockedTool === id || Boolean(toolPlacement(id)) || previewedTool === id);

  useLayoutEffect(() => {
    const id = focusTool.current;
    if (!id) return;
    focusTool.current = null;
    const control = widgetLayout.placements[id]
      ? floatingCanvasRef.current?.querySelector<HTMLButtonElement>(`.desk-widget [data-window-move="widget:${id}"].floating-window-move`)
      : widgetDockRef.current?.querySelector<HTMLButtonElement>(`#tool-tab-${id}`);
    if (control?.getAttribute('role') === 'tab') focusToolTab(control);
    else control?.focus({ preventScroll: true });
  }, [widgetLayout.placements]);

  function detachTool(id: ToolTabId, x?: number, y?: number) {
    if (!deskActive || !workspaceRef.current || !dockedToolTabs.some(([candidate]) => candidate === id)) return;
    focusTool.current = id;
    const canvas = floatingCanvasRef.current;
    if (!canvas) return;
    const bounds = deskWidgetPlacement(workspaceRef.current, canvas, x, y);
    widgetLayout.setPlacement(id, x !== undefined && y !== undefined ? snapWidgetPlacement(bounds) : bounds);
  }

  function dockTool(id: ToolTabId, focus = true) {
    if (focus) focusTool.current = id;
    setToolTab(id);
    widgetLayout.setPlacement(id);
  }

  const deskOverviewWindows: DeskOverviewWindow[] = [
    { name: 'device', label: t('ui.e6033cd72f50') },
    { name: 'tools', label: t('ui.fecfbc6e1053') },
    ...availableToolTabs.flatMap(([id, label]): DeskOverviewWindow[] => toolPlacement(id)
      ? [{ name: `widget:${id}`, label, returnToTabs: () => dockTool(id, false) }] : []),
  ];

  const hideToolPreview = useCallback(() => {
    setPreviewTool(null);
    if (dragSurfaceRef.current) dragSurfaceRef.current.hidden = true;
    clearAlignmentGuides();
  }, [clearAlignmentGuides]);

  const endToolDrag = useCallback(() => {
    draggedTool.current = null;
    hideToolPreview();
    if (workspaceRef.current) delete workspaceRef.current.dataset.tabDrag;
  }, [hideToolPreview, workspaceRef]);

  useEffect(() => {
    const id = draggedTool.current;
    if (id && (!deskActive || !dockedToolTabs.some(([candidate]) => candidate === id))) endToolDrag();
  }, [deskActive, dockedToolTabs, endToolDrag]);

  function showToolPreview(viewport: HTMLElement, x: number, y: number) {
    const surface = dragSurfaceRef.current;
    const canvas = floatingCanvasRef.current;
    if (!surface || !canvas) return;
    const { left, top, width, height } = snapWidgetPlacement(deskWidgetPlacement(viewport, canvas, x, y), true);
    surface.style.transform = `translate(${left}px, ${top}px)`;
    surface.style.width = `${width}px`;
    surface.style.height = `${height}px`;
    if (surface.hidden) {
      surface.hidden = false;
      setPreviewTool(draggedTool.current);
    }
  }

  function beginToolDrag(event: DragEvent<HTMLButtonElement>, id: ToolTabId) {
    const viewport = workspaceRef.current;
    if (!deskActive || !viewport) { event.preventDefault(); return; }
    draggedTool.current = id;
    event.dataTransfer.setData(DESK_TOOL_DRAG_TYPE, id);
    event.dataTransfer.effectAllowed = 'move';
    // A loaded image replaces the browser's tab thumbnail even when it is outside the DOM.
    event.dataTransfer.setDragImage(deskDragImage, 0, 0);
    viewport.dataset.tabDrag = '';
    showToolPreview(viewport, event.clientX, event.clientY);
  }

  function overWorkspace(event: DragEvent<HTMLDivElement>) {
    if (!deskActive || !draggedTool.current || !event.dataTransfer.types.includes(DESK_TOOL_DRAG_TYPE)) return;
    event.preventDefault();
    const overDock = widgetDockRef.current?.contains(event.target as Node);
    event.dataTransfer.dropEffect = overDock ? 'none' : 'move';
    if (overDock) hideToolPreview();
    else showToolPreview(event.currentTarget, event.clientX, event.clientY);
  }

  function leaveWorkspaceDrag(event: DragEvent<HTMLDivElement>) {
    const next = event.relatedTarget;
    if (draggedTool.current && !(next instanceof Node && event.currentTarget.contains(next))) hideToolPreview();
  }

  function dropTool(event: DragEvent<HTMLDivElement>) {
    const id = draggedTool.current;
    if (!id || event.dataTransfer.getData(DESK_TOOL_DRAG_TYPE) !== id) return;
    event.preventDefault();
    endToolDrag();
    if (!widgetDockRef.current?.contains(event.target as Node)) detachTool(id, event.clientX, event.clientY);
  }

  function renderTool(id: ToolTabId, body: ReactNode) {
    const label = availableToolTabs.find(([candidate]) => candidate === id)?.[1] ?? '';
    return <DeskToolWidget key={id} id={id} label={label} active={toolActive(id)} placement={toolPlacement(id)}
      preview={previewedTool === id ? dragSurfaceRef : undefined}
      dock={floatingToolsRef} canvas={floatingCanvasRef} registerWidget={floatingWorkspace.registerWidget}
      onDock={() => dockTool(id)} onBoundsChange={bounds => widgetLayout.saveBounds(id, bounds)}>{body}</DeskToolWidget>;
  }
  const [renaming, setRenaming] = useState(false);
  const [labelDraft, setLabelDraft] = useState('');
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => { const timer = window.setInterval(() => setClock(Date.now()), 15_000); return () => window.clearInterval(timer); }, []);
  const saveLabel = async () => {
    try { setSession(await api.renameSession(sessionId, labelDraft.trim() || null)); setRenaming(false); onUpdated(); }
    catch (error) { notifyError(t('ui.95a4589c92b0'), error); }
  };
  const extendSession = async () => {
    try { setSession(await api.keepAlive(sessionId)); }
    catch (error) { notifyError(t('ui.21178b2965ec'), error); }
  };
  const idleLeftMs = session?.idleExpiresAt ? new Date(session.idleExpiresAt).getTime() - clock : null;
  const hardLeftMs = session?.expiresAt ? new Date(session.expiresAt).getTime() - clock : null;
  const profileName = session?.profileName || t('ui.85e2179937ff');
  const audioControl = {
    mode: connectionMode, audioTransport: stream.audioTransport, audioEnabled, audioState: stream.audioState,
    audioNotice: stream.audioNotice, audioBusy: !isRunning || busy === 'audio', audioPending: busy === 'audio',
    onUnlockAudio: stream.unlockAudio,
    onToggleAudio: !shared && can(user, 'sessions.control') && hasCapability(session, 'audio') ? () => void toggleAudio() : undefined,
  };
  const audioStatus = ({ disabled: t('ui.5a577d905660'), connecting: t('ui.bd3e94ec1557'), waiting: t('ui.ce51f08bf71c'), unlock: t('ui.e8d306f3eaae'), receiving: t('ui.1b4deda45c35'), silent: t('sessionAudio.silenceDetail'), unavailable: t('ui.53ba89acf405') })[stream.audioState];
  const idleWarning = session?.status === 'running' && session.ownerId === user.id && idleLeftMs !== null && idleLeftMs <= 10 * 60_000 && <div className="banner-warning session-idle-warning" role="status">
      <Icon name="alert" size={17} /><span title={t('ui.e1a23d943344')}><TranslatedText message="copy.SessionView.34b0e063" values={{ p0: Math.max(1, Math.ceil(idleLeftMs / 60_000)) }} /></span>
      <button type="button" className="button primary small" onClick={() => void extendSession()}>{t('ui.659ad690ef24')}</button>
    </div>;
  return <div className="session-layout" data-shared={shared ? access : undefined} data-workspace-mode={activeWorkspaceMode} data-desk={deskActive || undefined}
    data-overview={deskActive && windowOverviewOpen || undefined}>
    <div className="session-heading">
      <div className="session-title-row">
        <div className="session-title-top">
          <button type="button" className="back-link" onClick={onBack} aria-label={t('ui.156552b7ff38')} title={t('ui.156552b7ff38')}><Icon name="chevronLeft" size={19} /></button>
            {renaming
              ? <form className="rename-form" onSubmit={event => { event.preventDefault(); void saveLabel(); }}>
                <input id="session-label" value={labelDraft} maxLength={60} autoFocus aria-label={t('ui.6b8f3a2815e3')} placeholder={t('ui.b7fcc36a24ca')} onChange={event => setLabelDraft(event.target.value)} onKeyDown={event => { if (event.key === 'Escape') setRenaming(false); }} />
                <button type="submit" className="button primary small">{t('ui.b4d30cae5289')}</button>
                <button type="button" className="button outline small" onClick={() => setRenaming(false)}>{t('ui.8fbe9b75cbdf')}</button>
              </form>
              : <div className="session-name"><h1 title={session?.label ? session.label + ' · ' + profileName : profileName}>{session?.label || profileName}</h1>
                {session && can(user, 'sessions.control') && session.ownerId === user.id && <button type="button" className="icon-button rename-button" data-tip={t('ui.89c8e0bb6537')} aria-label={t('ui.89c8e0bb6537')} onClick={() => { setLabelDraft(session.label || ''); setRenaming(true); }}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M4 20h4L19 9l-4-4L4 16v4ZM13.5 6.5l4 4" /></svg></button>}</div>}
        </div>
        {!shared && <button type="button" className="session-actions-toggle" aria-expanded={sessionActionsOpen} aria-controls="session-owner-actions" onClick={() => setSessionActionsOpen(open => !open)}>{t('ui.7696309c4251')}<Icon name={sessionActionsOpen ? 'close' : 'more'} size={18} /></button>}
        <div className="session-top-actions" id="session-owner-actions" data-expanded={sessionActionsOpen || undefined} onKeyDown={event => { if (event.key === 'Escape') { setSessionActionsOpen(false); document.querySelector<HTMLButtonElement>('.session-actions-toggle')?.focus(); } }}>
          {can(user, 'sessions.share') && !isPreparing && <ShareControl session={session} user={user} audience={audience} />}
          {canRecreate && (recreate === 'ask' || recreate === 'busy'
            ? <span className="recreate-confirm owner-only"><span>{recreate === 'busy' ? t('ui.0b66e15bced5') : t('ui.79d85e39f362')}</span>{recreate === 'ask' && <><button type="button" className="button primary small" onClick={() => void recreateSession()}>{t('ui.93e6073f9005')}</button><button type="button" className="button outline small" onClick={() => setRecreate('idle')}>{t('ui.8fbe9b75cbdf')}</button></>}</span>
            : <button type="button" className="button outline owner-only" onClick={() => setRecreate('ask')} title={t('ui.370dad64b98b')}><Icon name="refresh" size={17} />{t('ui.669f46232d41')}</button>)}
          {can(user, 'sessions.stop') && <button className="button danger owner-only" onClick={() => { if (session) onRelease(session); }} disabled={!session || session.status === 'stopped'}><Icon name="power" size={17} />{isPreparing ? t('ui.b37fe0616b64') : t('ui.73cf3a18cd74')}</button>}
          {onKill && <details className="session-more-actions owner-only" onKeyDown={event => { if (event.key === 'Escape') { event.currentTarget.open = false; event.currentTarget.querySelector('summary')?.focus(); } }}>
            <summary aria-label={t('ui.7075085d9334')} title={t('ui.7075085d9334')}><Icon name="more" size={20} /></summary>
            <div className="session-more-menu">
              <strong>{t('ui.ec879a5a3e40')}</strong>
              <p>{t('ui.2fb16f9f1011')}</p>
              <button type="button" className="button danger-outline" onClick={event => { event.currentTarget.closest('details')?.removeAttribute('open'); if (session) onKill(session); }} disabled={!session || session.status === 'stopped'}>{t('ui.5a8d400fc1c1')}</button>
            </div>
          </details>}
        </div>
      </div>
      <div className="session-status-row">
        <div className="session-status-items">
            {session && <SessionStatusBadge status={session.status} />}
            {!isPreparing && <SessionMediaStatus status={stream.status} format={stream.format} transport={stream.transport} streamError={stream.streamError}
              onModeChange={mode => { pointerStartRef.current = null; touchIndicator.clear(); setConnectionMode(mode); }} onReconnect={stream.reconnect} metrics={stream.metrics}
              {...audioControl} onUnlockAudio={activeWorkspaceMode === 'tools' ? audioControl.onUnlockAudio : undefined}
              onToggleAudio={activeWorkspaceMode === 'tools' ? audioControl.onToggleAudio : undefined} />}
            {!isPreparing && can(user, 'sessions.adb') && <div className="adb-title-control owner-only" ref={adbMenuRef}>
              <button
                type="button"
                className={'session-badge adb-title-badge' + (adbPortAccess ? ' active' : '')}
                onClick={() => adbMenuOpen ? closeAdbMenu() : setAdbMenuOpen(true)}
                title={adbPortAccess ? t('ui.dfa1a3f26e77', { p0: adbPortAccess.host, p1: adbPortAccess.port }) : t('ui.fd2fa455bc7b')}
                aria-label={t('ui.fd2fa455bc7b')}
                aria-description={adbPortAccess ? t('ui.d94f4b9d5f11') : t('ui.0eccdf74742b')}
                aria-expanded={adbMenuOpen}
                aria-controls="adb-access-menu"
                disabled={!isRunning && !adbPortAccess}
              >
                <Icon name="key" size={15} />{t('ui.72d0059de792')}<Icon name="chevronDown" size={15} />
              </button>
              {adbMenuOpen && <div className="adb-popover" id="adb-access-menu" role="group" aria-label={t('ui.32fa37aeb6da')}>
                <div className="adb-popover-head"><div><strong>{t('ui.e48efbe38059')}</strong><p>{t('ui.20bc8956a42f')}</p></div><button type="button" className="adb-popover-close" aria-label={t('ui.e83df3ba80b6')} onClick={closeAdbMenu}><Icon name="close" size={16} /></button></div>
                {adbPortAccess && <button type="button" className="adb-copy-command" onClick={() => void copyAdbCommand()} aria-label={t('copy.SessionView.b2e214ec', { p0: adbPortAccess.host, p1: adbPortAccess.port })}><code>{t('ui.51a9e8b802ee')}{adbPortAccess.host}:{adbPortAccess.port}</code><Icon name={adbCopied ? 'check' : 'copy'} size={16} /><span>{adbCopied ? t('ui.d2d08c715ee6') : t('ui.1ecddf40bfeb')}</span></button>}
                {newAdbKey ? <div className="adb-key-created" role="status">
                  <strong>{t('ui.06f0d3f8fdd3')}</strong>
                  <p><TranslatedText message="copy.SessionView.c1d5a618" values={{ p0: <code>{t('ui.d8c2bd5fbdbf')}</code>, p1: <code>{t('ui.8694fc709bdb')}</code>, p2: <code>{t('ui.9702ab6bff62')}</code>, p3: <code>{t('ui.a14576083aa4')}</code>, p4: <code>{t('ui.8694fc709bdb')}</code>, p5: <code>{t('ui.42ba82468cd4')}</code> }} /></p>
                  <div className="adb-key-downloads">
                    <button type="button" className="button primary" onClick={() => { downloadKeyFile('adbkey', newAdbKey.privateKey); setPrivateKeyDownloaded(true); }}><Icon name="download" size={15} />{privateKeyDownloaded ? t('ui.9f0fe20e39c8') : t('ui.e5324bf11872')}</button>
                    <button type="button" className="button outline" onClick={() => { downloadKeyFile('adbkey.pub', newAdbKey.publicKey); setPublicKeyDownloaded(true); }}><Icon name="download" size={15} />{publicKeyDownloaded ? t('ui.c3869d7ed2b5') : t('ui.49a05eedd8f1')}</button>
                  </div>
                  <p className="adb-key-hint"><TranslatedText message="copy.SessionView.0776d313" values={{ p0: <code>{t('ui.da641bf87627')}</code> }} /></p>
                  <div className="adb-popover-actions"><button type="button" className="button subtle" onClick={closeAdbMenu} disabled={!privateKeyDownloaded || !publicKeyDownloaded}>{t('ui.ef05d57959cf')}</button><button type="button" className="text-button danger-text" onClick={() => { setNewAdbKey(null); setAdbMenuOpen(false); setAdbError(''); }}>{t('ui.74f4e22caf07')}</button></div>
                </div> : <>
                  {adbUserKey ? <div className="adb-key-status"><Icon name="shield" size={17} /><div><strong>{t('ui.5b9558b15ecc')}</strong><small><TranslatedText message="copy.SessionView.eec6f383" values={{ p0: adbUserKey.fingerprint }} /></small></div></div> : <div className="adb-key-intro"><p>{t('ui.16a1b5eb0d5d')}</p><button type="button" className="button primary" onClick={() => void createAdbUserKey(false)} disabled={adbBusy || !adbKeyLoaded}>{adbBusy ? t('ui.c2f23e83210c') : t('ui.d221d47fee4d')}</button></div>}
                  {(adbUserKey || adbPortAccess) && <div className="adb-port-section">
                    {adbPortAccess ? <><p><TranslatedText message="copy.SessionView.0f1f030f" values={{ p0: <code>{adbPortAccess.host}:{adbPortAccess.port}</code>, p1: adbPortAccess.expiresAt ? t('copy.SessionView.7830d87f', { p0: timeLabel(adbPortAccess.expiresAt) }) : t('ui.897db6e39f60') }} /></p><button type="button" className="text-button" onClick={() => void revokeAdbPortAccess()} disabled={adbBusy}>{t('ui.79d8d58afd9c')}</button></> : <><p>{t('ui.ada4a19abb8b')}</p><button type="button" className="button subtle" onClick={() => void requestAdbPortAccess()} disabled={!isRunning || adbBusy}>{adbBusy ? t('ui.06b7aac26fa7') : t('ui.992a5e672c16')}</button></>}
                  </div>}
                  {adbUserKey && <div className="adb-key-secondary">
                    {!confirmKeyRotation ? <button type="button" className="text-button" onClick={() => setConfirmKeyRotation(true)} disabled={adbBusy}>{t('ui.4a01473b61bb')}</button> : <div className="adb-rotate-confirm"><p>{t('ui.5db2b2cbfc30')}</p><div className="adb-popover-actions"><button type="button" className="button danger-light" onClick={() => void createAdbUserKey(true)} disabled={adbBusy}>{t('ui.e52c9dc94523')}</button><button type="button" className="text-button" onClick={() => setConfirmKeyRotation(false)} disabled={adbBusy}>{t('ui.8fbe9b75cbdf')}</button></div></div>}
                  </div>}
                  <div className="adb-key-secondary"><button type="button" className="text-button" onClick={() => setShowCustomAdbKey(value => !value)}>{showCustomAdbKey ? t('ui.82186a4b5d63') : adbUserKey ? t('ui.a0a8812c2b52') : t('ui.6f33967e1d78')}</button></div>
                  {showCustomAdbKey && <div className="adb-custom-key"><p>{t('ui.68786935a66e')}{adbPortAccess ? t('ui.a4c11ad113fa') : ''}{adbUserKey ? t('ui.94185e702d32') : ''}</p><textarea value={adbPublicKey} onChange={event => setAdbPublicKey(event.target.value)} rows={3} spellCheck={false} aria-label={t('ui.f1c4fa73d22b')} placeholder={t('ui.ca2334b05672')} /><div className="adb-popover-actions"><label className="button outline adb-key-file">{t('ui.e5b30b603ca3')}<input type="file" accept=".pub,text/plain" onChange={event => { void loadAdbPublicKey(event.target.files?.[0]); event.target.value = ''; }} /></label><button type="button" className="button subtle" onClick={() => void requestAdbPortAccess()} disabled={!isRunning || adbBusy || !adbPublicKey.trim()}>{adbBusy ? t('ui.06b7aac26fa7') : t('ui.992a5e672c16')}</button></div></div>}
                </>}
                {adbError && <div className="inline-warning" role="alert">{localizeText(adbError)}</div>}
              </div>}
            </div>}
            <details ref={sessionMetadataRef} className="session-metadata">
              <summary className="session-badge" aria-label={t('ui.a1ea04f1a70b')} title={t('ui.a1ea04f1a70b')}><Icon name="info" size={16} /><span>{t('ui.a1ea04f1a70b')}</span><Icon name="chevronDown" size={16} /></summary>
              <div className="session-metadata-body"><dl><div><dt>{t('ui.e77a383ee52d')}</dt><dd>{session?.hostName || '—'}</dd></div><div><dt>{t('ui.f7aa03484689')}</dt><dd>#{sessionId.slice(0, 8)}</dd></div><div><dt>{t('ui.0a39fbc65169')}</dt><dd>{timeLabel(session?.createdAt)}</dd></div>
                {!isPreparing && <><div><dt>{t('ui.c476ef70003f')}</dt><dd>{stream.status === 'live' ? stream.transport === 'webrtc' ? t('ui.cffd062854c1') : stream.format === 'video' ? t('technical.webSocketScrcpy') : t('ui.3dce224a18f5') : t('ui.bd3e94ec1557')}</dd></div><div><dt>{t('ui.6a40ca96136a')}</dt><dd>{audioStatus}{stream.audioNotice ? ': ' + stream.audioNotice : ''}</dd></div></>}
              </dl>
              {!shared && !isPreparing && <p>{session?.ownerId === user.id ? t('ui.bb561792253b') : t('ui.113a937fb02e')}{audienceDescription(audience)}</p>}
              {session?.adminAccess && session.ownerId === user.id && <p><TranslatedText message="copy.SessionView.f633173d" values={{ p0: session.adminAccess.username, p1: timeLabel(session.adminAccess.at) }} /></p>}</div>
            </details>
        </div>
        {!shared && !isPreparing && <div className="workspace-mode-bar" role="group" aria-label={t('ui.7920d43e70db')}>
          <div className="workspace-mode-buttons">
            <button type="button" className="workspace-positioned-view" data-workspace-choice="split" aria-pressed={activeWorkspaceMode === 'split'}
              aria-label={t('ui.de5c415b1d45')} title={t('ui.de5c415b1d45')} onClick={() => changeWorkspaceMode('split')}><Icon name="grid" size={16} /><span>{t('ui.de5c415b1d45')}</span></button>
            <button ref={deskTrigger} type="button" className="workspace-positioned-view workspace-enter-desk" data-workspace-choice="desk"
              aria-pressed={deskActive} aria-label={t('session.workspace.desk')} title={t('session.workspace.desk')} onClick={openDesk}>
              <Icon name="expand" size={16} /><span>{t('session.workspace.desk')}</span>
            </button>
            <WorkspaceDefaultButton className="workspace-default-view" selected={defaultView} disabled={!canSaveDefaultLayout} onSelect={saveDefaultWorkspaceMode} />
            <div className="workspace-quick-views">
              <button type="button" className="workspace-standalone-view" data-workspace-choice="screen" aria-pressed={activeWorkspaceMode === 'screen'}
                aria-label={t('ui.c062341615dc')} title={t('ui.c062341615dc')} onClick={() => changeWorkspaceMode('screen')}>
                <Icon name="phone" size={16} /><span>{t('ui.c062341615dc')}</span>
              </button>
              <button type="button" className="workspace-standalone-view" data-workspace-choice="tools" aria-pressed={activeWorkspaceMode === 'tools'}
                aria-label={t('ui.4e90074f740b')} title={t('ui.4e90074f740b')} onClick={() => changeWorkspaceMode('tools')}>
                <Icon name="terminal" size={16} /><span>{t('ui.4e90074f740b')}</span>
              </button>
            </div>
          </div>
        </div>}
      </div>
    </div>

    {idleWarning}
    {session?.status === 'running' && hardLeftMs !== null && hardLeftMs <= 30 * 60_000 && <div className="banner-warning" role="status">
      <Icon name="alert" size={17} /><span><TranslatedText message="copy.SessionView.a54f5c0c" values={{ p0: new Date(session.expiresAt!).toLocaleTimeString(getLocale(), { hour: '2-digit', minute: '2-digit' }) }} /></span>
    </div>}
    {shared && <SharedBanner ownerName={session?.ownerName} mode={access === 'view' ? 'view' : 'control'} />}
    {sessionError && <div className="banner-error" role="alert"><Icon name="alert" size={17} />{localizeText(sessionError)}<button onClick={() => void refresh()}>{t('ui.5189135a6110')}</button></div>}
    {isPreparing ? <SessionStartupProgress progress={session?.startupProgress}/> : <>
    {deskActive && <DeskWindowOverview open={windowOverviewOpen} windows={deskOverviewWindows} workspace={floatingWorkspace}
      zoom={floatingWorkspace.deskZoom} onZoom={floatingWorkspace.changeDeskZoom} onResetLayout={floatingWorkspace.reset}
      onSaveLayout={emulated ? () => {
        const snapshot = floatingWorkspace.snapshotLayout();
        return snapshot ? saveDeskLayoutTemplate(user.id, snapshot) : false;
      } : undefined}
      onOpenChange={setWindowOverviewOpen} onSelect={showFloatingWindow} onExitDesk={leaveDesk} />}
    {deskActive && <div className="desk-grid" aria-hidden="true"><div className="desk-grid-pattern" ref={deskGridRef}/></div>}
    <div className="workspace-grid" data-console-resized={consoleResized || undefined} data-landscape={landscape || undefined} data-desk={deskActive || undefined} ref={workspaceRef}
      dir={deskActive ? 'ltr' : undefined} role={deskActive ? 'region' : undefined} tabIndex={deskActive ? 0 : undefined}
      aria-label={deskActive ? t('session.workspace.desk') : undefined}
      aria-describedby={deskActive ? 'desk-exit-hint' : undefined}
      onDragOver={overWorkspace} onDragLeave={leaveWorkspaceDrag} onDrop={dropTool}
      onDoubleClick={event => {
        if (deskActive && !draggedTool.current && (event.target === floatingCanvasRef.current ||
          event.target === floatingCanvasRef.current?.parentElement || event.target === event.currentTarget)) {
          setWindowOverviewOpen(true);
        }
      }}
      style={{ '--console-width': consoleWidth + 'px', '--viewer-width': viewerWidth + 'px', '--device-aspect': stream.size.width / Math.max(1, stream.size.height) } as CSSProperties}>
      <div className="session-floating-plane"><div className="session-floating-canvas" ref={floatingCanvasRef}>
      {deskActive && <div className="desk-drag-surface" ref={dragSurfaceRef} hidden inert aria-hidden="true" />}
      <section className="viewer-panel" dir="ltr" aria-label={t('ui.4547b46d3c0c')} ref={floatingDeviceRef}
        data-window={deskActive ? 'device' : undefined} data-controls-edge={controlsPlacement.edge}>
        {deskActive && <FloatingWindowResizeHandles name="device" />}
        <DeviceControls onKey={navKey} canControl={canControl} capture={capture} captureReady={captureReady} placement={controlsPlacement}
          workspaceMove={deskActive && <FloatingWindowMove name="device" className="device-control" />}
          textInput={!readOnly && <DeviceTextInput key={sessionId} active={shared || activeWorkspaceMode !== 'tools'} canSend={canControl}
            onSend={text => sendInput({ kind: 'text', text })} />}
          audio={(audioEnabled || audioControl.onToggleAudio) && <SessionAudioControl rail {...audioControl} />}
          rotate={!shared && hasCapability(session, 'rotate') ? { landscape, busy: !isRunning || busy === 'rotate', onClick: () => void toggleRotate() } : undefined}
          network={!shared && hasCapability(session, 'network') ? { enabled: networkEnabled, busy: !isRunning || busy === 'network', onClick: () => void toggleNetwork() } : undefined}
          upload={!shared && can(user, 'sessions.files') ? { pending: uploading.length > 0, disabled: !isRunning || uploading.length > 0, onClick: () => chooseDeviceFiles() } : undefined} />
        <input ref={fileInputRef} type="file" multiple hidden onChange={event => { if (event.target.files) void uploadFiles(event.target.files); event.target.value = ''; }} />
        <div className="viewer-stage" dir={getDirection()} ref={screenRef} onDragEnter={dragEnter} onDragOver={dragOver} onDragLeave={dragLeave} onDragEnd={() => { dragDepthRef.current = 0; setDragging(false); }} onDrop={dropFiles}>
          <div className="session-device-frame" style={{ width: stream.size.width * frameScale, height: stream.size.height * frameScale }}>
          <div className={'device-screen ' + (landscape ? 'landscape' : 'portrait')}>
            <img ref={stream.imageRef} alt={t('ui.b4a6c9bc414c')} className={stream.format === 'image' ? 'active-frame' : ''} draggable={false} onLoad={() => setImageFrameReady(true)} onError={() => setImageFrameReady(false)} />
            <canvas ref={stream.canvasRef} className={stream.format === 'video' ? 'active-frame' : ''} />
            <div className="touch-layer" role="application" aria-label={t('ui.684de2e969ef')} tabIndex={readOnly ? -1 : 0} onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={pointerCancel} onLostPointerCapture={pointerCancel} onKeyDown={deviceKeyDown}><span ref={touchIndicator.markerRef} className="session-touch-marker" aria-hidden="true" hidden /></div>
            {(session && (session.status === 'error' || (session.error && (session.status === 'stopping' || session.status === 'stopped')))) ? <div className="stream-placeholder"><div className="placeholder-device"><Icon name="alert" size={34}/></div><h3>{t('ui.f70ff6228697')}</h3><p>{session.error || t('ui.2a05b00bc38f')}</p></div> : stream.status !== 'live' && <div className="stream-placeholder"><div className="placeholder-device"><Icon name="phone" size={38} /></div><h3>{stream.status === 'connecting' ? t('ui.bd77b9fa4fd6') : stream.status === 'unsupported' ? t('ui.3a6ec360f375') : t('ui.fb3ce9cae1e8')}</h3><p>{stream.streamError || t('ui.ebcb4d3177c6')}</p>{stream.status !== 'connecting' && <button className="button ghost-light" onClick={stream.reconnect}><Icon name="refresh" size={16} />{t('ui.2de34a1774f6')}</button>}</div>}
            {dragging && <div className="drop-overlay"><Icon name="upload" size={34} /><strong>{t('ui.9c12eed10791')}</strong><span>{t('ui.4b2f4b989bf1')}</span></div>}
          </div>
          {canResizeDevice && ['nw', 'ne', 'sw', 'se'].map(corner => <div key={corner} className="device-resize-handle" data-corner={corner}
            role="slider" tabIndex={corner === 'se' ? 0 : -1} aria-label={t('session.workspace.resizeDevice')}
            aria-valuemin={deviceSize.min} aria-valuemax={deviceSize.max} aria-valuenow={deviceSize.value} aria-valuetext={dimensionLabel}
            title={t('session.workspace.resizeDevice')}
            {...deviceSize.pointerHandlers(event => {
              const rect = event.currentTarget.parentElement!.getBoundingClientRect();
              const x = event.clientX, y = event.clientY;
              const dx = corner.endsWith('e') ? rect.width : -rect.width;
              const dy = corner.startsWith('s') ? rect.height : -rect.height;
              const factor = 2 * deviceSize.value / (dx * dx + dy * dy);
              return move => ((move.clientX - x) * dx + (move.clientY - y) * dy) * factor;
            })}
            onKeyDown={event => deviceSize.resizeWithKeyboard(event, 5, ['ArrowUp', 'ArrowRight'], ['ArrowDown', 'ArrowLeft'])}
          />)}
          </div>
        </div>
      </section>
      {!shared && <section className="tool-panel terminal-panel" aria-label={t('ui.fecfbc6e1053')} data-active-tool={dockedTool} data-console-height-resized={!deskActive && consoleHeightResized && dockedTool === 'console' && !catalogOpen || undefined}
        ref={floatingToolsRef} data-window={deskActive ? 'tools' : undefined} dir={deskActive ? getDirection() : undefined}>
        {deskActive && <FloatingWindowResizeHandles name="tools" />}
        <div className="session-tool-tabs-strip" ref={widgetDockRef} data-window-move={deskActive ? 'tools' : undefined} data-widget-dock={deskActive || undefined}>
          {deskActive && <FloatingWindowMove name="tools" />}
          {deskActive && availableToolTabs.length > 0 && !dockedToolTabs.length ? <span className="desk-empty-tabs">{t('session.workspace.dockHere')}</span>
          : <div className="tool-tabs" ref={bindHorizontalWheel} role="tablist" aria-label={t('ui.fecfbc6e1053')} onKeyDown={event => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) || !dockedToolTabs.length) return;
            event.preventDefault();
            const current = dockedToolTabs.findIndex(([id]) => id === dockedTool);
            const next = event.key === 'Home' ? 0 : event.key === 'End' ? dockedToolTabs.length - 1
              : (current + (event.key === (getDirection() === 'rtl' ? 'ArrowRight' : 'ArrowLeft') ? -1 : 1) + dockedToolTabs.length) % dockedToolTabs.length;
            const id = dockedToolTabs[next][0];
            setToolTab(id);
            const tab = event.currentTarget.querySelector<HTMLButtonElement>('#tool-tab-' + id);
            if (tab) focusToolTab(tab);
          }}>{dockedToolTabs.map(([id, label]) => <button key={id} type="button" role="tab" id={'tool-tab-' + id}
            aria-controls={'tool-panel-' + id} aria-selected={dockedTool === id} tabIndex={dockedTool === id ? 0 : -1}
            className={dockedTool === id ? 'active' : ''} onClick={() => setToolTab(id)}
            draggable={deskActive} title={deskActive ? t('session.workspace.detachTool') : undefined}
            aria-keyshortcuts={deskActive ? 'Alt+Enter' : undefined}
            onKeyDown={event => {
              if (deskActive && event.altKey && event.key === 'Enter') { event.preventDefault(); detachTool(id); }
            }}
            onDragStart={event => beginToolDrag(event, id)}
            onDragEnd={endToolDrag}>{label}</button>)}</div>}
          {deskActive && <div className="floating-desk-actions">
            <WorkspaceDefaultButton className="floating-desk-default" selected={defaultView} onSelect={saveDefaultWorkspaceMode} size={18} />
          </div>}
        </div>
        {!deskActive && <div className="console-width-handle" role="separator" aria-orientation="vertical" aria-label={t('ui.aad9553c58e7')} aria-valuemin={minConsoleWidth()} aria-valuemax={maxConsoleWidth()} aria-valuenow={visibleConsoleSize.width || Math.min(consoleWidth, maxConsoleWidth())} tabIndex={0} onPointerDown={startWidthResize} onPointerMove={moveWidthResize} onPointerUp={endWidthResize} onPointerCancel={endWidthResize} onLostPointerCapture={endWidthResize} title={t('ui.84def31d6544')} onKeyDown={event => resizeConsoleWithKeyboard(event, 'width')}><span /></div>}
      </section>}
      </div></div>
      {!shared && <>
        {renderTool('console', <div className="tool-content terminal-tool" id="tool-panel-console" role="tabpanel" aria-labelledby="tool-tab-console" data-catalog-open={catalogOpen || undefined} style={toolActive('console') ? undefined : { display: 'none' }}>
          <div className="terminal-topline"><div className="tool-header"><h2>{t('ui.415b2ea14558')}</h2><p>{t('ui.5a8b4be5b13d')}</p></div><div className="terminal-header-actions"><button type="button" className="console-size-reset icon-button" title={t('ui.acb4297e7d57')} aria-label={t('ui.acb4297e7d57')} onClick={resetConsoleSize} disabled={!consoleResized && !consoleHeightResized}><Icon name="refresh" size={16} /></button><button type="button" className="console-catalog-toggle" aria-expanded={catalogOpen} aria-controls="console-catalog-panel" onClick={() => { setSuggestionsOpen(false); setCatalogOpen(open => !open); }}><TranslatedText message="copy.SessionView.debcf21d" values={{ p0: getConsoleCommands().length }} /></button><button type="button" className="terminal-clear" onClick={() => setShellHistory([])} disabled={!shellHistory.length} title={t('ui.20dd55101aa2')}>{t('ui.8965271d3c97')}</button></div></div>
          <div className="terminal-output" ref={terminalOutputRef} style={{ height: consoleHeight }} aria-live="polite">{shellHistory.length ? shellHistory.map((line, index) => <div className="terminal-entry" key={index}><div className="terminal-command"><span aria-hidden="true">{t('ui.77d57e39b407')}</span> {line.command}</div>{line.result?.stdout && <pre>{line.result.stdout}</pre>}{line.result?.stderr && <pre className="terminal-stderr">{line.result.stderr}</pre>}{line.error && <pre className="terminal-stderr">{line.error}</pre>}{line.result && <small><TranslatedText message="copy.SessionView.0f771496" values={{ p0: line.result.exitCode }} /></small>}</div>) : <div className="terminal-empty"><strong>{t('ui.fadad01443a1')}</strong><p>{t('ui.087d5eca2dbf')}</p></div>}{shellBusy && <div className="terminal-running"><span className="mini-spinner" />{t('ui.176e44dd22ac')}</div>}</div>
          {!deskActive && <div className="console-height-handle" role="separator" aria-orientation="horizontal" aria-label={t('ui.61c0f7efe428')} aria-valuemin={180} aria-valuemax={maxConsoleHeight()} aria-valuenow={visibleConsoleSize.height || Math.min(consoleHeight, maxConsoleHeight())} tabIndex={0} onPointerDown={startHeightResize} onPointerMove={moveHeightResize} onPointerUp={endHeightResize} onPointerCancel={endHeightResize} onLostPointerCapture={endHeightResize} title={t('ui.828ce3497805')} onKeyDown={event => resizeConsoleWithKeyboard(event, 'height')}><span /></div>}
          <div className="terminal-input-wrap">
            {catalogOpen && <div className="console-catalog" id="console-catalog-panel" aria-label={t('ui.0bf2af623b6f')} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); setCatalogOpen(false); commandInputRef.current?.focus(); } }}>
              <div className="console-catalog-search"><input value={catalogQuery} onChange={event => setCatalogQuery(event.target.value)} placeholder={t('ui.d65f680ec9dc')} aria-label={t('ui.a8ea2fb17773')} /><span><TranslatedText message="copy.SessionView.8ce621ed" values={{ p0: catalogResults.length }} /></span></div>
              <div className="console-category-strip"><div className="console-catalog-categories" ref={categoryStripRef} role="group" aria-label={t('ui.9da251efb22a')}>
                {[{ id: 'all' as const, label: t('ui.215816bf4210') }, ...CONSOLE_CATEGORIES].map(category => <button key={category.id} type="button" className={catalogCategory === category.id ? 'active' : ''} aria-pressed={catalogCategory === category.id} onClick={event => { setCatalogCategory(category.id); event.currentTarget.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }}>{category.label}</button>)}
              </div><button type="button" className="console-category-next" aria-label={t('ui.32b433b8b292')} onClick={() => { const strip = categoryStripRef.current; if (strip) strip.scrollBy({ left: strip.scrollLeft + strip.clientWidth >= strip.scrollWidth - 2 ? -strip.scrollWidth : strip.clientWidth * .75, behavior: 'smooth' }); }}><Icon name="arrowRight" size={16} /></button></div>
              <div className="console-catalog-list">
                {catalogResults.length ? catalogResults.map(hint => <div className="console-catalog-item" key={hint.access + ':' + hint.command}>
                  <div className="console-catalog-item-head"><strong>{hint.label}</strong><span className={'console-access ' + hint.access}>{hint.access === 'console' ? hint.dynamic ? t('ui.9d822e803d95') : t('ui.a58f47dbc474') : hint.access === 'upload' ? t('ui.9088ca9c0de9') : t('ui.17875e55933e')}</span></div>
                  <code>{hint.syntax}</code><p>{hint.description}</p>
                  <small><b>{t('ui.773c42b456dd')}</b> {hint.arguments}</small><small><b>{t('ui.f8649416b729')}</b> {hint.example}</small>
                  {hint.caution && <small className="console-caution">{hint.caution}</small>}
                  {hint.access === 'console' && <button type="button" className="console-catalog-insert" onClick={() => insertConsoleHint(hint)} disabled={!isRunning || shellBusy}>{t('ui.e75dccf67c8c')}</button>}
                  {hint.access === 'upload' && can(user, 'sessions.files') && <div className="console-catalog-actions">
                    <button type="button" className="console-catalog-insert" onClick={() => chooseDeviceFiles(hint.action === 'upload-apk')} disabled={!isRunning || uploading.length > 0}><Icon name="upload" size={15} />{hint.action === 'upload-apk' ? t('ui.52875137fc3f') : t('ui.e3663341c82c')}</button>
                    {hint.action === 'upload-apk' && <button type="button" className="console-catalog-insert" onClick={() => { setCatalogOpen(false); setToolTab('apps'); if (!deskActive) changeWorkspaceMode('tools'); else if (toolPlacement('apps')) jumpFloating('widget:apps'); }}>{t('ui.ce084d29dc24')}</button>}
                  </div>}
                  {hint.access === 'external' && can(user, 'sessions.adb') && <button type="button" className="console-catalog-insert" onClick={() => { if (deskActive) leaveDesk(); setAdbMenuOpen(true); adbMenuRef.current?.scrollIntoView({ block: 'start', behavior: 'instant' }); }}>{t('ui.31803f334db2')}</button>}
                </div>) : <div className="console-catalog-empty">{t('ui.532865cd567e')}</div>}
              </div>
            </div>}
            {suggestionsOpen && suggestions.length > 0 && <div className="console-suggestions" id="console-command-hints" role="listbox" aria-label={t('ui.a811e7886752')}>
              {suggestions.map((hint, index) => <button key={hint.access + ':' + hint.command} id={'console-hint-' + index} type="button" role="option" aria-selected={suggestionIndex === index} className={suggestionIndex === index ? 'selected' : ''} onPointerDown={event => event.preventDefault()} onClick={() => insertConsoleHint(hint)}><span><strong>{hint.label}</strong><code>{hint.command}</code></span><small>{hint.access === 'console' ? hint.dynamic ? t('ui.9d822e803d95') : hint.category : hint.access === 'upload' ? t('ui.50dfcd25c152') : t('ui.d5077a203455')}</small></button>)}
              <div className="console-suggestions-help">{t('ui.2c3ffc82a569')}</div>
            </div>}
            <form className="terminal-input" onSubmit={runCommand}><span aria-hidden="true">{t('ui.77d57e39b407')}</span><input ref={commandInputRef} value={command} onChange={event => { setCommand(event.target.value); setCatalogOpen(false); setConsoleNotice(''); setHistoryIndex(null); setSuggestionIndex(-1); setSuggestionsOpen(Boolean(event.target.value.trim())); }} onFocus={() => { setCatalogOpen(false); if (command.trim()) setSuggestionsOpen(true); }} onBlur={() => setSuggestionsOpen(false)} onKeyDown={handleCommandKeyDown} placeholder={t('ui.c4f762e79442')} aria-label={t('ui.2c167f49ad58')} aria-autocomplete="list" aria-controls="console-command-hints" aria-expanded={suggestionsOpen && suggestions.length > 0} aria-activedescendant={suggestionsOpen && suggestionIndex >= 0 ? 'console-hint-' + suggestionIndex : undefined} disabled={!isRunning || shellBusy} spellCheck={false} autoComplete="off" /><button type="submit" disabled={!command.trim() || !isRunning || shellBusy} aria-label={t('ui.74f37caa1f86')}><Icon name="arrowRight" size={18} /></button></form>{consoleNotice && <div className="console-notice" role="alert">{consoleNotice}</div>}
          </div>
        </div>)}
        {renderTool('logs', <LogcatPanel panelId="tool-panel-logs" sessionId={sessionId} active={toolActive('logs')} running={isRunning} />)}
        {renderTool('info', <DeviceInfoPanel panelId="tool-panel-info" sessionId={sessionId} active={toolActive('info')} running={isRunning} />)}
        {renderTool('env', <EnvPanel panelId="tool-panel-env" sessionId={sessionId} active={toolActive('env')} running={canReadEnvironment} readForViewer={canReadEnvironment} onShowTouchesChange={touchIndicator.setEnabled} nativeTouches={stream.nativeTouches} />)}
        {renderTool('traffic', <NetworkPanel sessionId={sessionId} active={toolActive('traffic')} running={isRunning} canExport={can(user, 'sessions.files')} onExpand={!deskActive && activeWorkspaceMode !== 'tools' ? () => changeWorkspaceMode('tools') : undefined} />)}
        {renderTool('webviews', <WebViewsPanel sessionId={sessionId} active={toolActive('webviews')} running={isRunning} />)}
        {toolAllowed('performance') && renderTool('performance', <PerformancePanel key={sessionId} sessionId={sessionId}
          active={toolActive('performance')} running={isRunning}
          ended={session?.status === 'stopped' || session?.status === 'error'} />)}
        {renderTool('apps', <AppsPanel panelId="tool-panel-apps" sessionId={sessionId} active={toolActive('apps')} running={isRunning} />)}
      </>}
    </div>
    </>}
  </div>;
}
