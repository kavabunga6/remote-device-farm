import test from 'node:test';
import assert from 'node:assert/strict';
import { NetworkProxyContainer, networkProxySpec, removeNetworkProxies } from './network-proxy-container.mjs';

const image = 'sha256:' + 'a'.repeat(64);
const parent = 'b'.repeat(64);
const helper = 'c'.repeat(64);
const previous = 'd'.repeat(64);
const session = 'session-1234';
const agentId = 'agent';
const name = 'rdf-network-proxy-' + session;
const definition = networkProxySpec(image, parent, session, agentId);
const imageDetail = { Id: image, Config: { Labels: { 'remote-device-farm.network-proxy': '1' } } };

function ownedHelper({ Id = helper, Running = true, Spec = definition } = {}) {
  return { Id, State: { Running }, Config: { Labels: Spec.Labels }, HostConfig: Spec.HostConfig };
}

test('proxy helper runs foreground in exactly one emulator namespace with bounded privileges', () => {
  const { HostConfig: host } = definition;
  assert.equal(definition.Image, image);
  assert.equal(definition.User, '10001:10001');
  assert.deepEqual(definition.Entrypoint.slice(0, 2), ['/usr/bin/env', '-i']);
  assert.deepEqual(definition.Entrypoint.slice(-4), ['/usr/bin/python3', '-I', '-B', '/app/src/network-proxy.py']);
  assert.deepEqual(definition.Cmd, ['serve']);
  assert.equal(host.NetworkMode, 'container:' + parent);
  assert.equal(host.ReadonlyRootfs, true);
  assert.deepEqual(host.CapDrop, ['ALL']);
  assert.deepEqual(host.SecurityOpt, ['no-new-privileges']);
  assert.deepEqual(host.Binds, []);
  assert.ok(!host.CapAdd && !host.Privileged && !host.PidMode && !host.Devices && !host.PortBindings);
  assert.deepEqual(host.Tmpfs, { '/rdf-network': 'rw,nosuid,nodev,noexec,size=8m,mode=0700,uid=10001,gid=10001' });
  assert.equal(host.Memory, 128 * 1024 * 1024);
  assert.equal(host.MemorySwap, host.Memory);
  assert.equal(host.NanoCpus, 500_000_000);
  assert.ok(host.PidsLimit > 64 && host.PidsLimit <= 128);
  assert.equal(host.RestartPolicy.Name, 'no');
  assert.equal(host.LogConfig.Type, 'none');
  assert.ok(!host.AutoRemove);
  assert.throws(() => networkProxySpec('image:latest', parent, session, agentId));
  assert.throws(() => networkProxySpec(image, 'host', session, agentId));
  assert.throws(() => networkProxySpec(image, parent.slice(0, 12), session, agentId));
  assert.throws(() => networkProxySpec(image, parent, [session], agentId));
  assert.throws(() => networkProxySpec(image, parent, session, 'agent/other'));
});

test('helper image resolves from control container or explicit reference to an immutable ID', async () => {
  const calls = [];
  const docker = {
    async inspect(selector) { calls.push(selector); return { Image: image }; },
    async request(method, path) { calls.push([method, path]); return imageDetail; },
  };
  const configuration = { agentId, selfContainerId: 'rdf-agent-control' };
  assert.equal(await new NetworkProxyContainer(docker, configuration).available(), true);
  assert.deepEqual(calls, ['rdf-agent-control', ['GET', `/images/${encodeURIComponent(image)}/json`]]);
  calls.length = 0;
  const selected = 'registry.example/agent:current';
  assert.equal(await new NetworkProxyContainer(docker, { ...configuration, image: selected }).imageId(), image);
  assert.deepEqual(calls, [['GET', `/images/${encodeURIComponent(selected)}/json`]]);
});

test('image capability rejects unlabelled, mutable, mismatched and volume-declaring images', async () => {
  for (const detail of [
    { ...imageDetail, Config: { Labels: {} } },
    { ...imageDetail, Id: 'tag' },
    { ...imageDetail, Id: 'sha256:' + 'e'.repeat(64) },
    { ...imageDetail, Config: { ...imageDetail.Config, Volumes: { '/data': {} } } },
  ]) {
    const proxy = new NetworkProxyContainer({ request: async () => detail }, { agentId, image });
    assert.equal(await proxy.available(), false);
  }
});

test('lookup distinguishes Docker absence from API failure and rejects mismatched ownership', async () => {
  const docker = { inspect: async () => { throw new Error('No such container: ' + name); } };
  const proxy = new NetworkProxyContainer(docker, { agentId, image });
  assert.equal(await proxy.container(parent, session), null);
  docker.inspect = async () => { throw new Error('Docker API HTTP 503 for 404 bytes'); };
  await assert.rejects(proxy.container(parent, session), /503/);
  for (const Spec of [
    networkProxySpec(image, parent, 'another-session', agentId),
    networkProxySpec(image, parent, session, 'other-agent'),
    networkProxySpec(image, 'e'.repeat(64), session, agentId),
    { ...definition, Labels: {} },
    { ...definition, HostConfig: { NetworkMode: 'host' } },
  ]) {
    docker.inspect = async () => ownedHelper({ Spec });
    await assert.rejects(proxy.container(parent, session));
  }
});

test('start reuses a running helper and replaces a stopped helper by immutable ID', async () => {
  const calls = [];
  let current = ownedHelper({ Id: previous });
  const docker = {
    async inspect(selector) { assert.equal(selector, name); return current; },
    async request(method, path, payload) {
      calls.push([method, path]);
      if (method === 'GET') return imageDetail;
      if (method === 'DELETE') current = null;
      if (path.startsWith('/containers/create')) {
        assert.deepEqual(payload, definition);
        return { Id: helper };
      }
      if (path.endsWith('/start')) current = ownedHelper();
    },
  };
  const proxy = new NetworkProxyContainer(docker, { agentId, image });
  assert.equal((await proxy.start(parent, session)).Id, previous);
  assert.deepEqual(calls, []);
  current = ownedHelper({ Id: previous, Running: false });
  assert.equal((await proxy.container(parent, session)).State.Running, false);
  assert.equal((await proxy.start(parent, session)).Id, helper);
  assert.deepEqual(calls, [
    ['GET', `/images/${encodeURIComponent(image)}/json`],
    ['DELETE', `/containers/${previous}?force=true&v=true`],
    ['POST', `/containers/create?name=${name}`],
    ['POST', `/containers/${helper}/start`],
  ]);
});

test('helper lifecycle caps each Docker call and carries the same deadline through start', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 100_000 });
  const timeouts = [];
  let started = false;
  const docker = {
    async inspect(_, { timeoutMs }) {
      timeouts.push(timeoutMs);
      t.mock.timers.tick(1_000);
      return started ? ownedHelper() : ownedHelper({ Id: previous, Running: false });
    },
    async request(method, path, _payload, { timeoutMs }) {
      timeouts.push(timeoutMs);
      if (method === 'GET') { t.mock.timers.tick(1_000); return imageDetail; }
      if (method === 'DELETE') { t.mock.timers.tick(8_000); return; }
      if (path.startsWith('/containers/create')) { t.mock.timers.tick(9_000); return { Id: helper }; }
      assert.equal(path, `/containers/${helper}/start`);
      started = true;
      t.mock.timers.tick(2_000);
    },
  };
  const proxy = new NetworkProxyContainer(docker, { agentId, image });
  const running = await proxy.start(parent, session, Date.now() + 22_000);
  assert.equal(running.Id, helper);
  assert.deepEqual(timeouts, [5_000, 5_000, 10_000, 10_000, 3_000, 1_000]);
});

test('an expired deadline does not issue additional Docker requests', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 100_000 });
  const docker = {
    async inspect(_, { timeoutMs }) {
      assert.equal(timeoutMs, 1_000);
      t.mock.timers.tick(1_000);
      throw new Error('No such container: ' + name);
    },
    async request() { assert.fail('issued Docker request after deadline'); },
  };
  const proxy = new NetworkProxyContainer(docker, { agentId, image });
  await assert.rejects(proxy.start(parent, session, Date.now() + 1_000), /Unable|Could not|Failed/i);
});

test('cleanup filters by session and agent and deletes only the exact inspected helper ID', async () => {
  const deletes = [];
  const docker = {
    async request(method, path) {
      if (method === 'DELETE') { deletes.push(path); return; }
      const query = new URL(path, 'http://docker').searchParams;
      assert.equal(query.get('all'), 'true');
      assert.deepEqual(JSON.parse(query.get('filters')).label, [
        'remote-device-farm.network-proxy-helper=true', 'remote-device-farm.session=' + session,
        'remote-device-farm.agent=' + agentId,
      ]);
      return [{ Id: helper }];
    },
    async inspect() { return ownedHelper({ Id: previous }); },
  };
  await assert.rejects(removeNetworkProxies(docker, session, agentId));
  assert.deepEqual(deletes, []);
  docker.inspect = async selector => { assert.equal(selector, helper); return ownedHelper({ Running: false }); };
  await removeNetworkProxies(docker, session, agentId);
  assert.deepEqual(deletes, [`/containers/${helper}?force=true&v=true`]);
});
