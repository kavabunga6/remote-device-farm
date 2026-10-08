import { apiRequest, jsonBody } from './api';
import type { AccessRole } from './permissions';
export const roleApi = {
 list: (signal?: AbortSignal) => apiRequest<{ roles: AccessRole[] }>('/admin/roles', { signal }),
 create: (input: { name: string; permissions: string[] }) => apiRequest('/admin/roles', { method: 'POST', body: jsonBody(input) }),
 update: (id: string, input: { name: string; permissions: string[] }) => apiRequest('/admin/roles/' + encodeURIComponent(id), { method: 'PATCH', body: jsonBody(input) }),
 remove: (id: string) => apiRequest('/admin/roles/' + encodeURIComponent(id), { method: 'DELETE' }),
 assign: (userId: string, roleId: string) => apiRequest('/admin/users/' + encodeURIComponent(userId) + '/role', { method: 'PUT', body: jsonBody({ roleId }) }),
};
