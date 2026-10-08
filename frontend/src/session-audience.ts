import { t } from './i18n';
import type { SessionShare } from './share-api';

export type AudienceStatus = 'loading' | 'ready' | 'error' | 'unavailable';
export interface AudienceSnapshot {
  status: AudienceStatus;
  shares: SessionShare[];
  updatedAt: number | null;
  error: string;
}
export interface SessionAudience extends AudienceSnapshot {
  activeLinks: number;
  recipients: number;
  connected: number;
  recipientUnit: 'people' | 'grants';
}
export const AUDIENCE_STALE_MS = 20_000;

// Links and redeemed grants expire independently. Count accounts, not websocket connections.
export function deriveSessionAudience(snapshot: AudienceSnapshot, now: number): SessionAudience {
  let invalidExpiry = false;
  const shares = snapshot.shares.filter(share => {
    const expires = Date.parse(share.expiresAt);
    if (!Number.isFinite(expires)) invalidExpiry = true;
    return !share.revokedAt && expires > now;
  }).map(share => ({ ...share, redeemers: share.redeemers.filter(person => {
    const expires = Date.parse(person.expiresAt);
    if (!Number.isFinite(expires)) invalidExpiry = true;
    return !person.revokedAt && expires > now;
  }) }));
  const people = shares.flatMap(share => share.redeemers);
  const identityKnown = people.every(person => !!person.userId);
  const accounts = new Set<string>();
  const connected = new Set<string>();
  for (const person of people) {
    const account = identityKnown ? 'user:' + person.userId : 'grant:' + person.grantId;
    accounts.add(account);
    if (person.connected) connected.add(account);
  }
  const stale = snapshot.updatedAt != null && now - snapshot.updatedAt > AUDIENCE_STALE_MS;
  const status = snapshot.status === 'ready' && (stale || invalidExpiry) ? 'error' : snapshot.status;
  return { ...snapshot, status, shares, activeLinks: shares.length, recipients: accounts.size, connected: connected.size, recipientUnit: identityKnown ? 'people' : 'grants',
    error: status === 'error' ? snapshot.error || (invalidExpiry ? t('ui.a40d0bba628c') : t('ui.38682593d0dc')) : snapshot.error };
}

export function audienceDescription(audience: SessionAudience): string {
  if (audience.status === 'loading') return t('ui.f67b686cf606');
  if (audience.status === 'unavailable') return t('ui.70c0ad73d60e');
  if (audience.status === 'error') return t('ui.fee2d444aa71');
  if (audience.activeLinks === 0) return t('ui.9a8443c5af2c');
  return t('ui.5af9a33f6dc6') + audience.activeLinks + (audience.recipientUnit === 'people' ? t('ui.30c6e52611e3') : t('ui.414c957a78ff')) + audience.recipients + t('ui.eb6cdb56fc3a') + audience.connected + '.' + (audience.recipientUnit === 'grants' ? t('ui.00cc1ff461bb') : '');
}
