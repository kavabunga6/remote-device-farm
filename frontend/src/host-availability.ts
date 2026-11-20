import { t } from './i18n';
import type { Host } from './api';

/** Capacity that can accept a new session now. */
export function availableSlots(host: Pick<Host, 'status' | 'disabled' | 'maxSessions' | 'activeSessions' | 'providers' | 'lastSeenAt'>, now = Date.now()): number {
  if (hostState(host, now) !== 'online' || host.providers?.some(provider => provider.kind === 'emulator' && provider.status === 'unavailable')) return 0;
  return Math.max(0, host.maxSessions - host.activeSessions);
}

type HostLiveness = Pick<Host, 'status' | 'disabled' | 'lastSeenAt'>;
export function hostUnresponsive(host: Pick<Host, 'lastSeenAt'>, now = Date.now()): boolean {
  const timestamp = Date.parse(host.lastSeenAt ?? '');
  return !Number.isFinite(timestamp) || now - timestamp > 15 * 60_000;
}
export function hostState(host: HostLiveness, now = Date.now()): 'online' | 'disabled' | 'offline' {
  if (host.disabled) return 'disabled';
  const timestamp = Date.parse(host.lastSeenAt ?? '');
  return host.status === 'online' && Number.isFinite(timestamp) && now - timestamp <= 45_000 ? 'online' : 'offline';
}

export const HOST_STATE_LABEL = { get online() { return t('ui.dabf46d05e58'); }, get disabled() { return t('ui.a3fbed94428e'); }, get offline() { return t('ui.624ac1030b6e'); } };

/** Occupancy thresholds use the exact ratio, before display rounding. */
export function slotOccupancyLevel(occupied: number, total: number): 'available' | 'busy' | 'full' | 'unavailable' {
  if (total <= 0) return 'unavailable';
  if (occupied >= total) return 'full';
  return occupied / total > 0.7 ? 'busy' : 'available';
}
