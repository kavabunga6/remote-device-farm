import { apiRequest, jsonBody } from './api';



export type TeamRole = 'member' | 'lead';
export interface TeamMember { userId: string; username: string; displayName: string; role: TeamRole }
export interface Team {
  id: string;
  name: string;
  // null: global default, 0: unlimited
  maxSessions: number | null;
  createdAt: string;
  members: TeamMember[];
  profileIds: string[];
}
export interface MyTeam extends Team { myRole: TeamRole }
export interface TeamSession {
  id: string; state: string; label: string | null; profileId: string; profileName: string; hostName: string;
  ownerId: string; ownerName: string; createdAt: string; lastActivityAt: string; ageSeconds: number;
}
export interface MyLimits { maxSessions: number; allowedProfileIds: string[] | null }

const put = <T,>(path: string, body: unknown) => apiRequest<T>(path, { method: 'PUT', body: jsonBody(body) });

export const teamsApi = {
  list: async () => (await apiRequest<{ teams: Team[] }>('/admin/teams')).teams,
  create: async (name: string, maxSessions: number | null) =>
    (await apiRequest<{ team: Team }>('/admin/teams', { method: 'POST', body: jsonBody({ name, maxSessions }) })).team,
  update: async (id: string, fields: { name?: string; maxSessions?: number | null }) =>
    (await apiRequest<{ team: Team }>(`/admin/teams/${id}`, { method: 'PATCH', body: jsonBody(fields) })).team,
  remove: (id: string) => apiRequest<{ ok: true }>(`/admin/teams/${id}`, { method: 'DELETE' }),
  setMembers: async (id: string, members: Array<{ userId: string; role: TeamRole }>) =>
    (await put<{ team: Team }>(`/admin/teams/${id}/members`, { members })).team,
  setProfiles: async (id: string, profileIds: string[]) =>
    (await put<{ team: Team }>(`/admin/teams/${id}/profiles`, { profileIds })).team,
  mine: async () => (await apiRequest<{ teams: MyTeam[] }>('/teams/mine')).teams,
  sessions: async (id: string) => (await apiRequest<{ sessions: TeamSession[] }>(`/teams/${id}/sessions`)).sessions,
  limits: () => apiRequest<MyLimits>('/me/limits'),
};
