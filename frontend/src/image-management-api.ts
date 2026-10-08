import { apiRequest } from './api';
export interface ImageUse { kind: string; id: string; name: string; image: string }
export interface ManagedImage { digest?: string; id?: string; tags: string[]; digests?: string[]; package: string | null; sizeBytes: number; createdAt?: string | null; firstSeenAt?: string; lastUsedAt?: string | null; uses: ImageUse[]; blockers: string[]; known?: boolean }
export interface CleanupPolicy { registryEnabled: boolean; registryKeep: number; registryDays: number; cacheEnabled: boolean; cacheDays: number; cacheMaxGb: number; intervalHours: number }
export interface CleanupPlan { scope: 'registry' | 'cache'; action: 'delete' | 'retention' | 'gc'; hostId?: string; digests?: string[]; ids?: string[]; removeProfiles?: boolean; token: string; items: ManagedImage[]; blocked: boolean }
export interface CleanupJob { id: string; scope: 'registry' | 'cache'; hostId: string | null; state: string; stage: string; automatic: boolean; errorCode: string | null; result: { removed?: string[]; deleted?: string[]; failed?: string[] } | null; createdAt: string }
const base = '/admin/image-management';
const requestBody = (input: Record<string, unknown>) => JSON.stringify(Object.fromEntries(Object.entries(input).filter(([key]) => ['scope', 'action', 'hostId', 'ids', 'digests', 'removeProfiles', 'token'].includes(key))));
export const imageManagementApi = {
  registry: (signal?: AbortSignal) => apiRequest<{ supported: boolean; repository: string | null; items: ManagedImage[]; maintenance: boolean }>(base + '/registry', { signal }),
  cache: (hostId: string, signal?: AbortSignal) => apiRequest<{ hostId: string; items: ManagedImage[] }>(base + '/cache/' + encodeURIComponent(hostId), { signal }),
  policy: (signal?: AbortSignal) => apiRequest<{ policy: CleanupPolicy }>(base + '/policy', { signal }),
  jobs: (signal?: AbortSignal) => apiRequest<{ items: CleanupJob[] }>(base + '/jobs', { signal }),
  save: (policy: CleanupPolicy) => apiRequest<{ policy: CleanupPolicy }>(base + '/policy', { method: 'PUT', body: JSON.stringify(policy) }),
  preview: (input: Record<string, unknown>) => apiRequest<{ plan: CleanupPlan }>(base + '/preview', { method: 'POST', body: requestBody(input) }),
  enqueue: (plan: CleanupPlan) => apiRequest<{ id: string }>(base + '/jobs', { method: 'POST', body: requestBody(plan as unknown as Record<string, unknown>) }),
};
