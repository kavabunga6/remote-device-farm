import { apiRequest } from './api';

export type ImageFlavor = 'aosp' | 'google_apis' | 'google_play';
export type ImageDevice = 'phone' | 'tv' | 'automotive' | 'wear' | 'desktop';

export interface CatalogImage {
  package: string;
  tag: string;
  api: number;
  minor: number | null;
  androidVersion: string;
  device: ImageDevice;
  flavor: ImageFlavor;
  abi: string;
  description?: string;
  built: boolean;
  digest: string | null;
  builtAt: string | null;
  sizeMb: number | null;
  profiles: Array<{ id: string; name: string; enabled: boolean; current: boolean }>;
  updateAvailable: boolean;
  validated?: boolean;
}

export interface BuildJob {
  id: string;
  package: string;
  image: string;
  state: 'queued' | 'building' | 'validating' | 'pushing' | 'cancelling' | 'cancelled' | 'done' | 'failed';
  progress?: { step: number; steps: number; percent: number | null };
  log?: string[];
  error?: string | null;
  errorCode?: string | null;
  digest?: string | null;
  createdAt?: string;
  finishedAt?: string;
}

export interface ImagePrewarmJob {
  hostId: string;
  image: string;
  state: 'queued' | 'pulling' | 'done' | 'failed';
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RegistrySettings {
  mode: 'builtin' | 'external';
  builtinAddress: string | null;
  externalAddress: string | null;
  externalUsername: string | null;
  externalPasswordSet: boolean;
}

export interface CatalogStatus {
  builder: { id: string; name: string } | null;
  phase: 'idle' | 'checking_tools' | 'preparing_tools' | 'fetching' | 'parsing' | 'ready' | 'failed' | 'unconfigured' | 'offline';
  startedAt: string | null;
  updatedAt: string | null;
  progress: { step: number; steps: number; percent: number | null } | null;
}

export interface ImageCatalog {
  registry: RegistrySettings;
  builder: { id: string; name: string } | null;
  abi?: string;
  refreshedAt?: string;
  images: CatalogImage[];
  jobs: BuildJob[];
}

const json = (body: unknown) => ({ headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

export const imagesApi = {
  prewarmJobs: (signal?: AbortSignal) => apiRequest<{ items: ImagePrewarmJob[] }>('/admin/emulator-images/prewarm', { signal }),
  prewarm: () => apiRequest<{ queued: number; skipped: number }>('/admin/emulator-images/prewarm', { method: 'POST', ...json({}) }),
  catalog: (refresh = false, signal?: AbortSignal) => apiRequest<ImageCatalog>('/admin/emulator-images' + (refresh ? '?refresh=1' : ''), { signal, timeoutMs: 15 * 60_000 + 15_000 }),
  catalogStatus: (signal?: AbortSignal) => apiRequest<CatalogStatus>('/admin/emulator-images/catalog-status', { signal, timeoutMs: 10_000 }),
  build: (packages: string[]) => apiRequest<{ jobs: BuildJob[] }>('/admin/emulator-images/builds', { method: 'POST', ...json({ packages }) }),
  cancelBuild: (jobId: string, builderHostId: string) => apiRequest<{ jobs: BuildJob[] }>(`/admin/emulator-images/builds/${encodeURIComponent(jobId)}/cancel`, { method: 'POST', ...json({ builderHostId }) }),
  apply: (pkg: string) => apiRequest<{ updated: string[] }>('/admin/emulator-images/apply', { method: 'POST', ...json({ package: pkg }) }),
  registry: () => apiRequest<{ registry: RegistrySettings }>('/admin/registry'),
  saveRegistry: (input: Partial<RegistrySettings> & { externalPassword?: string | null }) =>
    apiRequest<{ registry: RegistrySettings }>('/admin/registry', { method: 'PUT', ...json(input) }),
  setBuilder: (hostId: string, enabled: boolean) =>
    apiRequest<{ ok: true }>(`/admin/hosts/${encodeURIComponent(hostId)}/image-builder`, { method: 'PUT', ...json({ enabled }) }),
};
