import { createHash } from 'node:crypto';
import type { StoredImage } from './image-maintenance-client.js';
export const validDigest = (value: unknown): value is string => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
export interface ImageUse { kind: string; id: string; name: string; image: string }
export interface ManagedImage extends StoredImage { uses: ImageUse[]; blockers: string[]; known: boolean }
export interface CleanupPolicy { registryEnabled: boolean; registryKeep: number; registryDays: number; cacheEnabled: boolean; cacheDays: number; cacheMaxGb: number; intervalHours: number }
export const defaultPolicy: CleanupPolicy = { registryEnabled: false, registryKeep: 3, registryDays: 30, cacheEnabled: false, cacheDays: 30, cacheMaxGb: 0, intervalHours: 24 };
export function imageMatches(image: string, repository: string, item: Pick<StoredImage, 'digest' | 'tags'>): boolean {
  const sameRepository = image.startsWith(repository + ':') || image.startsWith(repository + '@');
  // Generated references may keep a previous hostname or a mirror address.
  if (image.includes('@')) return (sameRepository || /(^|\/)rdf-emulator(?=[:@])/.test(image)) && image.slice(image.lastIndexOf('@') + 1) === item.digest;
  if (!sameRepository) return false;
  return item.tags.some(tag => image === repository + ':' + tag);
}
export function planToken(scope: string, items: unknown): string { return createHash('sha256').update(scope + JSON.stringify(items)).digest('hex'); }
export function registryCandidates(items: ManagedImage[], policy: CleanupPolicy, now = Date.now()): ManagedImage[] {
  const groups = new Map<string, ManagedImage[]>();
  for (const item of items) { const key = item.package ?? item.digest; groups.set(key, [...(groups.get(key) ?? []), item]); }
  const keep = new Set<string>();
  for (const group of groups.values()) for (const item of group.sort((a, b) => Date.parse(b.createdAt ?? '') - Date.parse(a.createdAt ?? '')).slice(0, policy.registryKeep)) keep.add(item.digest);
  const candidates = items.filter(item => item.known && !item.uses.length && !item.blockers.length && !keep.has(item.digest)
    && item.createdAt && Date.parse(item.createdAt) < now - policy.registryDays * 86400000);
  // Removing a child while its parent survives is never safe.
  const selected = new Set(candidates.map(item => item.digest));
  let changed = true;
  while (changed) { changed = false; for (const item of items) if (!selected.has(item.digest)) for (const child of item.children) if (selected.delete(child)) changed = true; }
  return candidates.filter(item => selected.has(item.digest));
}
