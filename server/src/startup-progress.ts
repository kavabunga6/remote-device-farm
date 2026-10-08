import { uiMessage } from './messages.js';
export const STARTUP_STAGES = ['checking_image', 'waiting_image', 'downloading', 'creating', 'booting', 'ready'] as const;
export type StartupStage = typeof STARTUP_STAGES[number];
export type StartupProgress = { stage: StartupStage; currentBytes?: number; totalBytes?: number; percent?: number; updatedAt: string };
export const STANDARD_START_TIMEOUT_MS = 60 * 60_000;
export const START_CANCEL_TIMEOUT_MS = 60 * 60_000;

/** Keep numerical progress only. Build logs, arbitrary detail text and timestamps from agents are never trusted. */
export function cleanStartupProgress(input: unknown, now = Date.now()): StartupProgress | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const source = input as Record<string, unknown>;
  if (!(STARTUP_STAGES as readonly unknown[]).includes(source.stage)) return null;
  const result: StartupProgress = { stage: source.stage as StartupStage, updatedAt: new Date(now).toISOString() };
  const bytes = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 1024 ** 4;
  if (bytes(source.currentBytes)) result.currentBytes = source.currentBytes as number;
  if (bytes(source.totalBytes) && Number(source.totalBytes) > 0) result.totalBytes = source.totalBytes as number;
  if (result.currentBytes !== undefined && result.totalBytes !== undefined && result.currentBytes > result.totalBytes) {
    delete result.currentBytes; delete result.totalBytes;
  }
  if (typeof source.percent === 'number' && Number.isFinite(source.percent) && source.percent >= 0 && source.percent <= 100) {
    result.percent = Math.round(source.percent * 10) / 10;
  }
  return result;
}
export function storedStartupProgress(value: unknown): StartupProgress | null {
  const timestamp = (value && typeof value === 'object' && !Array.isArray(value)) ? (value as Record<string, unknown>).updatedAt : undefined;
  if (typeof timestamp !== 'string' || !Number.isFinite(Date.parse(timestamp))) return null;
  return cleanStartupProgress(value, Date.parse(timestamp));
}

/** Public failure reasons are fixed product messages, never Docker output or image credentials. */
export function startupFailureMessage(progress: unknown, error?: unknown): string {
  if (error instanceof Error && error.message === 'Emulator container stopped before Android finished booting') {
    return uiMessage('ui.b5ef4c66e768');
  }
  if (error instanceof Error && error.message === 'Requested GPU backend is not available on this node') {
    return uiMessage('ui.2abca2c47aa2');
  }
  if (error instanceof Error && error.message === 'Guest memory cannot be applied by this image profile; enable the memory farm flag or declare MEMORY') {
    return uiMessage('ui.be9941cc3cf1');
  }
  if (error instanceof Error && error.message === 'Guest cores cannot be applied by this image profile; enable the cores farm flag or declare CORES') {
    return uiMessage('ui.87edf34a35ed');
  }
  const stage = storedStartupProgress(progress)?.stage;
  if (stage === 'downloading') return uiMessage('ui.88572fbdd6ba');
  if (stage === 'booting') return uiMessage('ui.f9879deac0e1');
  return uiMessage('ui.e9279c7e7b8f');
}
