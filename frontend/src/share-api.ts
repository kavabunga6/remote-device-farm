import { apiRequest, jsonBody } from './api';

export type ShareMode = 'view' | 'control';

export interface ShareRedeemer {
  grantId: string;
  userId?: string;
  username?: string;
  revokedAt?: string | null;
  name: string;
  mode: ShareMode;
  redeemedAt: string;
  expiresAt: string;
  connected: boolean;
}

export interface SessionShare {
  id: string;
  revokedAt?: string | null;
  mode: ShareMode;
  createdAt: string;
  expiresAt: string;
  maxRecipients: number;
  recipientsUsed: number;
  redeemers: ShareRedeemer[];
}



export interface SharedWithMeEntry {
  sessionId: string;
  ownerName: string;
  profileName: string;
  label: string | null;
  mode: ShareMode;
  expiresAt: string;
}

export const shareApi = {
  mine: () => apiRequest<{ shares: SharedWithMeEntry[] }>('/shares/mine').then(r => r.shares),
  list: (sessionId: string, signal?: AbortSignal) => apiRequest<{ shares: SessionShare[] }>(`/sessions/${sessionId}/shares`, { signal }).then(r => r.shares),
  create: (sessionId: string, mode: ShareMode, ttlMinutes: number, maxRecipients: number) =>
    apiRequest<{ share: { id: string; mode: ShareMode; expiresAt: string; maxRecipients: number; recipientsUsed: number }; token: string }>(
      `/sessions/${sessionId}/shares`, { method: 'POST', body: jsonBody({ mode, ttlMinutes, maxRecipients }) }),
  revoke: (sessionId: string, shareId: string) =>
    apiRequest<{ ok: true }>(`/sessions/${sessionId}/shares/${shareId}`, { method: 'DELETE' }),
  revokeGrant: (sessionId: string, shareId: string, grantId: string) =>
    apiRequest<{ ok: true }>(`/sessions/${sessionId}/shares/${shareId}/grants/${grantId}`, { method: 'DELETE' }),
  redeem: (token: string) =>
    apiRequest<{ sessionId: string; access: 'owner' | ShareMode }>('/shares/redeem', { method: 'POST', body: jsonBody({ token }) }),
};

export type SessionAccess = 'owner' | 'admin' | 'view' | 'control';

// The server adds `access` to GET /sessions/:id; api.ts does not declare it.
export function accessOf(session: object | null): SessionAccess {
  const access = (session as { access?: string } | null)?.access;
  return access === 'view' || access === 'control' || access === 'admin' ? access : 'owner';
}

export function shareLink(token: string): string {
  return `${window.location.origin}${window.location.pathname}#/shared/${token}`;
}
