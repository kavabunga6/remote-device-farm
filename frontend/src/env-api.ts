import { t } from './i18n';
import { apiRequest, jsonBody } from './api';

export interface EnvState {
  proxy: { enabled: boolean; host: string; port: number } | null;
  darkMode: 'yes' | 'no' | 'auto' | null;
  fontScale: number | null;
  animations: boolean | null;
  showTouches: boolean | null;
  pointerLocation: boolean | null;
  timezone: string | null;
  size: { physical: string; override: string | null } | null;
  density: { physical: number; override: number | null } | null;
  battery: { level: number; charging: 'ac' | 'usb' | 'none' } | null;
}

export type EnvOp = 'proxy' | 'network' | 'geo' | 'dark_mode' | 'font_scale' | 'display_size' | 'display_density' | 'animations'
  | 'show_touches' | 'pointer_location' | 'battery' | 'timezone' | 'deeplink' | 'app_clear' | 'app_stop' | 'app_grant'
  | 'app_revoke';

export const loadEnv = (sessionId: string): Promise<EnvState> =>
  apiRequest<{ env: EnvState }>(`/sessions/${sessionId}/env`).then(r => r.env);

export const applyEnv = (sessionId: string, op: EnvOp, params: Record<string, string | number | boolean> = {}): Promise<unknown> =>
  apiRequest(`/sessions/${sessionId}/env`, { method: 'POST', body: jsonBody({ op, params }) });

export const PROXY_HOST_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/i;

export const NETWORK_PRESETS: { id: string; label: string }[] = [
  { id: 'full', get label() { return t('ui.2bf45ab33f8d'); } },
  { id: 'lte', get label() { return t('ui.6e66e06c27e7'); } },
  { id: '3g', get label() { return t('ui.0827bb6d51ef'); } },
  { id: '3g-slow', get label() { return t('ui.d85e02c9c0f5'); } },
  { id: 'edge', get label() { return t('ui.b5833faa1c49'); } },
  { id: '2g', get label() { return t('ui.2dc5ad9961bc'); } },
  { id: 'gsm', get label() { return t('ui.569a327df59b'); } },
];

export const CITIES: { id: string; label: string; lat: number; lon: number }[] = [
  { id: 'moscow', get label() { return t('ui.eb63f79a2297'); }, lat: 55.7558, lon: 37.6173 },
  { id: 'spb', get label() { return t('ui.771f6590f5d9'); }, lat: 59.9343, lon: 30.3351 },
  { id: 'london', get label() { return t('ui.8617e81cf041'); }, lat: 51.5074, lon: -0.1278 },
  { id: 'nyc', get label() { return t('ui.80d2b0699e80'); }, lat: 40.7128, lon: -74.006 },
  { id: 'tokyo', get label() { return t('ui.9f87fe6362b0'); }, lat: 35.6762, lon: 139.6503 },
];

// Must match the agent allowlist; the agent rejects anything else.
export function getTimeZones(): { id: string; label: string }[] {
  return [
  ['UTC', 'UTC'], ['Europe/London', t('ui.8617e81cf041')], ['Europe/Paris', t('ui.6d9f1bd3ca8e')], ['Europe/Berlin', t('ui.51bd674f56f5')], ['Europe/Kaliningrad', t('ui.a9ccb9cc4b48')],
  ['Europe/Moscow', t('ui.eb63f79a2297')], ['Europe/Samara', t('ui.457cffb1b42d')], ['Asia/Yekaterinburg', t('ui.b211c994986c')], ['Asia/Novosibirsk', t('ui.99e016730e15')],
  ['Asia/Vladivostok', t('ui.0d7d19884754')], ['Asia/Dubai', t('ui.c74de158daac')], ['Asia/Kolkata', t('ui.788c617bfab0')], ['Asia/Shanghai', t('ui.d48d73a79005')], ['Asia/Tokyo', t('ui.9f87fe6362b0')],
  ['Australia/Sydney', t('ui.1d38ff074b95')], ['America/Los_Angeles', t('ui.cce765b3b05a')], ['America/Chicago', t('ui.6d6b1e7fd183')], ['America/New_York', t('ui.80d2b0699e80')],
  ['America/Sao_Paulo', t('ui.23f31c0033ac')],
].map(([id, label]) => ({ id: id!, get label() { return t('ui.ff46a851b217', { p0: label, p1: id }); } }));
}


export const PACKAGE_RE = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/;
