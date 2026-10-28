import { apiRequest, jsonBody, type User } from './api';
export interface RegistrationSettings { enabled: boolean; roleId: string; available: boolean }
export const registrationApi = {
  register: async (username: string, password: string) =>
    (await apiRequest<{ user: User }>('/register', { method: 'POST', body: jsonBody({ username, password }) })).user,
  settings: async (signal?: AbortSignal) =>
    (await apiRequest<{ settings: RegistrationSettings }>('/admin/registration-settings', { signal })).settings,
  save: async (enabled: boolean, roleId: string) =>
    (await apiRequest<{ settings: RegistrationSettings }>('/admin/registration-settings', { method: 'PATCH', body: jsonBody({ enabled, roleId }) })).settings,
};
