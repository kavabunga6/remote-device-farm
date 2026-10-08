import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
const ID = /^sha256:[a-f0-9]{64}$/;
const owned = image => image.Labels?.['remote-device-farm.contract'] === 'emulator-v1';
export class ImageCache {
  constructor(docker, directory, now = () => Date.now()) {
    this.docker = docker; this.now = now; this.file = directory ? join(directory, 'cache-usage.json') : null;
    if (directory) mkdirSync(directory, { recursive: true, mode: 0o700 });
    try { this.usage = this.file ? JSON.parse(readFileSync(this.file, 'utf8')) : {}; }
    catch (error) {
      this.usage = {};
      if (error.code !== 'ENOENT') { this.usageError = true; console.error('Image cache usage ledger is unreadable; cleanup is disabled until repaired'); }
    }
    if (!this.usage || typeof this.usage !== 'object' || Array.isArray(this.usage) || Object.entries(this.usage).some(([id, value]) => !ID.test(id) || !value || !Number.isFinite(Date.parse(value.firstSeenAt)) || (value.lastUsedAt !== null && !Number.isFinite(Date.parse(value.lastUsedAt))))) {
      this.usage = {}; this.usageError = true; console.error('Image cache usage ledger is invalid; cleanup is disabled until repaired');
    }
  }
  persist() { if (!this.file) return; writeFileSync(this.file + '.tmp', JSON.stringify(this.usage), { mode: 0o600 }); renameSync(this.file + '.tmp', this.file); }
  async touch(reference) {
    if (!this.file) return;
    try {
      const image = await this.docker.request('GET', '/images/' + encodeURIComponent(reference) + '/json', undefined, { timeoutMs: 5000 });
      if (ID.test(image?.Id)) { this.usage[image.Id] = { firstSeenAt: this.usage[image.Id]?.firstSeenAt ?? new Date(this.now()).toISOString(), lastUsedAt: new Date(this.now()).toISOString() }; this.persist(); }
    } catch { this.usageError = true; console.error('Image cache usage tracking failed; cleanup is disabled until restart'); }
  }
  async list(protectedRefs = [], signal) {
    signal?.throwIfAborted();
    if (this.usageError) throw new Error('image_cache_tracking_failed');
    const images = await this.docker.request('GET', '/images/json?all=false', undefined, { signal, timeoutMs: 10000 });
    const containers = await this.docker.request('GET', '/containers/json?all=true', undefined, { signal, timeoutMs: 10000 });
    const items = [];
    for (const image of images.filter(owned)) {
      if (!ID.test(image.Id)) throw new Error('Invalid Docker image ID');
      const tags = (image.RepoTags ?? []).filter(ref => ref !== '<none>:<none>');
      const digests = (image.RepoDigests ?? []).filter(ref => typeof ref === 'string');
      const used = containers.filter(container => container.ImageID === image.Id).map(container => container.Id);
      // Unknown first-use dates start now, never from Docker's image creation date.
      this.usage[image.Id] ??= { firstSeenAt: new Date(this.now()).toISOString(), lastUsedAt: null };
      if (used.length) this.usage[image.Id].lastUsedAt = new Date(this.now()).toISOString();
      const pinned = protectedRefs.some(ref => ref === image.Id || tags.includes(ref) || digests.includes(ref)
        || (ref.includes('@') && digests.some(value => value.split('@')[1] === ref.split('@')[1])));
      const foreign = [...tags, ...digests].some(ref => !/(^|\/)rdf-emulator(?=[:@])/.test(ref));
      const blockers = [...(used.length ? ['container'] : []), ...(pinned ? ['reference'] : []), ...(foreign ? ['foreignAlias'] : [])];
      items.push({
        id: image.Id, tags, digests, sizeBytes: image.Size, package: image.Labels['remote-device-farm.system-image'] ?? null,
        ...this.usage[image.Id], containers: used, blockers
      });
    }
    const present = new Set(items.map(item => item.id));
    for (const id of Object.keys(this.usage)) if (!present.has(id)) delete this.usage[id];
    this.persist();
    return { items };
  }
  async remove(ids, protectedRefs, signal) {
    signal?.throwIfAborted();
    if (!Array.isArray(ids) || !ids.length || ids.length > 100 || ids.some(id => !ID.test(id)) || new Set(ids).size !== ids.length) throw new Error('Invalid image deletion list');
    const before = await this.list(protectedRefs, signal);
    if (ids.some(id => !before.items.some(item => item.id === id && !item.blockers.length))) throw new Error('Image cache changed or image is protected');
    const removed = [], failed = [];
    for (const [index, id] of ids.entries()) {
      if (signal?.aborted) { failed.push(...ids.slice(index)); break; }
      // Recheck every image immediately before deletion. Docker is the final guard
      // against containers created by another local administrator.
      try {
        const fresh = (await this.list(protectedRefs, signal)).items.find(item => item.id === id);
        if (!fresh || fresh.blockers.length) { failed.push(id); continue; }
        for (const ref of [...fresh.tags, ...fresh.digests]) {
          await this.docker.request('DELETE', '/images/' + encodeURIComponent(ref) + '?force=false&noprune=true', undefined, { signal, timeoutMs: 10000 }).catch(error => {
            if (!/^No such image(?::|$)|^Docker API HTTP 404$/i.test(error.message)) throw error;
          });
        }
        await this.docker.request('DELETE', '/images/' + encodeURIComponent(id) + '?force=false&noprune=true', undefined, { signal, timeoutMs: 10000 }).catch(error => {
          if (!/^No such image(?::|$)|^Docker API HTTP 404$/i.test(error.message)) throw error;
        });
        removed.push(id); delete this.usage[id]; this.persist();
      } catch { failed.push(id); }
    }
    return { removed, failed };
  }
}
