import test from 'node:test';
import assert from 'node:assert/strict';
import { BoundedImageBuilder, BUILDKIT_ENTRYPOINT } from './bounded-image-builder.mjs';
const labels = { 'remote-device-farm.managed': 'true', 'remote-device-farm.agent': 'node-1', 'remote-device-farm.role': 'image-builder', 'remote-device-farm.image-build': 'identity' };
const stream = text => { const data = Buffer.from(text), header = Buffer.alloc(8); header[0] = 1; header.writeUInt32BE(data.length, 4); return Buffer.concat([header, data]); };
function fixture({ failImport = false, abortAt = false } = {}) {
  const calls = []; let live = true, networkLive = true, imported = false;
  const docker = { ensureImage: async () => {}, importImageArchive: async () => { imported = true; if (failImport) throw new Error('import failed'); }, requestRaw: async () => stream('ready'), request: async (method, path, body) => {
    calls.push({ method, path, body });
    if (path === '/volumes/rdf-buildkit-node-1') return { Driver: 'local', Labels: { ...labels, 'remote-device-farm.role': 'image-build-cache' } };
    if (path === '/networks/create') { Object.assign(labels, body.Labels); return { Id: 'network-id' }; }
    if (path === '/networks/network-id') { if (method === 'DELETE') { networkLive = false; return {}; } if (!networkLive) throw new Error('No such network'); return { Id: 'network-id', Driver: 'bridge', Labels: labels, Containers: {} }; }
    if (path.startsWith('/containers/create')) { Object.assign(labels, body.Labels); return { Id: 'worker-id' }; }
    if (path.endsWith('/exec')) return { Id: 'exec-id' };
    if (path === '/exec/exec-id/json') return { Running: false, ExitCode: 0 };
    if (path === '/containers/worker-id/json') { if (!live) throw new Error('No such container'); return { Id: 'worker-id', Config: { Labels: labels } }; }
    if (method === 'DELETE') { live = false; return {}; }
    return {};
  } };
  const builder = new BoundedImageBuilder({ docker, agentId: 'node-1', stateDir: '/', guard: () => ({ run: async work => { const control = new AbortController(); if (abortAt) control.abort(new Error('guard stopped')); return work(control.signal); } }) });
  return { builder, calls, get imported() { return imported; } };
}
test('complete builds use one quota-limited worker, no host namespaces/socket/binds, and stop before streaming import', async () => {
  const f = fixture(); await f.builder.build('example/image:test', { SYSTEM_IMAGE: 'system-images;android-30;google_apis;x86_64' }, { contextTar: Buffer.alloc(1024) });
  const config = f.calls.find(call => call.path.startsWith('/containers/create')).body.HostConfig;
  assert.equal(config.Memory, 6 * 1024 ** 3); assert.equal(config.MemorySwap, config.Memory); assert.equal(config.NanoCpus, 4e9);
  assert.equal(config.Privileged, undefined); assert.equal(config.Binds, undefined); assert.equal(config.PidMode, undefined); assert.equal(config.PortBindings, undefined);
  assert.equal(config.NetworkMode, 'network-id'); assert.equal(config.CgroupnsMode, 'private');
  assert.deepEqual(config.CapAdd, ['SYS_ADMIN', 'NET_ADMIN']);
  assert.deepEqual(config.SecurityOpt, ['seccomp=unconfined', 'apparmor=unconfined']);
  assert.equal(config.CapDrop, undefined); assert.equal(config.MaskedPaths, undefined); assert.equal(config.ReadonlyPaths, undefined); assert.ok(f.imported);
  assert.ok(f.calls.some(call => call.path.endsWith('/stop?t=10'))); assert.ok(f.calls.some(call => call.path === '/networks/network-id' && call.method === 'DELETE')); assert.equal(f.builder.active, null);
});
test('failed imports release only the owned worker and cannot report a successful build', async () => {
  const f = fixture({ failImport: true }); await assert.rejects(f.builder.build('example/image:test', {}, { contextTar: Buffer.alloc(1024) }), /import failed/);
  assert.ok(f.calls.some(call => call.method === 'DELETE')); assert.equal(f.builder.active, null);
});
test('foreign caches and worker containers are preserved and rejected', async () => {
  const docker = { request: async () => ({ Driver: 'local', Labels: {} }) }, builder = new BoundedImageBuilder({ docker, agentId: 'node-1', stateDir: '/' });
  await assert.rejects(builder.cacheVolume(), { code: 'build_cache_ownership' });
  await assert.rejects(builder.cleanup('foreign', 'identity'), { code: 'build_cleanup_failed' });
  await assert.rejects(builder.cleanupNetwork('foreign', 'identity'), { code: 'build_cleanup_failed' });
});

test('the worker refuses unlimited ancestors and moves into a private child before remounting cgroupfs', () => {
  assert.ok(BUILDKIT_ENTRYPOINT.includes('cgroup.controllers'));
  assert.ok(BUILDKIT_ENTRYPOINT.includes("'max '*) exit 64"));
  assert.ok(BUILDKIT_ENTRYPOINT.includes('memory.swap.max)" = 0'));
  assert.ok(BUILDKIT_ENTRYPOINT.indexOf('cgroup.procs') < BUILDKIT_ENTRYPOINT.indexOf('unshare --cgroup --mount'));
  assert.ok(BUILDKIT_ENTRYPOINT.includes("printf '%s\\n'"));
});

test('a network containing any other container is preserved and blocks cleanup', async () => {
  const calls = [];
  const builder = new BoundedImageBuilder({ docker: { request: async (method) => { calls.push(method); return { Id: 'network-id', Driver: 'bridge', Labels: labels, Containers: { other: {} } }; } }, agentId: 'node-1', stateDir: '/' });
  await assert.rejects(builder.cleanupNetwork('network-id', labels['remote-device-farm.image-build']), { code: 'build_cleanup_failed' });
  assert.deepEqual(calls, ['GET']);
});
