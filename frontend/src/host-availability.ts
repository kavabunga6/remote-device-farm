import { t } from './i18n';
import type { Host } from './api';

/** Capacity that can accept a new session now. */
export function availableSlots(host: Pick<Host, 'status' | 'disabled' | 'maxSessions' | 'activeSessions' | 'providers'>): number {
  if (host.status !== 'online' || host.disabled || host.providers?.some(provider => provider.kind === 'emulator' && provider.status === 'unavailable')) return 0;
  return Math.max(0, host.maxSessions - host.activeSessions);
}

export function hostState(host: Pick<Host, 'status' | 'disabled'>): 'online' | 'disabled' | 'offline' {
  return host.disabled ? 'disabled' : host.status;
}

export const HOST_STATE_LABEL = { get online() { return t('ui.dabf46d05e58'); }, get disabled() { return t('ui.a3fbed94428e'); }, get offline() { return t('ui.624ac1030b6e'); } };

/** Occupancy thresholds use the exact ratio, before display rounding. */
export function slotOccupancyLevel(occupied: number, total: number): 'available' | 'busy' | 'full' | 'unavailable' {
  if (total <= 0) return 'unavailable';
  if (occupied >= total) return 'full';
  return occupied / total > 0.7 ? 'busy' : 'available';
}
