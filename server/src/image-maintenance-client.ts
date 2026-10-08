import { readFile } from 'node:fs/promises';
import { ApiError } from './http-common.js';
import { uiMessage } from './messages.js';
export interface StoredImage { digest: string; tags: string[]; createdAt: string | null; package: string | null; sizeBytes: number; children: string[] }
export interface RegistryInventory { repositories: string[]; items: StoredImage[]; maintenance: boolean }
export interface MaintenanceJob { id: string; state: string; stage: string; deleted: string[]; errorCode?: string | null }
export interface RegistryMaintenance {
  inventory(): Promise<RegistryInventory>;
  submit(id: string, digests: string[]): Promise<MaintenanceJob>;
  status(id: string): Promise<MaintenanceJob | null>;
}
/** Private service and read-only token volume; no Docker socket or credentials returned to clients. */
export class RegistryMaintenanceClient implements RegistryMaintenance {
  constructor(private readonly url = process.env.RDF_REGISTRY_CONTROL_URL ?? 'http://registry:5001',
    private readonly tokenFile = process.env.RDF_REGISTRY_CONTROL_TOKEN_FILE ?? '/run/registry-maintenance/token') {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) throw new Error('Invalid registry control URL');
  }
  private async call<T>(path: string, body?: unknown): Promise<T> {
    try {
      const token = (await readFile(this.tokenFile, 'utf8')).trim();
      if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('Invalid control token');
      const response = await fetch(new URL(path, this.url), {
        redirect: 'error', signal: AbortSignal.timeout(30000),
        method: body === undefined ? 'GET' : 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
      if (!response.ok) throw new Error('Maintenance unavailable');
      const text = await response.text();
      if (text.length > 8 * 1024 * 1024) throw new Error('Inventory exceeds limit');
      return JSON.parse(text) as T;
    } catch { throw new ApiError(503, 'image_management_unavailable', uiMessage('images.error.unavailable')); }
  }
  inventory() { return this.call<RegistryInventory>('/inventory'); }
  async submit(id: string, digests: string[]) { return (await this.call<{ job: MaintenanceJob }>('/jobs', { id, digests })).job; }
  async status(id: string) { return (await this.call<{ job: MaintenanceJob | null }>('/jobs/' + id)).job; }
}
