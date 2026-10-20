import { can } from './permissions';
import { localizeText, getLocale, t } from './i18n';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { api, ApiError, KNOWN_ERRORS, type AdbPortAccess, type AdbUserKey, type NewAdbUserKey, type DeviceSession, type User } from './api';
import { Icon } from './icons';
import { useNotifications } from './notifications';
import { lastLaunch } from './CreateSessionModal';
import { SessionStartupProgress } from './SessionStartupProgress';
import { SessionStatusBadge } from './SessionStatusBadge';
import { LogcatPanel } from './LogcatPanel';
import { DeviceInfoPanel } from './DeviceInfoPanel';
import { EnvPanel } from './tools/EnvPanel';
import { AppsPanel } from './tools/AppsPanel';
import { ShareControl, SharedBanner } from './ShareControl';
import { accessOf } from './share-api';
import { useSessionAudience } from './useSessionAudience';
import { audienceDescription } from './session-audience';
import { CONSOLE_CATEGORIES, getConsoleCommands } from './console-commands';
import { useSessionConsole } from './useSessionConsole';
import { useSessionStream, type ConnectionMode } from './useSessionStream';
import { SessionMediaStatus } from './SessionMediaStatus';
import { hasCapability, type Capability } from './devices';
import './ConsoleResize.css';
import { useTouchIndicator } from './useTouchIndicator';
import './TouchIndicator.css';

type ToolTabId = 'console' | 'logs' | 'info' | 'env' | 'apps';
// Each tool needs a device capability; physical phones may offer fewer than emulators.
function toolTabs(): ReadonlyArray<readonly [ToolTabId, string, Capability]> { return [
  ['console', t('ui.a58f47dbc474'), 'shell'], ['logs', t('ui.1ebab145dea4'), 'logs'], ['info', t('ui.bd38d43cf415'), 'device-info'], ['env', t('ui.d606a9df2b84'), 'env'], ['apps', t('ui.39c4b42c8d11'), 'install'],
]; }
import { useSessionCapture } from './useSessionCapture';



const CONSOLE_WIDTH_KEY = 'rdf-console-width';
const CONSOLE_HEIGHT_KEY = 'rdf-console-height';

function downloadKeyFile(filename: string, content: string): void {
  const url = URL.createObjectURL(new Blob([content], { type: 'application/octet-stream' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
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

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : t('ui.b9f61453dd3f');
}

function timeLabel(value: string | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : new Intl.DateTimeFormat(getLocale(), { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function captureTime(seconds: number): string {
  return String(Math.floor(seconds / 60)).padStart(2, '0') + ':' + String(seconds % 60).padStart(2, '0');
}

export function SessionView({ sessionId, user, onBack, onNotFound, onRelease, onKill, onObserved, onUpdated }: {
  sessionId: string; user: User; onBack: () => void; onNotFound: (id: string) => void; onRelease: (session: DeviceSession) => void; onKill?: (session: DeviceSession) => void; onObserved: (session: DeviceSession) => void; onUpdated: () => void;
}) {
  const [session, setSession] = useState<DeviceSession | null>(null);
  const isPreparing = !session || session.status === 'starting';
  // Shared viewers (access view/control) get no owner tools; the server enforces this too.
  const access = accessOf(session);
  const shared = access === 'view' || access === 'control';
  const audience = useSessionAudience(session, user);
  const readOnly = access === 'view' || !can(user, 'sessions.control');
  const toolPermission: Record<ToolTabId, string> = { console: 'sessions.console', logs: 'sessions.logcat', info: 'sessions.view', env: 'sessions.env', apps: 'sessions.files' };
  const toolAllowed = (id: ToolTabId) => can(user, toolPermission[id]);
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
  const [adbPortAccess, setAdbPortAccess] = useState<AdbPortAccess | null>(null);
  const [adbPublicKey, setAdbPublicKey] = useState('');
  const [adbUserKey, setAdbUserKey] = useState<AdbUserKey | null>(null);
  const [adbKeyLoaded, setAdbKeyLoaded] = useState(false);
  const [newAdbKey, setNewAdbKey] = useState<NewAdbUserKey | null>(null);
  const [privateKeyDownloaded, setPrivateKeyDownloaded] = useState(false);
  const [publicKeyDownloaded, setPublicKeyDownloaded] = useState(false);
  const [showCustomAdbKey, setShowCustomAdbKey] = useState(false);
  const [confirmKeyRotation, setConfirmKeyRotation] = useState(false);
  const [adbPortChecked, setAdbPortChecked] = useState(false);
  const autoPortAttemptRef = useRef('');
  const [adbBusy, setAdbBusy] = useState(false);
  const [adbError, setAdbError] = useState('');
  const [adbMenuOpen, setAdbMenuOpen] = useState(false);
  const [sessionActionsOpen, setSessionActionsOpen] = useState(false);
  const [adbCopied, setAdbCopied] = useState(false);
  const adbMenuRef = useRef<HTMLDivElement>(null);
  const sessionMetadataRef = useRef<HTMLDetailsElement>(null);
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
  const [textInput, setTextInput] = useState('');
  const [stageSize, setStageSize] = useState({ width: 900, height: 650 });
  const [stageHorizontalPadding, setStageHorizontalPadding] = useState(0);
  const screenRef = useRef<HTMLDivElement>(null);
  const pointerStartRef = useRef<{ x: number; y: number; time: number; pointerId: number; live: boolean; lastMoveAt: number; lastX: number; lastY: number } | null>(null);
  const audioEnabled = session?.audioEnabled ?? false;
  const networkEnabled = session?.networkEnabled !== false;
  const [imageFrameReady, setImageFrameReady] = useState(false);
  const [connectionMode, setConnectionMode] = useState<ConnectionMode>('websocket');
  const stream = useSessionStream(sessionId, audioEnabled, connectionMode);
  const touchIndicator = useTouchIndicator(sessionId, canReadEnvironment && !stream.nativeTouches);
  useEffect(() => {
    pointerStartRef.current = null; touchIndicator.clear();
  }, [stream.inputReady, stream.connectionGeneration, sessionId, touchIndicator.clear]);
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
    if (readOnly || !stream.inputReady || session?.status !== 'running') return false;
    // Interactive commands must never escape a disconnected stream through HTTP.
    return stream.send(payload);
  }, [stream, readOnly, session?.status]);

  const navKey = (keyCode: number) => sendInput({ kind: 'key', keyCode });
  const point = (event: React.PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(stream.size.width - 1, Math.round((event.clientX - rect.left) / rect.width * stream.size.width))),
      y: Math.max(0, Math.min(stream.size.height - 1, Math.round((event.clientY - rect.top) / rect.height * stream.size.height))),
    };
  };

  const pointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!isRunning || readOnly || !stream.inputReady || !event.isPrimary || event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    touchIndicator.down(event);
    const position = point(event);
    const live = stream.inputReady && stream.format === 'video' && stream.send({ kind: 'touch', action: 'down', pointerId: 0, ...position });
    pointerStartRef.current = { ...position, time: Date.now(), pointerId: event.pointerId, live, lastMoveAt: 0, lastX: position.x, lastY: position.y };
    event.currentTarget.focus();
  };

  const pointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const start = pointerStartRef.current;
    if (!start || start.pointerId !== event.pointerId || !isRunning || !stream.inputReady) return;
    touchIndicator.move(event);
    if (!start.live) return;
    const now = performance.now();
    if (now - start.lastMoveAt < 20) return;
    const position = point(event);
    if (position.x === start.lastX && position.y === start.lastY) return;
    if (stream.send({ kind: 'touch', action: 'move', pointerId: 0, ...position })) {
      start.lastMoveAt = now; start.lastX = position.x; start.lastY = position.y;
    }
  };

  const pointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    touchIndicator.end(event);
    const start = pointerStartRef.current;
    if (!start || start.pointerId !== event.pointerId || !isRunning || !stream.inputReady) return;
    const end = point(event);
    if (start.live) {
      if (end.x !== start.lastX || end.y !== start.lastY) stream.send({ kind: 'touch', action: 'move', pointerId: 0, ...end });
      stream.send({ kind: 'touch', action: 'up', pointerId: 0, ...end });
    } else {
      const distance = Math.hypot(end.x - start.x, end.y - start.y);
    if (distance < Math.max(12, stream.size.width * 0.012)) sendInput({ kind: 'tap', x: end.x, y: end.y });
    else sendInput({ kind: 'swipe', x1: start.x, y1: start.y, x2: end.x, y2: end.y, durationMs: Math.max(80, Math.min(3000, Date.now() - start.time)) });
    }
    pointerStartRef.current = null;
  };

  const pointerCancel = (event: React.PointerEvent<HTMLDivElement>) => {
    touchIndicator.cancel(event);
    const start = pointerStartRef.current;
    if (start?.pointerId === event.pointerId) {
      if (start.live) stream.send({ kind: 'touch', action: 'up', pointerId: 0, x: start.lastX, y: start.lastY });
      pointerStartRef.current = null;
    }
  };

  const toggleRotate = async () => {
    if (!session) return;
    setBusy('rotate');
    try { setSession(await api.rotate(sessionId, session.orientation === 'landscape' ? 'portrait' : 'landscape')); onUpdated(); }
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
    if (!can(user, 'sessions.adb')) return;
    let active = true;
    const load = async () => {
      try {
        const result = await api.adbPortAccess(sessionId);
        if (active) { setAdbPortAccess(result.access); setAdbPortChecked(true); setAdbError(''); }
      } catch (error) {
        if (active) setAdbError(errorText(error));
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), 60_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [sessionId, user.permissions]);

  useEffect(() => {
    if (!can(user, 'sessions.adb')) return;
    let active = true;
    void api.adbUserKey().then(result => {
      if (active) { setAdbUserKey(result.key); setAdbKeyLoaded(true); }
    }).catch(error => {
      if (active) { setAdbError(errorText(error)); setAdbKeyLoaded(true); }
    });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!can(user, 'sessions.adb') || !adbKeyLoaded || !adbPortChecked || !adbUserKey || adbPortAccess || session?.status !== 'running' || session.ownerId !== user.id) return;
    const attempt = sessionId + ':' + adbUserKey.fingerprint;
    if (autoPortAttemptRef.current === attempt) return;
    autoPortAttemptRef.current = attempt;
    let active = true;
    void api.createAdbPortAccess(sessionId).then(access => {
      if (active) { setAdbPortAccess(access); setAdbError(''); }
    }).catch(error => { if (active) setAdbError(errorText(error)); });
    return () => { active = false; };
  }, [adbKeyLoaded, adbPortChecked, adbUserKey, adbPortAccess, session?.status, session?.ownerId, sessionId, user.id]);

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

  const closeAdbMenu = () => {
    if (newAdbKey && (!privateKeyDownloaded || !publicKeyDownloaded)) {
      setAdbError(t('ui.491d9de5b6e4'));
      return;
    }
    setAdbMenuOpen(false);
    setNewAdbKey(null);
    setConfirmKeyRotation(false);
    setAdbError('');
  };

  useEffect(() => {
    if (!adbMenuOpen) return;
    const closeOnOutside = (event: PointerEvent) => {
      if (!adbMenuRef.current?.contains(event.target as Node)) closeAdbMenu();
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeAdbMenu();
    };
    document.addEventListener('pointerdown', closeOnOutside);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutside);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [adbMenuOpen, newAdbKey, privateKeyDownloaded, publicKeyDownloaded]);

  useEffect(() => {
    if (!adbCopied) return;
    const timer = window.setTimeout(() => setAdbCopied(false), 2000);
    return () => window.clearTimeout(timer);
  }, [adbCopied]);

  const loadAdbPublicKey = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > 4096) { setAdbError(t('ui.a48c715e5538')); return; }
    try { setAdbPublicKey((await file.text()).trim()); setAdbError(''); }
    catch (error) { setAdbError(errorText(error)); }
  };

  const requestAdbPortAccess = async () => {
    if (showCustomAdbKey && !adbPublicKey.trim()) { setAdbError(t('ui.45097536e11d')); return; }
    if (!showCustomAdbKey && !adbUserKey) { setAdbError(t('ui.8abe8c4b8b33')); return; }
    setAdbBusy(true); setAdbError('');
    try {
      setAdbPortAccess(await api.createAdbPortAccess(sessionId, showCustomAdbKey ? adbPublicKey.trim() : undefined));
      if (!newAdbKey) setAdbMenuOpen(false);
    } catch (error) { setAdbError(errorText(error)); }
    finally { setAdbBusy(false); }
  };

  const createAdbUserKey = async (rotate: boolean) => {
    setAdbBusy(true); setAdbError('');
    try {
      const result = rotate ? await api.rotateAdbUserKey() : await api.createAdbUserKey();
      autoPortAttemptRef.current = sessionId + ':' + result.fingerprint;
      setAdbUserKey({ fingerprint: result.fingerprint, createdAt: result.createdAt });
      setNewAdbKey(result);
      setPrivateKeyDownloaded(false); setPublicKeyDownloaded(false);
      setShowCustomAdbKey(false); setAdbPublicKey('');
      setConfirmKeyRotation(false);
      if (rotate) setAdbPortAccess(null);
      if (session?.status === 'running' && session.ownerId === user.id) {
        try { setAdbPortAccess(await api.createAdbPortAccess(sessionId)); }
        catch (error) { setAdbError(t('ui.e2eb4e7f22a4') + errorText(error)); }
      }
    } catch (error) { setAdbError(errorText(error)); }
    finally { setAdbBusy(false); }
  };

  const revokeAdbPortAccess = async () => {
    setAdbBusy(true); setAdbError('');
    try { await api.revokeAdbPortAccess(sessionId); setAdbPortAccess(null); setAdbMenuOpen(false); }
    catch (error) { setAdbError(errorText(error)); }
    finally { setAdbBusy(false); }
  };

  const copyAdbCommand = async () => {
    if (!adbPortAccess) return;
    try {
      await navigator.clipboard.writeText('adb connect ' + adbPortAccess.host + ':' + adbPortAccess.port);
      setAdbCopied(true);
      setAdbError('');
    } catch (error) {
      setAdbError(t('ui.55bacb6557e6') + errorText(error));
      setAdbMenuOpen(true);
    }
  };

  const maxConsoleWidth = () => Math.max(320, (workspaceRef.current?.clientWidth ?? 1400) - 344);
  const clampConsoleWidth = (value: number) => Math.max(320, Math.min(maxConsoleWidth(), Math.round(value)));
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
    const minimum = dimension === 'width' ? 320 : 180;
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

  const sendText = (event: React.FormEvent) => {
    event.preventDefault();
    if (!textInput) return;
    if (sendInput({ kind: 'text', text: textInput })) setTextInput('');
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

  const chooseDeviceFiles = (apkOnly = false) => {
    const input = fileInputRef.current;
    if (!input) return;
    input.accept = apkOnly ? '.apk,.apks' : '';
    input.click();
  };

  const [toolTab, setToolTab] = useState<ToolTabId>('console');
  const availableToolTabs = toolTabs().filter(([id, , capability]) => hasCapability(session, capability) && toolAllowed(id));
  useEffect(() => {
    const allowed = toolTabs().filter(([id, , capability]) => hasCapability(session, capability) && toolAllowed(id)).map(([id]) => id);
    if (allowed.length && !allowed.includes(toolTab)) setToolTab(allowed[0]!);
  }, [session, toolTab, user.permissions]);
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
      if (output && terminal && output.getBoundingClientRect().height > 0) {
        const outputBox = output.getBoundingClientRect();
        const terminalBox = terminal.getBoundingClientRect();
        const chrome = (terminalBox.height - outputBox.height) / scale;
        setPx('--session-console-output-fit', Math.max(180, available - chrome));
        const width = Math.round(terminalBox.width / scale), height = Math.round(outputBox.height / scale);
        setVisibleConsoleSize(previous => previous.width === width && previous.height === height ? previous : { width, height });
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
  const isRunning = session?.status === 'running';
  const canControl = isRunning && !readOnly && stream.inputReady;
  const audioStatus = ({ disabled: t('ui.5a577d905660'), connecting: t('ui.bd3e94ec1557'), waiting: t('ui.ce51f08bf71c'), unlock: t('ui.e8d306f3eaae'), receiving: t('ui.1b4deda45c35'), unavailable: t('ui.53ba89acf405') })[stream.audioState];
  const idleWarning = session?.status === 'running' && session.ownerId === user.id && idleLeftMs !== null && idleLeftMs <= 10 * 60_000 && <div className="banner-warning session-idle-warning" role="status">
      <Icon name="alert" size={17} /><span title={t('ui.e1a23d943344')}>{t('ui.23411ebbf4b5')}{Math.max(1, Math.ceil(idleLeftMs / 60_000))} {t('ui.09c856218d5a')}</span>
      <button type="button" className="button primary small" onClick={() => void extendSession()}>{t('ui.659ad690ef24')}</button>
    </div>;
  const frameWidth = Math.max(1, stream.size.width);
  const frameHeight = Math.max(1, stream.size.height);
  const viewerWidth = Math.max(compactWorkspace ? 320 : 440, Math.ceil(stageSize.height * frameWidth / frameHeight + stageHorizontalPadding + 2));
  const displayScale = Math.min(Math.max(0, stageSize.width) / frameWidth, Math.max(0, stageSize.height) / frameHeight);

  return <div className="session-layout" data-shared={shared ? access : undefined} data-workspace-mode={activeWorkspaceMode}>
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
              mode={connectionMode} onModeChange={mode => { pointerStartRef.current = null; touchIndicator.clear(); setConnectionMode(mode); }} metrics={stream.metrics} audioTransport={stream.audioTransport}
              audioEnabled={audioEnabled} audioState={stream.audioState} audioNotice={stream.audioNotice} audioBusy={!isRunning || busy === 'audio'} audioPending={busy === 'audio'}
              onUnlockAudio={stream.unlockAudio} onToggleAudio={!shared && can(user, 'sessions.control') && hasCapability(session, 'audio') ? () => void toggleAudio() : undefined} />}
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
                {adbPortAccess && <button type="button" className="adb-copy-command" onClick={() => void copyAdbCommand()} aria-label={t('ui.4d9c463d9cba') + adbPortAccess.host + ':' + adbPortAccess.port}><code>{t('ui.51a9e8b802ee')}{adbPortAccess.host}:{adbPortAccess.port}</code><Icon name={adbCopied ? 'check' : 'copy'} size={16} /><span>{adbCopied ? t('ui.d2d08c715ee6') : t('ui.1ecddf40bfeb')}</span></button>}
                {newAdbKey ? <div className="adb-key-created" role="status">
                  <strong>{t('ui.06f0d3f8fdd3')}</strong>
                  <p>{t('ui.005d4775f887')}<code>{t('ui.d8c2bd5fbdbf')}</code> {t('ui.884d27bf5972')}<code>{t('ui.8694fc709bdb')}</code> {t('ui.21db14e45f66')}<code>{t('ui.9702ab6bff62')}</code>{t('ui.8a55c8a46eba')}<code>{t('ui.a14576083aa4')}</code>{t('ui.1c262c92b3bf')}<code>{t('ui.8694fc709bdb')}</code> {t('ui.c488a5622e48')}<code>{t('ui.42ba82468cd4')}</code>.</p>
                  <div className="adb-key-downloads">
                    <button type="button" className="button primary" onClick={() => { downloadKeyFile('adbkey', newAdbKey.privateKey); setPrivateKeyDownloaded(true); }}><Icon name="download" size={15} />{privateKeyDownloaded ? t('ui.9f0fe20e39c8') : t('ui.e5324bf11872')}</button>
                    <button type="button" className="button outline" onClick={() => { downloadKeyFile('adbkey.pub', newAdbKey.publicKey); setPublicKeyDownloaded(true); }}><Icon name="download" size={15} />{publicKeyDownloaded ? t('ui.c3869d7ed2b5') : t('ui.49a05eedd8f1')}</button>
                  </div>
                  <p className="adb-key-hint">{t('ui.58fddcf09540')}<code>{t('ui.da641bf87627')}</code>{t('ui.ba49e5d7ab3a')}</p>
                  <div className="adb-popover-actions"><button type="button" className="button subtle" onClick={closeAdbMenu} disabled={!privateKeyDownloaded || !publicKeyDownloaded}>{t('ui.ef05d57959cf')}</button><button type="button" className="text-button danger-text" onClick={() => { setNewAdbKey(null); setAdbMenuOpen(false); setAdbError(''); }}>{t('ui.74f4e22caf07')}</button></div>
                </div> : <>
                  {adbUserKey ? <div className="adb-key-status"><Icon name="shield" size={17} /><div><strong>{t('ui.5b9558b15ecc')}</strong><small>{t('ui.99fe43c51b56')}{adbUserKey.fingerprint}</small></div></div> : <div className="adb-key-intro"><p>{t('ui.16a1b5eb0d5d')}</p><button type="button" className="button primary" onClick={() => void createAdbUserKey(false)} disabled={adbBusy || !adbKeyLoaded}>{adbBusy ? t('ui.c2f23e83210c') : t('ui.d221d47fee4d')}</button></div>}
                  {(adbUserKey || adbPortAccess) && <div className="adb-port-section">
                    {adbPortAccess ? <><p>{t('ui.31916eacca58')}<code>{adbPortAccess.host}:{adbPortAccess.port}</code> {t('ui.891576d109dd')}{adbPortAccess.expiresAt ? t('ui.2448cce22076') + timeLabel(adbPortAccess.expiresAt) : t('ui.897db6e39f60')}.</p><button type="button" className="text-button" onClick={() => void revokeAdbPortAccess()} disabled={adbBusy}>{t('ui.79d8d58afd9c')}</button></> : <><p>{t('ui.ada4a19abb8b')}</p><button type="button" className="button subtle" onClick={() => void requestAdbPortAccess()} disabled={!isRunning || adbBusy}>{adbBusy ? t('ui.06b7aac26fa7') : t('ui.992a5e672c16')}</button></>}
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
                {!isPreparing && <><div><dt>{t('ui.c476ef70003f')}</dt><dd>{stream.status === 'live' ? stream.transport === 'webrtc' ? 'WebRTC' : stream.format === 'video' ? 'WebSocket · scrcpy' : t('ui.3dce224a18f5') : t('ui.bd3e94ec1557')}</dd></div><div><dt>{t('ui.6a40ca96136a')}</dt><dd>{audioStatus}{stream.audioNotice ? ': ' + stream.audioNotice : ''}</dd></div></>}
              </dl>
              {!shared && !isPreparing && <p>{session?.ownerId === user.id ? t('ui.bb561792253b') : t('ui.113a937fb02e')}{audienceDescription(audience)}</p>}
              {session?.adminAccess && session.ownerId === user.id && <p>{t('ui.0d661f96ac3a')}{session.adminAccess.username} {t('ui.4d55a1c971e2')}{timeLabel(session.adminAccess.at)}{t('ui.f76f7997d0bb')}</p>}</div>
            </details>
        </div>
        {!shared && !isPreparing && <div className="workspace-mode-bar" role="group" aria-label={t('ui.7920d43e70db')}>
          <div className="workspace-mode-buttons">
            {!compactWorkspace && <button type="button" aria-pressed={activeWorkspaceMode === 'split'} onClick={() => changeWorkspaceMode('split')}><Icon name="grid" size={16} />{t('ui.de5c415b1d45')}</button>}
            <button type="button" aria-pressed={activeWorkspaceMode === 'screen'} onClick={() => changeWorkspaceMode('screen')}><Icon name="phone" size={16} />{t('ui.c062341615dc')}</button>
            <button type="button" aria-pressed={activeWorkspaceMode === 'tools'} onClick={() => changeWorkspaceMode('tools')}><Icon name="terminal" size={16} />{t('ui.4e90074f740b')}</button>
          </div>
        </div>}
      </div>
    </div>

    {idleWarning}
    {session?.status === 'running' && hardLeftMs !== null && hardLeftMs <= 30 * 60_000 && <div className="banner-warning" role="status">
      <Icon name="alert" size={17} /><span>{t('ui.9816527fe543')}{new Date(session.expiresAt!).toLocaleTimeString(getLocale(), { hour: '2-digit', minute: '2-digit' })}{t('ui.890cd2f8e8f4')}</span>
    </div>}
    {shared && <SharedBanner ownerName={session?.ownerName} mode={access === 'view' ? 'view' : 'control'} />}
    {sessionError && <div className="banner-error" role="alert"><Icon name="alert" size={17} />{localizeText(sessionError)}<button onClick={() => void refresh()}>{t('ui.5189135a6110')}</button></div>}
    {isPreparing ? <SessionStartupProgress progress={session?.startupProgress}/> : <>
    <div className="workspace-grid" data-console-resized={consoleResized || undefined} ref={workspaceRef} style={{ '--console-width': consoleWidth + 'px', '--viewer-width': viewerWidth + 'px' } as CSSProperties}>
      <section className="viewer-panel" aria-label={t('ui.4547b46d3c0c')}>
        <div className="device-controls">
          <div className="control-group"><button data-tip={t('ui.1a9fb1f3cf8e')} title={t('ui.1a9fb1f3cf8e')} aria-label={t('ui.1a9fb1f3cf8e')} onClick={() => navKey(4)} disabled={!canControl}><Icon name="back" size={19} /></button><button data-tip={t('ui.f6e01d413ff6')} title={t('ui.f6e01d413ff6')} aria-label={t('ui.f6e01d413ff6')} onClick={() => navKey(3)} disabled={!canControl}><Icon name="home" size={19} /></button><button data-tip={t('ui.2d7ce9a5379c')} title={t('ui.2d7ce9a5379c')} aria-label={t('ui.2d7ce9a5379c')} onClick={() => navKey(187)} disabled={!canControl}><Icon name="recent" size={19} /></button></div>
          <span className="controls-divider" />
          <div className="control-group">{hasCapability(session, 'rotate') && <button className="owner-only" data-tip={t('ui.4bfe24c8f020')} title={t('ui.4bfe24c8f020')} aria-label={t('ui.4bfe24c8f020')} onClick={() => void toggleRotate()} disabled={!isRunning || busy === 'rotate'}><Icon name="rotate" size={19} /></button>}<button data-tip={t('ui.187b90793015')} title={t('ui.187b90793015')} aria-label={t('ui.187b90793015')} onClick={() => navKey(164)} disabled={!canControl}><Icon name="volumeOff" size={19} /></button><button data-tip={t('ui.d32a29ef600e')} title={t('ui.d32a29ef600e')} aria-label={t('ui.d32a29ef600e')} onClick={() => navKey(24)} disabled={!canControl}><Icon name="plus" size={19} /></button><button data-tip={t('ui.e199c10f2526')} title={t('ui.e199c10f2526')} aria-label={t('ui.e199c10f2526')} onClick={() => navKey(25)} disabled={!canControl}><Icon name="minus" size={19} /></button><button data-tip={t('ui.ffe25dd2be73')} title={t('ui.ffe25dd2be73')} aria-label={t('ui.ffe25dd2be73')} onClick={() => navKey(26)} disabled={!canControl}><Icon name="power" size={18} /></button></div>
          <span className="controls-divider" />
          {hasCapability(session, 'network') && <button className={'network-toggle owner-only' + (networkEnabled ? ' enabled' : '')} data-tip={t('ui.9a8556f40eb0')} title={t('ui.9a8556f40eb0')} aria-label={networkEnabled ? t('ui.1866e096f838') : t('ui.fcfc99f6b5e8')} onClick={() => void toggleNetwork()} disabled={!isRunning || busy === 'network'}><Icon name={networkEnabled ? 'wifi' : 'wifiOff'} size={17} />{t('ui.13aa6284b1ae')}<span>{networkEnabled ? t('ui.ea20b8f6d311') : t('ui.70f71197033b')}</span></button>}
          <span className="controls-divider" />
          {can(user, 'sessions.files') && <button type="button" className="upload-control owner-only" data-tip={t('ui.b59947f1458d')} title={t('ui.b59947f1458d')} aria-label={t('ui.f48012de6546')} onClick={() => chooseDeviceFiles()} disabled={!isRunning || uploading.length > 0}>{uploading.length ? <span className="mini-spinner" /> : <Icon name="upload" size={17} />}<span>{t('ui.9088ca9c0de9')}</span></button>}
          <input ref={fileInputRef} type="file" multiple hidden onChange={event => { if (event.target.files) void uploadFiles(event.target.files); event.target.value = ''; }} />
          <button type="button" className="capture-control" data-tip={t('ui.02ea85d55701')} title={t('ui.02ea85d55701')} aria-label={t('ui.02ea85d55701')} onClick={() => void capture.takeScreenshot()} disabled={!captureReady || !capture.screenshotSupported}><Icon name="camera" size={17} /><span>{t('ui.77a2f659d70e')}</span></button>
          <button type="button" className={'capture-control' + (capture.recording ? ' recording' : '')} data-tip={capture.recording ? t('ui.ea0f675f3aab') : t('ui.c085454ef117')} title={capture.recording ? t('ui.ea0f675f3aab') : t('ui.c085454ef117')} aria-label={capture.saving ? t('ui.8d839c3234cd') : capture.recording ? t('ui.29efbde7481a') : t('ui.4e087745e0a4')} aria-pressed={capture.recording} onClick={capture.recording ? capture.stopRecording : capture.startRecording} disabled={capture.saving || (!capture.recording && (!captureReady || !capture.recordingSupported))}>{capture.saving ? <span className="mini-spinner" /> : <Icon name={capture.recording ? 'stop' : 'record'} size={16} />}<span>{capture.saving ? t('ui.9c27c381dd8b') : capture.recording ? t('ui.29f94d1a41ca') + captureTime(capture.elapsedSeconds) : t('ui.db10366f5370')}</span></button>
        </div>
        <div className="viewer-stage" ref={screenRef} onDragEnter={dragEnter} onDragOver={dragOver} onDragLeave={dragLeave} onDragEnd={() => { dragDepthRef.current = 0; setDragging(false); }} onDrop={dropFiles}>
          <div className={'device-screen ' + (stream.size.width > stream.size.height ? 'landscape' : 'portrait')} style={{ width: stream.size.width * displayScale + 'px', height: stream.size.height * displayScale + 'px' }}>
            <img ref={stream.imageRef} alt={t('ui.b4a6c9bc414c')} className={stream.format === 'image' ? 'active-frame' : ''} draggable={false} onLoad={() => setImageFrameReady(true)} onError={() => setImageFrameReady(false)} />
            <canvas ref={stream.canvasRef} className={stream.format === 'video' ? 'active-frame' : ''} />
            <div className="touch-layer" role="application" aria-label={t('ui.684de2e969ef')} tabIndex={readOnly ? -1 : 0} onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={pointerCancel} onLostPointerCapture={pointerCancel} onKeyDown={event => { if (event.key === 'Escape' || event.key === 'Backspace') { event.preventDefault(); navKey(4); } else if (event.key === 'Enter') { event.preventDefault(); navKey(66); } else if (event.key.startsWith('Arrow')) { event.preventDefault(); navKey(({ ArrowUp: 19, ArrowDown: 20, ArrowLeft: 21, ArrowRight: 22 } as Record<string, number>)[event.key]); } }}><span ref={touchIndicator.markerRef} className="session-touch-marker" aria-hidden="true" hidden /></div>
            {(session && (session.status === 'error' || (session.error && (session.status === 'stopping' || session.status === 'stopped')))) ? <div className="stream-placeholder"><div className="placeholder-device"><Icon name="alert" size={34}/></div><h3>{t('ui.f70ff6228697')}</h3><p>{session.error || t('ui.2a05b00bc38f')}</p></div> : stream.status !== 'live' && <div className="stream-placeholder"><div className="placeholder-device"><Icon name="phone" size={38} /></div><h3>{stream.status === 'connecting' ? t('ui.bd77b9fa4fd6') : stream.status === 'unsupported' ? t('ui.3a6ec360f375') : t('ui.fb3ce9cae1e8')}</h3><p>{stream.streamError || t('ui.ebcb4d3177c6')}</p>{stream.status !== 'connecting' && <button className="button ghost-light" onClick={stream.reconnect}><Icon name="refresh" size={16} />{t('ui.2de34a1774f6')}</button>}</div>}
            {dragging && <div className="drop-overlay"><Icon name="upload" size={34} /><strong>{t('ui.9c12eed10791')}</strong><span>{t('ui.4b2f4b989bf1')}</span></div>}
          </div>
        </div>
      </section>
      {(!shared || !readOnly) && <section className={'tool-panel ' + (shared ? 'shared-text-tools' : 'terminal-panel')} aria-label={t('ui.fecfbc6e1053')} data-active-tool={toolTab} data-console-height-resized={!shared && consoleHeightResized && toolTab === 'console' && !catalogOpen || undefined}>
        {shared ? <h2 className="shared-tools-title">{t('ui.4e90074f740b')}</h2> : <>
        <div className="tool-tabs" role="tablist" aria-label={t('ui.fecfbc6e1053')} onKeyDown={event => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) || !availableToolTabs.length) return;
          event.preventDefault();
          const current = availableToolTabs.findIndex(([id]) => id === toolTab);
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? availableToolTabs.length - 1
            : (current + (event.key === 'ArrowLeft' ? -1 : 1) + availableToolTabs.length) % availableToolTabs.length;
          const id = availableToolTabs[next][0];
          setToolTab(id);
          event.currentTarget.querySelector<HTMLButtonElement>('#tool-tab-' + id)?.focus();
        }}>{availableToolTabs.map(([id, label]) => <button key={id} type="button" role="tab" id={'tool-tab-' + id} aria-controls={'tool-panel-' + id} aria-selected={toolTab === id} tabIndex={toolTab === id ? 0 : -1} className={toolTab === id ? 'active' : ''} onClick={() => setToolTab(id)}>{label}</button>)}</div>
        <div className="console-width-handle" role="separator" aria-orientation="vertical" aria-label={t('ui.aad9553c58e7')} aria-valuemin={320} aria-valuemax={maxConsoleWidth()} aria-valuenow={visibleConsoleSize.width || Math.min(consoleWidth, maxConsoleWidth())} tabIndex={0} onPointerDown={startWidthResize} onPointerMove={moveWidthResize} onPointerUp={endWidthResize} onPointerCancel={endWidthResize} title={t('ui.84def31d6544')} onKeyDown={event => resizeConsoleWithKeyboard(event, 'width')}><span /></div>
        <div className="tool-content terminal-tool" id="tool-panel-console" role="tabpanel" aria-labelledby="tool-tab-console" data-catalog-open={catalogOpen || undefined} style={toolAllowed('console') && toolTab === 'console' ? undefined : { display: 'none' }}>
          <div className="terminal-topline"><div className="tool-header"><h2>{t('ui.415b2ea14558')}</h2><p>{t('ui.5a8b4be5b13d')}</p></div><div className="terminal-header-actions"><button type="button" className="console-size-reset icon-button" title={t('ui.acb4297e7d57')} aria-label={t('ui.acb4297e7d57')} onClick={resetConsoleSize} disabled={!consoleResized && !consoleHeightResized}><Icon name="refresh" size={16} /></button><button type="button" className="console-catalog-toggle" aria-expanded={catalogOpen} aria-controls="console-catalog-panel" onClick={() => { setSuggestionsOpen(false); setCatalogOpen(open => !open); }}>{t('ui.3c69ec43782e')}{getConsoleCommands().length}</button><button type="button" className="terminal-clear" onClick={() => setShellHistory([])} disabled={!shellHistory.length} title={t('ui.20dd55101aa2')}>{t('ui.8965271d3c97')}</button></div></div>
          <div className="terminal-output" ref={terminalOutputRef} style={{ height: consoleHeight }} aria-live="polite">{shellHistory.length ? shellHistory.map((line, index) => <div className="terminal-entry" key={index}><div className="terminal-command"><span aria-hidden="true">{t('ui.77d57e39b407')}</span> {line.command}</div>{line.result?.stdout && <pre>{line.result.stdout}</pre>}{line.result?.stderr && <pre className="terminal-stderr">{line.result.stderr}</pre>}{line.error && <pre className="terminal-stderr">{line.error}</pre>}{line.result && <small>{t('ui.a1e1777a4cb9')}{line.result.exitCode}</small>}</div>) : <div className="terminal-empty"><strong>{t('ui.fadad01443a1')}</strong><p>{t('ui.087d5eca2dbf')}</p></div>}{shellBusy && <div className="terminal-running"><span className="mini-spinner" />{t('ui.176e44dd22ac')}</div>}</div>
          <div className="console-height-handle" role="separator" aria-orientation="horizontal" aria-label={t('ui.61c0f7efe428')} aria-valuemin={180} aria-valuemax={maxConsoleHeight()} aria-valuenow={visibleConsoleSize.height || Math.min(consoleHeight, maxConsoleHeight())} tabIndex={0} onPointerDown={startHeightResize} onPointerMove={moveHeightResize} onPointerUp={endHeightResize} onPointerCancel={endHeightResize} title={t('ui.828ce3497805')} onKeyDown={event => resizeConsoleWithKeyboard(event, 'height')}><span /></div>
          <div className="terminal-input-wrap">
            {catalogOpen && <div className="console-catalog" id="console-catalog-panel" aria-label={t('ui.0bf2af623b6f')} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); setCatalogOpen(false); commandInputRef.current?.focus(); } }}>
              <div className="console-catalog-search"><input value={catalogQuery} onChange={event => setCatalogQuery(event.target.value)} placeholder={t('ui.d65f680ec9dc')} aria-label={t('ui.a8ea2fb17773')} /><span>{catalogResults.length} {t('ui.de51fb40b939')}</span></div>
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
                    {hint.action === 'upload-apk' && <button type="button" className="console-catalog-insert" onClick={() => { setCatalogOpen(false); setToolTab('apps'); changeWorkspaceMode('tools'); }}>{t('ui.ce084d29dc24')}</button>}
                  </div>}
                  {hint.access === 'external' && can(user, 'sessions.adb') && <button type="button" className="console-catalog-insert" onClick={() => { setAdbMenuOpen(true); adbMenuRef.current?.scrollIntoView({ block: 'start', behavior: 'instant' }); }}>{t('ui.31803f334db2')}</button>}
                </div>) : <div className="console-catalog-empty">{t('ui.532865cd567e')}</div>}
              </div>
            </div>}
            {suggestionsOpen && suggestions.length > 0 && <div className="console-suggestions" id="console-command-hints" role="listbox" aria-label={t('ui.a811e7886752')}>
              {suggestions.map((hint, index) => <button key={hint.access + ':' + hint.command} id={'console-hint-' + index} type="button" role="option" aria-selected={suggestionIndex === index} className={suggestionIndex === index ? 'selected' : ''} onPointerDown={event => event.preventDefault()} onClick={() => insertConsoleHint(hint)}><span><strong>{hint.label}</strong><code>{hint.command}</code></span><small>{hint.access === 'console' ? hint.dynamic ? t('ui.9d822e803d95') : hint.category : hint.access === 'upload' ? t('ui.50dfcd25c152') : t('ui.d5077a203455')}</small></button>)}
              <div className="console-suggestions-help">{t('ui.2c3ffc82a569')}</div>
            </div>}
            <form className="terminal-input" onSubmit={runCommand}><span aria-hidden="true">{t('ui.77d57e39b407')}</span><input ref={commandInputRef} value={command} onChange={event => { setCommand(event.target.value); setCatalogOpen(false); setConsoleNotice(''); setHistoryIndex(null); setSuggestionIndex(-1); setSuggestionsOpen(Boolean(event.target.value.trim())); }} onFocus={() => { setCatalogOpen(false); if (command.trim()) setSuggestionsOpen(true); }} onBlur={() => setSuggestionsOpen(false)} onKeyDown={handleCommandKeyDown} placeholder={t('ui.c4f762e79442')} aria-label={t('ui.2c167f49ad58')} aria-autocomplete="list" aria-controls="console-command-hints" aria-expanded={suggestionsOpen && suggestions.length > 0} aria-activedescendant={suggestionsOpen && suggestionIndex >= 0 ? 'console-hint-' + suggestionIndex : undefined} disabled={!isRunning || shellBusy} spellCheck={false} autoComplete="off" /><button type="submit" disabled={!command.trim() || !isRunning || shellBusy} aria-label={t('ui.74f37caa1f86')}><Icon name="arrowRight" size={18} /></button></form>{consoleNotice && <div className="console-notice" role="alert">{consoleNotice}</div>}
          </div>
        </div>
        <LogcatPanel panelId="tool-panel-logs" sessionId={sessionId} active={toolAllowed('logs') && toolTab === 'logs'} running={isRunning} />
        <DeviceInfoPanel panelId="tool-panel-info" sessionId={sessionId} active={toolTab === 'info'} running={isRunning} />
        <EnvPanel panelId="tool-panel-env" sessionId={sessionId} active={toolTab === 'env'} running={canReadEnvironment} readForViewer={!shared && can(user, 'sessions.env') && hasCapability(session, 'env')} onShowTouchesChange={touchIndicator.setEnabled} nativeTouches={stream.nativeTouches} />
        <AppsPanel panelId="tool-panel-apps" sessionId={sessionId} active={toolAllowed('apps') && toolTab === 'apps'} running={isRunning} />
        </>}
        <form className="text-send" onSubmit={sendText} aria-label={t('ui.8565dde56e60')}><Icon name="keyboard" size={18} /><input value={textInput} onChange={event => setTextInput(event.target.value)} placeholder={t('ui.8565dde56e60')} aria-label={t('ui.dd844df0eed4')} disabled={!canControl || readOnly} /><button type="submit" disabled={!canControl || readOnly || !textInput}>{t('ui.d3aa8669598a')}<Icon name="arrowRight" size={16} /></button></form>
      </section>}
    </div>
    </>}
  </div>;
}
