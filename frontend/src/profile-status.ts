import { t } from './i18n';
import type { Profile } from './api';

export type ProfileStatus = 'ready' | 'disabled';
export const PROFILE_STATUS_LABELS: Record<ProfileStatus, string> = {
  get ready() { return t('ui.d81568b864c8'); },
  get disabled() { return t('ui.a3fbed94428e'); },
};
export const PROFILE_STATUS_HELP: Record<ProfileStatus, string> = {
  get ready() { return t('ui.ed1788b798b3'); },
  get disabled() { return t('ui.5643e5ee9dff'); },
};

export function profileStatus(profile: Pick<Profile, 'enabled'>): ProfileStatus {
  return profile.enabled === false ? 'disabled' : 'ready';
}

export const profileMetadataHelp = () => t('ui.c73b6b46e472');
