import test from 'node:test';
import assert from 'node:assert/strict';
import { BoundedImageBuilder, BUILDKIT_ENTRYPOINT, buildLogLines } from './bounded-image-builder.mjs';
const labels = { 'remote-device-farm.managed': 'true', 'remote-device-farm.agent': 'node-1', 'remote-device-farm.role': 'image-builder', 'remote-device-farm.image-build': 'identity' };
const stream = text => { const data = Buffer.from(text), header = Buffer.alloc(8); header[0] = 1; header.writeUInt32BE(data.length, 4); return Buffer.concat([header, data]); };
function fixture({ failImport = false, abortAt = false, failBuild = false, buildLog = 'ready' } = {}) {
  const calls = []; let live = true, networkLive = true, imported = false;
  const docker = { ensureImage: async (_image, onProgress) => { onProgress({ stage: 'checking_image' }); onProgress({ stage: 'downloading', detail: 'Downloading', percent: 42 }); }, importImageArchive: async () => { imported = true; if (failImport) throw new Error('import failed'); }, requestRaw: async () => stream(buildLog), request: async (method, path, body, options) => {
    calls.push({ method, path, body, options });
    if (path === '/volumes/rdf-buildkit-node-1') return { Driver: 'local', Labels: { ...labels, 'remote-device-farm.role': 'image-build-cache' } };
    if (path === '/networks/create') { Object.assign(labels, body.Labels); return { Id: 'network-id' }; }
    if (path === '/networks/network-id') { if (method === 'DELETE') { networkLive = false; return {}; } if (!networkLive) throw new Error('No such network'); return { Id: 'network-id', Driver: 'bridge', Labels: labels, Containers: {} }; }
    if (path.startsWith('/containers/create')) { Object.assign(labels, body.Labels); return { Id: 'worker-id' }; }
    if (path.endsWith('/exec')) return { Id: body.Cmd?.[0] === 'sh' ? 'build-exec' : 'exec-id' };
    if (path === '/exec/build-exec/json') return { Running: false, ExitCode: failBuild ? 17 : 0 };
    if (path === '/exec/exec-id/json') return { Running: false, ExitCode: 0 };
    if (path === '/containers/worker-id/json') { if (!live) throw new Error('No such container'); return { Id: 'worker-id', Config: { Labels: labels } }; }
    if (method === 'DELETE') { live = false; return {}; }
    return {};
  } };
  const builder = new BoundedImageBuilder({ docker, agentId: 'node-1', stateDir: '/', readTrust: async proxy => proxy?.url.startsWith('https:') ? Buffer.from('test public CA bundle') : null, guard: () => ({ run: async work => { const control = new AbortController(); if (abortAt) control.abort(new Error('guard stopped')); return work(control.signal); } }) });
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


test('build log tails emit only new lines, including rotation and partial output', () => {
  assert.deepEqual(buildLogLines('', '#1 RUN\n#2 DONE\n'), ['#1 RUN', '#2 DONE']);
  assert.deepEqual(buildLogLines('#1 RUN\n', '#1 RUN\n'), []);
  assert.deepEqual(buildLogLines('#1 RUN\n', '#1 RUN\n#2 DONE\n'), ['#2 DONE']);
  assert.deepEqual(buildLogLines('#1 RUN\n#2 DONE\n', '#2 DONE\n#3 export\n'), ['#3 export']);
  assert.deepEqual(buildLogLines('#1 down', '#1 downloading 42%\n'), ['#1 downloading 42%']);
});

test('worker process death reports failure and still removes its owned container and network', async () => {
  const f = fixture({ failBuild: true }), stages = []; let checks = 0;
  await assert.rejects(f.builder.build('example/image:test', {}, { contextTar: Buffer.alloc(1024), onStage: stage => stages.push(stage), onHeartbeat: () => checks++ }), { code: 'build_failed' });
  assert.deepEqual(stages, ['preparing', 'starting', 'building']); assert.equal(checks, 1);
  assert.equal(f.imported, false); assert.equal(f.builder.active, null);
  assert.ok(f.calls.some(call => call.path === '/networks/network-id' && call.method === 'DELETE'));
});

test('long build failures preserve the terminal error while redacting proxy credentials', async () => {
  const password = 'private-proxy-credential';
  const buildLog = 'Downloading image layer\n'.repeat(600) + `ERROR_FINAL: upstream rejected ${password}\n`;
  const f = fixture({ failBuild: true, buildLog });
  await assert.rejects(f.builder.build('example/image:test', {}, {
    contextTar: Buffer.alloc(1024), proxy: { url: 'http://proxy.example:3128', username: 'builder', password },
  }), error => {
    assert.equal(error.code, 'build_failed');
    assert.match(error.message, /ERROR_FINAL: upstream rejected \[redacted\]/);
    assert.ok(error.message.length <= 2000);
    assert.ok(!error.message.includes(password));
    return true;
  });
  assert.equal(f.imported, false);
  assert.ok(f.calls.some(call => call.path === '/networks/network-id' && call.method === 'DELETE'));
});


test('worker image download events become readable log lines rather than object strings', async () => {
  const f = fixture(), lines = [];
  await f.builder.build('example/image:test', {}, { contextTar: Buffer.alloc(1024), onLine: line => lines.push(line) });
  assert.ok(lines.includes('42% Downloading')); assert.ok(lines.every(line => typeof line === 'string' && !line.includes('[object Object]')));
});


test('proxy credentials use a private BuildKit secret and daemon environment, never build arguments', async () => {
  const f = fixture(), proxy = { url: 'https://proxy.example:8443', username: 'builder', password: 'password-no-history', noProxy: 'example.com,127.0.0.1' };
  await f.builder.build('example/image:test', {}, { contextTar: Buffer.alloc(1024), proxy });
  const create = f.calls.find(call => call.path.startsWith('/containers/create')).body;
  assert.ok(create.Env.some(value => value.startsWith('HTTPS_PROXY=https://builder:')));
  const job = f.calls.find(call => call.body?.Cmd?.includes('dockerfile.v0')).body.Cmd;
  assert.ok(job.includes('id=rdf_proxy,src=/run/rdf-proxy'));
  assert.ok(job.includes('id=rdf_proxy_ca,src=/run/rdf-proxy-ca.pem'));
  assert.ok(create.Env.includes('SSL_CERT_FILE=/run/rdf-proxy-ca.pem'));
  assert.ok(create.Env.includes('NO_PROXY=' + proxy.noProxy));
  assert.ok(job.includes('id=rdf_no_proxy,src=/run/rdf-no-proxy'));
  assert.equal(job.join(' ').includes(proxy.password), false);
  const contextUploads = f.calls.filter(call => call.path.endsWith('archive?path=/tmp'));
  assert.ok(contextUploads.every(call => !call.options.rawBody.includes(Buffer.from(proxy.password))));
  assert.ok(f.calls.find(call => call.path.endsWith('archive?path=/run')).options.rawBody.includes(Buffer.from(proxy.password)));
  assert.ok(f.calls.some(call => call.method === 'DELETE' && call.path === '/networks/network-id'));
});

test('reading proxy trust reserves the builder and a trust failure releases it', async () => {
  const f = fixture(); let release;
  f.builder.readTrust = () => new Promise(resolve => { release = resolve; });
  const first = f.builder.build('example/image:test', {}, { contextTar: Buffer.alloc(1024) });
  await assert.rejects(f.builder.build('example/image:second', {}, { contextTar: Buffer.alloc(1024) }), { code: 'build_busy' });
  release(null); await first; assert.equal(f.builder.active, null);
  f.builder.readTrust = async () => { throw new Error('proxy_trust_unavailable'); };
  await assert.rejects(f.builder.build('example/image:test', {}, { contextTar: Buffer.alloc(1024) }), /proxy_trust_unavailable/);
  assert.equal(f.builder.active, null);
});
