import { mkdtempSync, writeFileSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { ImageCache } from './image-cache.mjs';
import { AgentControl } from './agent-control.mjs';
import { validateControlRequest } from './control-ipc.mjs';
const id = 'sha256:' + 'a'.repeat(64), digest = 'sha256:' + 'b'.repeat(64);
function fixture() {
  let images = [{ Id: id, Labels: { 'remote-device-farm.contract': 'emulator-v1', 'remote-device-farm.system-image': 'system-images;android-36;default;x86_64' }, RepoTags: ['registry/rdf-emulator:one'], RepoDigests: ['registry/rdf-emulator@' + digest], Size: 1000 }];
  let containers = [], calls = [];
  const docker = {
    request: async (method, path) => {
      if (method === 'DELETE') { calls.push(path); images = []; return []; }
      if (path.startsWith('/images/json')) return images;
      if (path.startsWith('/containers/json')) return containers;
      if (path.endsWith('/json')) return { ...images[0], Id: id };
      throw Error('Unexpected call');
    }
  };
  const cache = new ImageCache(docker, undefined, () => Date.parse('2026-10-08T00:00:00Z'));
  return { cache, docker, calls, images, setContainers: value => containers = value };
}
test('local cache lists only contract images and records first discovery rather than image creation', async () => {
  const f = fixture(); f.images.push({ Id: 'other', Labels: {}, Size: 200 });
  const listed = await f.cache.list(); assert.equal(listed.items.length, 1); assert.equal(listed.items[0].firstSeenAt, '2026-10-08T00:00:00.000Z');
});
test('all containers, digest-pinned profiles and foreign aliases protect local images', async () => {
  const f = fixture(); f.setContainers([{ Id: 'stopped', ImageID: id }]); assert.deepEqual((await f.cache.list()).items[0].blockers, ['container']);
  await assert.rejects(f.cache.remove([id], [])); assert.equal(f.calls.length, 0);
  f.setContainers([]); assert.deepEqual((await f.cache.list(['registry/rdf-emulator:one@' + digest])).items[0].blockers, ['reference']);
  f.images[0].RepoTags.push('other/app:latest'); assert.ok((await f.cache.list()).items[0].blockers.includes('foreignAlias'));
});
test('addressed deletion never uses force or Docker-wide prune', async () => {
  const f = fixture(); assert.deepEqual(await f.cache.remove([id], []), { removed: [id], failed: [] });
  assert.equal(f.calls.length, 3); assert.ok(f.calls.every(path => path.includes('force=false&noprune=true')));
  await assert.rejects(f.cache.remove(['../../all'], []));
});
test('IPC rejects arbitrary deletion payloads and control refuses during preparation/build/pull', async () => {
  assert.throws(() => validateControlRequest({ op: 'imageCacheRemove', ids: ['anything'], protectedRefs: [] }));
  assert.throws(() => validateControlRequest({ op: 'imageCache', protectedRefs: [], force: true }));
  const f = fixture(), control = new AgentControl({ agentId: 'test-agent', slots: 1, allowedPrefixes: [] }, f.docker);
  control.preparing.set('pending', {}); await assert.rejects(control.removeCachedImages([id], []), /image_cache_busy/);
  control.preparing.clear(); control.cachePulls = 1; await assert.rejects(control.removeCachedImages([id], []), /image_cache_busy/);
});


test('usage tracking failure leaves session startup available and refuses destructive cleanup', async () => {
  const f = fixture(); f.cache.file = 'unused'; f.cache.persist = () => { throw Error('disk unavailable'); };
  await f.cache.touch('registry/rdf-emulator:one');
  await assert.rejects(f.cache.list(), /image_cache_tracking_failed/);
  await assert.rejects(f.cache.remove([id], []), /image_cache_tracking_failed/);
  assert.equal(f.calls.length, 0);
});


test('a corrupt usage ledger disables cache maintenance without preventing agent construction', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'rdf-cache-test-'));
  try {
    writeFileSync(join(directory, 'cache-usage.json'), 'invalid json');
    const f = fixture(), cache = new ImageCache(f.docker, directory);
    await assert.rejects(cache.list(), /image_cache_tracking_failed/);
    assert.equal(f.calls.length, 0);
  } finally { unlinkSync(join(directory, 'cache-usage.json')); rmdirSync(directory); }
});


test('a cancelled cleanup stops issuing deletes and releases session admission', async () => {
  const f = fixture(), controller = new AbortController(), control = new AgentControl({ agentId: 'test-agent', slots: 1, allowedPrefixes: [] }, f.docker);
  let started;
  const entered = new Promise(resolve => started = resolve);
  control.cache.remove = async (_ids, _refs, signal) => { started(); await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })); };
  const work = control.removeCachedImages([id], [], controller.signal); await entered; controller.abort(new Error('cancelled'));
  await assert.rejects(work, /cancelled/); assert.equal(control.cacheCleanup, false);
  await control.startQueue;
  await assert.rejects(f.cache.remove([id], [], controller.signal), /cancelled/); assert.equal(f.calls.length, 0);
});


test('a conflict containing hexadecimal 404 is never mistaken for a missing image', async () => {
  const f = fixture(), request = f.docker.request; let attempts = 0;
  f.docker.request = async (method, ...args) => { if (method === 'DELETE') { attempts++; throw Error('conflict: image sha256:abcd404ef is in use'); } return request(method, ...args); };
  assert.deepEqual(await f.cache.remove([id], []), { removed: [], failed: [id] }); assert.equal(attempts, 1);
});
