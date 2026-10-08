import { t } from './i18n';
import type { Profile, SessionLaunchOptions } from './api';

export const LAUNCH_RESOURCE_LIMITS = {
  cpu: { min: 1, max: 16, get label() { return t('ui.8ae6d0b53b58'); } },
  memoryMb: { min: 1024, max: 65536, get label() { return t('ui.01e4c4609286'); } },
  guestCores: { min: 1, max: 16, get label() { return t('ui.849635da03ef'); } },
  guestMemoryMb: { min: 1024, max: 64512, get label() { return t('ui.43ec81e4a9a8'); } },
} as const;
export type LaunchResourceField = keyof typeof LAUNCH_RESOURCE_LIMITS;
const RESOURCE_FIELDS = Object.keys(LAUNCH_RESOURCE_LIMITS) as LaunchResourceField[];
export type LaunchDraft = { diskGb?: string; sdCardMb?: string; emulatorParams?: string; privileged?: boolean;
  cpu?: string; memoryMb?: string; guestCores?: string | null; guestMemoryMb?: string | null };
function resourceValueError(field: LaunchResourceField, value: unknown): string {
  const { min, max, label } = LAUNCH_RESOURCE_LIMITS[field];
  return Number.isInteger(value) && Number(value) >= min && Number(value) <= max ? '' : t('ui.76d12078828f', { p0: label, p1: min, p2: max });
}
/** The stored profile remains unchanged; null explicitly preserves an image's Android defaults. */
export function effectiveLaunchProfile<T extends Profile>(profile: T, options: SessionLaunchOptions = {}): T {
  const result = { ...profile };
  for (const field of RESOURCE_FIELDS) if (options[field] !== undefined) Object.assign(result, { [field]: options[field] });
  return result;
}
/** Validate the requested resources against the effective container and the caller's profile allowance. */
export function launchResourceError(profile: Profile | undefined, options: SessionLaunchOptions = {}, canConfigureContainer = false): string {
  for (const field of RESOURCE_FIELDS) {
    const value = options[field];
    if (value === undefined || (value === null && (field === 'guestCores' || field === 'guestMemoryMb'))) continue;
    const error = resourceValueError(field, value);
    if (error) return error;
  }
  if (!profile) return '';
  if (!canConfigureContainer) {
    if (options.cpu !== undefined && options.cpu > Number(profile.cpu)) return t('ui.ceb6d7a6faf6', { p0: profile.cpu });
    if (options.memoryMb !== undefined && options.memoryMb > Number(profile.memoryMb)) return t('ui.750f4c147132', { p0: profile.memoryMb });
  }
  const effective = effectiveLaunchProfile(profile, options);
  if (effective.guestCores != null) {
    const error = resourceValueError('guestCores', effective.guestCores);
    if (error) return error;
    if (effective.guestCores > Number(effective.cpu)) return t('ui.1ec51e7787ab');
  }
  if (effective.guestMemoryMb != null) {
    const error = resourceValueError('guestMemoryMb', effective.guestMemoryMb);
    if (error) return error;
    if (effective.guestMemoryMb > Number(effective.memoryMb) - 1024) return t('ui.f069004e5599');
  }
  return '';
}
export function parseLaunchDraft(draft: LaunchDraft): { options: SessionLaunchOptions; error: string } {
  const options: SessionLaunchOptions = {};
  if (draft.privileged !== undefined) options.privileged = draft.privileged;
  for (const field of RESOURCE_FIELDS) {
    const raw = draft[field];
    if (raw === null && (field === 'guestCores' || field === 'guestMemoryMb')) { options[field] = null; continue; }
    if (raw == null || raw === '') continue;
    if (!/^\d+$/.test(raw)) return { options, error: t('ui.869520228ba5', { p0: LAUNCH_RESOURCE_LIMITS[field].label }) };
    const value = Number(raw), error = resourceValueError(field, value);
    if (error) return { options, error };
    options[field] = value;
  }
  for (const field of ['diskGb', 'sdCardMb'] as const) {
    const raw = draft[field];
    if (raw == null || raw === '') continue;
    if (!/^\d+$/.test(raw)) return { options, error: t('ui.74bf843cbcdb') };
    const value = Number(raw);
    if (field === 'diskGb' && (value < 2 || value > 128)) return { options, error: t('ui.30d64465d83f') };
    if (field === 'sdCardMb' && value !== 0 && (value < 128 || value > 32768)) return { options, error: t('ui.1494875d3ea7') };
    options[field] = value;
  }
  if (draft.emulatorParams !== undefined) {
    if (draft.emulatorParams.length > 500) return { options, error: t('ui.122cf20817f8') };
    options.emulatorParams = draft.emulatorParams.trim().replace(/\s+/g, ' ');
  }
  return { options, error: '' };
}
