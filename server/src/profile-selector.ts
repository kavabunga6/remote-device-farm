import type { Pool } from 'pg';
import { ApiError } from './http-common.js';
import { allowedProfileIds } from './teams.js';

type Actor = { id: string; role: string };

/**
 * What an automation asks for instead of a profile id: "Android 14 TV", "API 33 tablet with Google Play".
 * Every field is optional; the farm picks the best enabled profile the user may launch.
 */
export interface ProfileSelector {
  android?: string;
  api?: number;
  deviceType?: 'mobile' | 'tv' | 'wear' | 'automotive' | 'desktop';
  form?: 'phone' | 'tablet';
  flavor?: 'aosp' | 'google_apis' | 'google_play';
  abi?: string;
}

const KEYS = ['android', 'api', 'deviceType', 'form', 'flavor', 'abi'] as const;
const DEVICE_TYPES = ['mobile', 'tv', 'wear', 'automotive', 'desktop'];
const FLAVORS = ['aosp', 'google_apis', 'google_play'];

const invalid = (message: string) => new ApiError(400, 'invalid_profile_selector', message);

/** Parses a selector from a JSON body (`profile: {...}`) or query parameters; strings from a query are accepted for api. */
export function parseProfileSelector(value: unknown): ProfileSelector {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid('profile must be an object');
  const input = value as Record<string, unknown>;
  const unknown = Object.keys(input).find(key => !(KEYS as readonly string[]).includes(key));
  if (unknown) throw invalid(`profile.${unknown} is not supported; use ${KEYS.join(', ')}`);
  const selector: ProfileSelector = {};
  if (input.android !== undefined) {
    if (typeof input.android !== 'string' && typeof input.android !== 'number') throw invalid('profile.android must be a version like "14"');
    const android = String(input.android).trim();
    if (!/^[0-9]{1,2}(\.[0-9]{1,2})?L?$/.test(android)) throw invalid('profile.android must be a version like "14"');
    selector.android = android;
  }
  if (input.api !== undefined) {
    const api = Number(input.api);
    if (!Number.isInteger(api) || api < 1 || api > 99) throw invalid('profile.api must be an API level like 34');
    selector.api = api;
  }
  if (input.deviceType !== undefined) {
    if (!DEVICE_TYPES.includes(String(input.deviceType))) throw invalid(`profile.deviceType must be one of ${DEVICE_TYPES.join(', ')}`);
    selector.deviceType = input.deviceType as ProfileSelector['deviceType'];
  }
  if (input.form !== undefined) {
    if (input.form !== 'phone' && input.form !== 'tablet') throw invalid('profile.form must be phone or tablet');
    selector.form = input.form;
  }
  if (input.flavor !== undefined) {
    if (!FLAVORS.includes(String(input.flavor))) throw invalid(`profile.flavor must be one of ${FLAVORS.join(', ')}`);
    selector.flavor = input.flavor as ProfileSelector['flavor'];
  }
  if (input.abi !== undefined) {
    if (typeof input.abi !== 'string' || !/^[a-z0-9_-]{2,20}$/.test(input.abi)) throw invalid('profile.abi must be an ABI like x86_64');
    selector.abi = input.abi;
  }
  return selector;
}

/** Phone or tablet, from the screen size of a mobile profile. */
export function profileForm(row: Record<string, unknown>): 'phone' | 'tablet' | null {
  if ((row.device_type ?? 'mobile') !== 'mobile') return null;
  const match = /^(\d+)x(\d+)$/.exec(String(row.resolution ?? ''));
  return match && Math.min(Number(match[1]), Number(match[2])) >= 1200 ? 'tablet' : 'phone';
}

export function matchesSelector(row: Record<string, unknown>, selector: ProfileSelector): boolean {
  if (selector.android !== undefined && String(row.android_version ?? '').trim() !== selector.android) return false;
  if (selector.api !== undefined && Number(row.api_level) !== selector.api) return false;
  if (selector.deviceType !== undefined && String(row.device_type ?? 'mobile') !== selector.deviceType) return false;
  if (selector.form !== undefined && profileForm(row) !== selector.form) return false;
  if (selector.flavor !== undefined && row.image_flavor !== selector.flavor) return false;
  if (selector.abi !== undefined && !String(row.abi ?? '').split(',').map(item => item.trim()).includes(selector.abi)) return false;
  return true;
}

/** Recommended first, then the newest API, then by name: the same order a person sees in the launch dialog. */
export function rankProfiles<T extends Record<string, unknown>>(rows: T[]): T[] {
  return [...rows].sort((a, b) => Number(b.recommended === true) - Number(a.recommended === true)
    || (Number(b.api_level) || 0) - (Number(a.api_level) || 0) || String(a.name).localeCompare(String(b.name), 'ru'));
}

/** The id of the best enabled profile this user may launch; 404 when nothing matches. */
export async function selectProfileId(pool: Pool, user: Actor, selector: ProfileSelector): Promise<string> {
  const { rows } = await pool.query<Record<string, unknown>>(`SELECT * FROM profiles WHERE enabled=true AND removed_at IS NULL AND id NOT LIKE 'device-%'`);
  const allowed = await allowedProfileIds(pool, user);
  const match = rankProfiles(rows.filter(row => (!allowed || allowed.includes(String(row.id))) && matchesSelector(row, selector)))[0];
  if (!match) throw new ApiError(404, 'no_matching_profile', 'No enabled profile matches ' + JSON.stringify(selector));
  return String(match.id);
}
