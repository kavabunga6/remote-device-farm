import { apiRequest, jsonBody } from './api';
export interface UserProfile {
  id: string;
  username: string;
  displayName: string;
  role: 'admin' | 'user';
  provider: string;
  firstName: string | null;
  lastName: string | null;
  jobTitle: string | null;
  company: string | null;
  managedByProvider: boolean;
}

export interface UserPreferences {
  theme: 'system' | 'light' | 'dark';
  fontFamily: 'system' | 'inter' | 'mono';
  fontScale: number;
  defaultAdbKeyId: string | null;
}

export interface RentalRecord {
  id: string;
  sessionId: string;
  ownerUserId: string;
  ownerUsername: string;
  hostId: string;
  hostName: string;
  profileId: string;
  profileName: string;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  finalState: string | null;
}

export interface AuditRecord {
  id: string;
  occurredAt: string;
  actorUserId: string | null;
  actorUsername: string | null;
  subjectUserId: string | null;
  action: string;
  outcome: string;
  targetType: string | null;
  targetId: string | null;
}

export interface ServiceLogRecord {
  id: string;
  occurredAt: string;
  service: string;
  severity: string;
  code: string;
  hostId: string | null;
  sessionId: string | null;
  message?: string;
}

export interface JournalFilters {
  session?: string;
  owner?: string;
  actor?: string;
  host?: string;
  action?: string;
  severity?: string;
  service?: string;
  from?: string;
  to?: string;
}

async function request<T>(path: string, method = 'GET', data?: object): Promise<T> {
  return apiRequest<T>(path, { method, body: data ? jsonBody(data) : undefined });
}

function pageQuery(before: string | null, limit: number, filters: JournalFilters = {}): string {
  const params = new URLSearchParams({ limit: String(limit) });
  if (before) params.set('before', before);
  for (const [key, value] of Object.entries(filters)) if (value) params.set(key, value);
  return '?' + params.toString();
}

export const settingsApi = {
  profile: async () => (await request<{ profile: UserProfile }>('/me/profile')).profile,
  updateProfile: async (data: Pick<UserProfile, 'firstName' | 'lastName' | 'jobTitle' | 'company'>) =>
    (await request<{ profile: UserProfile }>('/me/profile', 'PATCH', data)).profile,
  preferences: async (expectedUserId?: string) => (await request<{ preferences: UserPreferences }>('/me/preferences' + (expectedUserId ? '?expectedUserId=' + encodeURIComponent(expectedUserId) : ''))).preferences,
  updatePreferences: async (data: Partial<UserPreferences>, expectedUserId: string) =>
    (await request<{ preferences: UserPreferences }>('/me/preferences', 'PATCH', { ...data, expectedUserId })).preferences,
  changePassword: async (currentPassword: string, newPassword: string) =>
    request<{ ok: true }>('/me/password', 'POST', { currentPassword, newPassword }),
  myRentals: async (before: string | null = null, limit = 25) =>
    request<{ rentals: RentalRecord[]; nextCursor: string | null }>('/me/rentals' + pageQuery(before, limit)),
  allRentals: async (before: string | null = null, limit = 25, filters: JournalFilters = {}) =>
    request<{ rentals: RentalRecord[]; nextCursor: string | null }>('/admin/rentals' + pageQuery(before, limit, filters)),
  audit: async (before: string | null = null, limit = 25, filters: JournalFilters = {}) =>
    request<{ events: AuditRecord[]; nextCursor: string | null }>('/admin/audit' + pageQuery(before, limit, filters)),
  sessionDiagnostics: async (after: string | null, filters: JournalFilters) =>
    request<{ events: ServiceLogRecord[]; nextCursor: string | null; hasMore: boolean }>('/admin/session-diagnostics' + pageQuery(null, 500, filters) + (after ? '&after=' + encodeURIComponent(after) : '')),
  logs: async (before: string | null = null, limit = 25, filters: JournalFilters = {}) =>
    request<{ events: ServiceLogRecord[]; nextCursor: string | null }>('/admin/logs' + pageQuery(before, limit, filters)),
};
