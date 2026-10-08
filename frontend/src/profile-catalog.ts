import { getLocale, t } from './i18n';
import type { Profile } from './api';

export type CatalogProfile = Profile & { imageFlavor?: string | null; imageTag?: string | null; deviceType?: string | null };
export const PROFILE_FACETS = ['deviceType', 'imageFlavor', 'androidVersion', 'abi'] as const;
export type ProfileFacet = typeof PROFILE_FACETS[number];
export const UNKNOWN_FACET = '__unknown__';
const IMAGE_LABELS: Record<string, string> = { aosp: 'AOSP', google_apis: 'Google APIs', google_play: 'Google Play', get custom() { return t('ui.5a20ef2a6f3b'); }, 'android-tv': 'Android TV', 'google-tv': 'Google TV', get 'google-tv-ps16k'() { return t('ui.c59f72180d22'); }, 'android-wear': 'Wear OS', 'android-wear-signed': 'Wear OS · Google Play', get 'android-wear-cn'() { return t('ui.fe2f13a3ca36'); }, 'android-automotive': 'Android Automotive', 'android-automotive-playstore': 'Automotive · Google Play', get 'android-automotive-distant-display'() { return t('ui.9e4579a6040d'); }, get 'android-automotive-distant-display-playstore'() { return t('ui.fef041c853a2'); }, 'android-desktop': 'Android Desktop', 'google-xr': 'Google XR', aosp_atd: 'AOSP · Automated Test Device', google_atd: 'Google · Automated Test Device', default: 'AOSP' };
const DEVICE_LABELS: Record<string, string> = { get mobile() { return t('ui.497d356b21d3'); }, tv: 'Android TV', wear: 'Wear OS', automotive: 'Android Automotive', desktop: 'Android Desktop' };
export function imageTypeLabel(profile: CatalogProfile): string { const type = profile.imageFlavor || profile.imageTag; return type ? IMAGE_LABELS[type] || type : t('ui.317e88f0e372'); }
export function profileAndroidVersion(profile: CatalogProfile): string {
  return profile.androidVersion?.replace(/\s*\(?API\s*\d+(?:\.\d+)*\)?/i, '').replace(/^Android\s*/i, '').trim() || '';
}
export function profileFacetValue(profile: CatalogProfile | undefined, facet: ProfileFacet): string {
  if (!profile) return UNKNOWN_FACET;
  return (facet === 'androidVersion' ? profileAndroidVersion(profile) : facet === 'imageFlavor' ? (profile.imageFlavor || profile.imageTag)?.trim() : profile[facet]?.trim()) || UNKNOWN_FACET;
}
export function profileFacetLabel(facet: ProfileFacet, value: string): string {
  if (value === UNKNOWN_FACET) return facet === 'deviceType' ? t('ui.c86560e27740') : t('ui.0d836c1579f1');
  if (facet === 'deviceType') return DEVICE_LABELS[value] || value;
  if (facet === 'imageFlavor') return IMAGE_LABELS[value] || value;
  return facet === 'androidVersion' ? 'Android ' + value : value;
}
function matchesPrefix(profile: CatalogProfile, current: CatalogProfile | undefined, before: number): boolean {
  return !current || PROFILE_FACETS.slice(0, before).every(facet => profileFacetValue(profile, facet) === profileFacetValue(current, facet));
}
export function profileFacetOptions(profiles: CatalogProfile[], current: CatalogProfile | undefined, facet: ProfileFacet) {
  const before = PROFILE_FACETS.indexOf(facet);
  return [...new Set(profiles.filter(profile => matchesPrefix(profile, current, before)).map(profile => profileFacetValue(profile, facet)))]
    .sort((a, b) => a === UNKNOWN_FACET ? 1 : b === UNKNOWN_FACET ? -1 : facet === 'androidVersion' ? b.localeCompare(a, getLocale(), { numeric: true }) : profileFacetLabel(facet, a).localeCompare(profileFacetLabel(facet, b), getLocale()))
    .map(value => ({ value, label: profileFacetLabel(facet, value) }));
}
const stableProfiles = (profiles: CatalogProfile[]) => [...profiles].sort((a, b) => a.name.localeCompare(b.name, getLocale(), { numeric: true }) || a.id.localeCompare(b.id));
export function profileVariants(profiles: CatalogProfile[], current: CatalogProfile | undefined): CatalogProfile[] {
  return stableProfiles(profiles.filter(profile => matchesPrefix(profile, current, PROFILE_FACETS.length)));
}
/** Explicit input selects a deterministic compatible profile; refresh never calls this function. */
export function chooseProfileFacet(profiles: CatalogProfile[], current: CatalogProfile | undefined, facet: ProfileFacet, value: string, compatible: (profile: CatalogProfile) => boolean = () => true): CatalogProfile | undefined {
  const before = PROFILE_FACETS.indexOf(facet);
  const candidates = stableProfiles(profiles.filter(profile => matchesPrefix(profile, current, before) && profileFacetValue(profile, facet) === value));
  if (current && candidates.some(profile => profile.id === current.id)) return candidates.find(profile => profile.id === current.id);
  const ready = candidates.filter(compatible);
  const pool = ready.length ? ready : candidates;
  return pool.find(profile => PROFILE_FACETS.slice(before + 1).every(next => profileFacetValue(profile, next) === profileFacetValue(current, next))) || pool[0];
}
/** Keep the user's choice through filtering, metadata refresh and capacity changes. */
export function preserveProfileSelection(current: string, profiles: CatalogProfile[]): string {
  return current || profiles.find(profile => profile.enabled !== false)?.id || profiles[0]?.id || '';
}
/** Both launch modes use the same image and resource limits. */
export function effectiveProfileMemory(profile: CatalogProfile, _mode: 'software' | 'nvidia'): number | undefined {
  return profile.memoryMb;
}
