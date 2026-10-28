import { getLocale, t } from './i18n';
import type { StartupProgress } from './api';

export const STARTUP_STAGE_LABELS: Record<StartupProgress['stage'], string> = {
  get checking_image() { return t('ui.7186985a1acb'); },
  get waiting_image() { return t('ui.90e7a4b6428c'); },
  get downloading() { return t('ui.91c089ebbf25'); },
  get creating() { return t('ui.7eb3c7348e78'); },
  get booting() { return t('ui.09f48b9a7a0e'); },
  get ready() { return t('ui.7e777de00138'); },
};
export function startupStage(progress?: StartupProgress | null): StartupProgress['stage'] | null {
  return progress && Object.hasOwn(STARTUP_STAGE_LABELS, progress.stage) ? progress.stage : null;
}
const validNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
export function startupPercent(progress?: StartupProgress | null): number | undefined {
  const stage = startupStage(progress);
  // Device readiness does not measure the screen connection that follows it.
  if (!stage || stage === 'ready') return undefined;
  if (validNumber(progress?.percent)) return Math.min(100, progress.percent);
  if (validNumber(progress?.currentBytes) && validNumber(progress?.totalBytes) && progress.totalBytes > 0) return Math.min(100, progress.currentBytes / progress.totalBytes * 100);
  return undefined;
}
export function startupBytes(bytes: number): string {
  const units = [t('ui.c78364c5d0f2'), t('ui.68822434b2f5'), t('ui.7b78230fdc2b'), t('ui.6bcfd5d5afe5')];
  const index = bytes > 0 ? Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024))) : 0;
  return new Intl.NumberFormat(getLocale(), { maximumFractionDigits: index === 0 ? 0 : 1 }).format(bytes / 1024 ** index) + ' ' + units[index];
}
export function startupTransfer(progress?: StartupProgress | null): string | undefined {
  if (!validNumber(progress?.currentBytes)) return undefined;
  const current = startupBytes(progress.currentBytes);
  return validNumber(progress.totalBytes) && progress.totalBytes > 0 && progress.totalBytes >= progress.currentBytes ? t('copy.startup-progress.7667c197', { p0: current, p1: startupBytes(progress.totalBytes) }) : current;
}
export function startupSummary(progress?: StartupProgress | null): string {
  const stage = startupStage(progress);
  const percent = startupPercent(progress);
  return (stage ? STARTUP_STAGE_LABELS[stage] : t('ui.b2b1ed0062b5')) + (percent == null ? '' : ' · ' + Math.round(percent) + '%');
}
