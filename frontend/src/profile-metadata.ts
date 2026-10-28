import { getLocale, t } from './i18n';
import type { Profile } from './api';

export function memoryLabel(value?: number | null): string {
  return value == null ? t('ui.011e1ca54824') : value < 1024
    ? t('copy.profile-metadata.dd02835c', { p0: value.toLocaleString(getLocale()) })
    : t('copy.profile-metadata.9030bbc4', { p0: (value / 1024).toLocaleString(getLocale()) });
}

/** Read only a single unambiguous integer flag; never infer effective values from duplicates or expressions. */
function launchResource(params: string, option: '-cores' | '-memory'): { configured: boolean; value: number | null } {
  const tokens = params.trim().split(/\s+/);
  const values: Array<string | undefined> = [];
  tokens.forEach((token, index) => {
    if (token === option) values.push(tokens[index + 1]);
    else if (token.startsWith(option + '=')) values.push(token.slice(option.length + 1));
  });
  const value = values.length === 1 && /^[1-9][0-9]*$/.test(values[0] ?? '') ? Number(values[0]) : null;
  return { configured: values.length > 0, value: value !== null && Number.isSafeInteger(value) ? value : null };
}

/** Only use explicit profile fields or an explicitly written legacy API level. */
export function profileEnvironment(profile: Profile) {
  const legacyApi = profile.androidVersion?.match(/\bAPI\s*(\d+)\b/i)?.[1];
  const apiLevel = profile.apiLevel ?? (legacyApi ? Number(legacyApi) : null);
  const androidVersion = profile.androidVersion?.replace(/\s*\(?API\s*\d+(?:\.\d+)*\)?/i, '').trim();
  const guest = (kind: 'cpu' | 'memory') => {
    const value = kind === 'cpu' ? profile.guestCores : profile.guestMemoryMb;
    if (value != null) return kind === 'cpu' ? value.toLocaleString(getLocale()) : memoryLabel(value);
    const parameter = launchResource(profile.emulatorParams ?? '', kind === 'cpu' ? '-cores' : '-memory');
    if (parameter.value !== null) return kind === 'cpu' ? parameter.value.toLocaleString(getLocale()) : memoryLabel(parameter.value);
    return parameter.configured ? t('ui.c5e02f319393') : t('ui.c5ae8cdbe7dd');
  };
  return {
    android: androidVersion ? 'Android ' + androidVersion : t('ui.5036b259f67b'),
    api: apiLevel == null ? t('ui.ca158f9d4f05') : 'API ' + apiLevel,
    abi: profile.abi?.trim() || t('ui.f16cbd327049'),
    model: profile.deviceModel?.trim() || t('ui.e895fb5ecd06'),
    resolution: profile.resolution?.trim().replace(/[xх×]/gi, ' × ') || t('ui.c5ae8cdbe7dd'),
    cores: guest('cpu'), memory: guest('memory'),
  };
}
