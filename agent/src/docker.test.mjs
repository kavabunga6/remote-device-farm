import test from 'node:test';
import assert from 'node:assert/strict';
import { DockerClient, SD_CARD_LAUNCH_SCRIPT } from './docker.mjs';

test('emulator starts on its private management network without published ports', async () => {
  const docker = new DockerClient('/unused');
  const calls = [];
  docker.ensureSessionNetworks = async () => ({ management: 'rdf-m-session-1', egress: 'rdf-e-session-1' });
  docker.request = async (method, path, body) => {
    calls.push({ method, path, body });
    if (path.startsWith('/containers/create')) return { Id: 'container-1' };
    return {};
  };
  const created = await docker.createEmulator({ sessionId: 'session-1', agentId: 'host-1', selfContainerId: 'agent',
    profile: { image: 'example/android:1', cpu: 2, memoryMb: 4096, guestMemoryMb: 2048, guestCores: 2, diskGb: 8, emulatorParams: '-no-snapshot' }, adbPublicKey: 'public-key' });
  assert.equal(created.containerId, 'container-1');
  const body = calls.find((call) => call.path.startsWith('/containers/create'))?.body;
  assert.equal(body.HostConfig.NetworkMode, 'rdf-m-session-1');
  assert.equal(body.HostConfig.Memory, 4096 * 1024 * 1024);
  assert.equal(body.HostConfig.MemorySwap, body.HostConfig.Memory);
  assert.ok(body.Env.includes('ADBKEY_PUB=public-key'));
  assert.ok(body.Env.includes('EMULATOR_PARAMS=-no-snapshot -partition-size 8192 -memory 2048 -cores 2 -gpu swiftshader_indirect'));
  assert.ok(!body.Env.some(value => value.startsWith('ADBKEY=')));
  assert.equal(body.HostConfig.PortBindings, undefined);
  assert.equal(body.HostConfig.Binds, undefined);
  assert.deepEqual(Object.keys(body.NetworkingConfig.EndpointsConfig), ['rdf-m-session-1']);
  assert.equal(calls.at(-1)?.path, '/networks/rdf-e-session-1/connect');
});

test('network toggle only detaches the emulator egress network', async () => {
  const docker = new DockerClient('/unused');
  const calls = [];
  let egressAttached = true;
  docker.ensureNetwork = async () => ({});
  docker.inspect = async () => ({
    Config: { Labels: {
      'remote-device-farm.managed': 'true',
      'remote-device-farm.agent': 'host-1',
      'remote-device-farm.session': 'session-1',
    } },
    NetworkSettings: { Networks: { 'rdf-m-session-1': {}, ...(egressAttached ? { 'rdf-e-session-1': {} } : {}) } },
  });
  docker.request = async (method, path, body) => {
    calls.push({ method, path, body });
    if (path.endsWith('/disconnect')) egressAttached = false;
  };
  await docker.setEgress('container-1', 'session-1', 'host-1', false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, '/networks/rdf-e-session-1/disconnect');
  assert.deepEqual(calls[0].body, { Container: 'container-1', Force: false });
});

test('network toggle rejects unexpected emulator network attachments', async () => {
  const docker = new DockerClient('/unused');
  docker.inspect = async () => ({
    Config: { Labels: {
      'remote-device-farm.managed': 'true',
      'remote-device-farm.agent': 'host-1',
      'remote-device-farm.session': 'session-1',
    } },
    NetworkSettings: { Networks: { 'rdf-m-session-1': {}, other: {} } },
  });
  await assert.rejects(() => docker.setEgress('container-1', 'session-1', 'host-1', false),
    /network attachments differ/);
});

test('network toggle cannot target an unrelated container', async () => {
  const docker = new DockerClient('/unused');
  docker.inspect = async () => ({ Config: { Labels: { 'remote-device-farm.session': 'other' } } });
  await assert.rejects(() => docker.setEgress('other', 'session-1', 'host-1', false));
});

test('network validation rejects a management network without an isolated gateway', async () => {
  const docker = new DockerClient('/unused');
  docker.inspectNetwork = async () => ({
    Driver: 'bridge', Internal: true, EnableIPv6: false, Options: {},
    Labels: {
      'remote-device-farm.managed': 'true',
      'remote-device-farm.agent': 'host-1',
      'remote-device-farm.session': 'session-1',
      'remote-device-farm.purpose': 'management',
    },
  });
  await assert.rejects(() => docker.ensureNetwork('rdf-m-session-1', 'session-1', 'host-1', 'management'),
    /unsafe settings/);
});

test('network validation rejects an internal egress network', async () => {
  const docker = new DockerClient('/unused');
  docker.inspectNetwork = async () => ({
    Driver: 'bridge', Internal: true, EnableIPv6: false, Options: {},
    Labels: {
      'remote-device-farm.managed': 'true',
      'remote-device-farm.agent': 'host-1',
      'remote-device-farm.session': 'session-1',
      'remote-device-farm.purpose': 'egress',
    },
  });
  await assert.rejects(() => docker.ensureNetwork('rdf-e-session-1', 'session-1', 'host-1', 'egress'),
    /unsafe settings/);
});

test('lost Docker create response still cleans up by verified container name', async () => {
  const docker = new DockerClient('/unused');
  const removed = [];
  docker.ensureSessionNetworks = async () => ({ management: 'rdf-m-session-1', egress: 'rdf-e-session-1' });
  docker.request = async (method, path) => {
    if (path.startsWith('/containers/create')) throw new Error('Connection lost after create');
    return { Config: {} };
  };
  docker.removeManaged = async (...args) => { removed.push(['container', ...args]); };
  docker.removeSessionNetworks = async (...args) => { removed.push(['networks', ...args]); };
  await assert.rejects(() => docker.createEmulator({ sessionId: 'session-1', agentId: 'host-1', selfContainerId: 'agent',
    profile: { image: 'example/android:1', cpu: 2, memoryMb: 4096, diskGb: 8, emulatorParams: '' }, adbPublicKey: 'public-key' }),
  /Connection lost/);
  assert.deepEqual(removed, [
    ['container', 'rdf-session-1', 'session-1', 'host-1'],
    ['networks', 'session-1', 'host-1', 'agent'],
  ]);
});
test('NVIDIA mode requests one GPU and host renderer without X socket or public ports', async () => {
  const docker = new DockerClient('/unused');
  const calls = [];
  docker.ensureSessionNetworks = async () => ({ management: 'rdf-m-session-2', egress: 'rdf-e-session-2' });
  docker.request = async (method, path, body) => {
    calls.push({ method, path, body });
    if (path.startsWith('/containers/create')) return { Id: 'container-2' };
    return {};
  };
  await docker.createEmulator({ sessionId: 'session-2', agentId: 'host-1', selfContainerId: 'agent',
    profile: { image: 'example/android:gpu', cpu: 2, memoryMb: 4096, diskGb: 8,
      emulatorParams: '-no-snapshot', gpuMode: 'nvidia', gpuBackend: 'cuda' }, adbPublicKey: 'public-key' });
  const body = calls.find(call => call.path.startsWith('/containers/create'))?.body;
  assert.deepEqual(body.HostConfig.DeviceRequests,
    [{ Driver: 'nvidia', Count: 1, Capabilities: [['gpu']] }]);
  assert.ok(body.Env.includes('NVIDIA_DRIVER_CAPABILITIES=compute,graphics,utility,display'));
  assert.equal(body.HostConfig.Runtime, 'nvidia');
  assert.equal(body.Tty, true);
  assert.match(body.Env.find(value => value.startsWith('EMULATOR_PARAMS=')), /-gpu host$/);
  assert.equal(body.HostConfig.Binds, undefined);
  assert.equal(body.HostConfig.PortBindings, undefined);
});

test('NVIDIA runtime capability comes from Docker daemon info', async () => {
  const docker = new DockerClient('/unused');
  docker.request = async () => ({ Runtimes: { nvidia: {} } });
  assert.equal(await docker.hasNvidiaRuntime(), true);
  docker.request = async () => ({ Runtimes: { runc: {} } });
  assert.equal(await docker.hasNvidiaRuntime(), false);
});

test('configured NVIDIA Xorg modules bind read-only only for GPU sessions', async () => {
  const docker = new DockerClient('/unused');
  const created = [];
  docker.ensureSessionNetworks = async () => ({ management: 'rdf-m-session-3', egress: 'rdf-e-session-3' });
  docker.request = async (method, route, body) => {
    if (route.startsWith('/containers/create')) {
      created.push(body);
      return { Id: 'container-3' };
    }
    return {};
  };
  const base = { sessionId: 'session-3', agentId: 'host-1', selfContainerId: 'agent',
    adbPublicKey: 'public-key', nvidiaXorgModuleDir: '/usr/lib/x86_64-linux-gnu/nvidia/xorg' };
  const profile = { image: 'example/android:gpu', cpu: 2, memoryMb: 4096, diskGb: 8,
    emulatorParams: '', gpuMode: 'nvidia', gpuBackend: 'cuda' };
  await docker.createEmulator({ ...base, profile });
  assert.deepEqual(created[0].HostConfig.Mounts, [{
    Type: 'bind', Source: base.nvidiaXorgModuleDir, Target: '/opt/nvidia-xorg',
    ReadOnly: true, BindOptions: { Propagation: 'rprivate' },
  }]);
  assert.equal(created[0].HostConfig.Binds, undefined);
  assert.equal(created[0].HostConfig.PortBindings, undefined);

  await docker.createEmulator({ ...base, profile: { ...profile, gpuMode: 'software' } });
  assert.equal(created[1].HostConfig.Mounts, undefined);
  assert.equal(created[1].HostConfig.DeviceRequests, undefined);
  assert.equal(created[1].HostConfig.Runtime, undefined);
  assert.equal(created[1].Tty, undefined);
  assert.match(created[1].Env.find(value => value.startsWith('EMULATOR_PARAMS=')), /-gpu swiftshader_indirect$/);
  assert.ok(!created[1].Env.some(value => value.startsWith('NVIDIA_DRIVER_CAPABILITIES=')));
  assert.ok(created[1].Env.includes('NVIDIA_VISIBLE_DEVICES=void'), 'CPU mode stays private even when NVIDIA is the daemon default runtime');
  await assert.rejects(() => docker.createEmulator({
    ...base, nvidiaXorgModuleDir: '/usr/lib/../etc', profile,
  }), /AGENT_NVIDIA_XORG_MODULE_DIR/);
  assert.equal(created.length, 2);
});
test('egress networks get a firewall-friendly bridge name and management networks stay isolated', async () => {
  const { egressBridgeName } = await import('./docker.mjs');
  const name = egressBridgeName('3f0c1d2e-aaaa-bbbb-cccc-000000000001');
  assert.match(name, /^rdfe[0-9a-f]{11}$/);
  assert.equal(name.length, 15);
  assert.equal(egressBridgeName('3f0c1d2e-aaaa-bbbb-cccc-000000000001'), name);
  assert.notEqual(egressBridgeName('other-session'), name);
  const docker = new DockerClient('/unused');
  const created = [];
  docker.inspectNetwork = async () => { throw new Error('404 network not found'); };
  docker.request = async (method, path, body) => { created.push({ method, path, body }); return {}; };
  await docker.ensureNetwork('rdf-e-s1', 's1', 'host-1', 'egress').catch(() => {});
  await docker.ensureNetwork('rdf-m-s1', 's1', 'host-1', 'management').catch(() => {});
  const egress = created.find((call) => call.body?.Name === 'rdf-e-s1');
  const management = created.find((call) => call.body?.Name === 'rdf-m-s1');
  assert.equal(egress.body.Options['com.docker.network.bridge.name'], egressBridgeName('s1'));
  assert.equal(management.body.Internal, true);
  assert.equal(management.body.Options['com.docker.network.bridge.name'], undefined);
});

test('egress validation requires the exact firewall-matched bridge name', async () => {
  const { egressBridgeName } = await import('./docker.mjs');
  const docker = new DockerClient('/unused');
  const network = {
    Driver: 'bridge', Internal: false, EnableIPv6: false, Options: {},
    Labels: {
      'remote-device-farm.managed': 'true',
      'remote-device-farm.agent': 'host-1',
      'remote-device-farm.session': 'session-1',
      'remote-device-farm.purpose': 'egress',
    },
  };
  docker.inspectNetwork = async () => network;
  await assert.rejects(() => docker.ensureNetwork('rdf-e-session-1', 'session-1', 'host-1', 'egress'),
    /unsafe settings/);
  network.Options['com.docker.network.bridge.name'] = 'rdfe00000000000';
  await assert.rejects(() => docker.ensureNetwork('rdf-e-session-1', 'session-1', 'host-1', 'egress'),
    /unsafe settings/);
  network.Options['com.docker.network.bridge.name'] = egressBridgeName('session-1');
  assert.equal(await docker.ensureNetwork('rdf-e-session-1', 'session-1', 'host-1', 'egress'), network);
});
test('profile container variables reach the container, the farm own variables cannot be overridden', async () => {
  const docker = new DockerClient('/unused');
  let body;
  docker.ensureSessionNetworks = async () => ({ management: 'rdf-m-session-3', egress: 'rdf-e-session-3' });
  docker.request = async (method, path, payload) => { if (path.startsWith('/containers/create')) { body = payload; return { Id: 'c3' }; } return {}; };
  await docker.createEmulator({ sessionId: 'session-3', agentId: 'host-1', selfContainerId: 'agent', adbPublicKey: 'public-key',
    profile: { image: 'example/android:1', cpu: 2, memoryMb: 4096, guestMemoryMb: null, guestCores: null, diskGb: 8, emulatorParams: '', containerEnv: { WEB_VNC: 'true', API_KEY: 'x' } } });
  assert.ok(body.Env.includes('WEB_VNC=true') && body.Env.includes('API_KEY=x'));
  assert.ok(body.Env.indexOf('WEB_VNC=true') < body.Env.indexOf('ADBKEY_PUB=public-key'), 'farm variables come last and win');
  assert.deepEqual(body.HostConfig.Binds ?? [], [], 'variables never add Docker run options');
});

test('legacy GiB SD option preserves the original entrypoint and command', async () => {
  const docker = new DockerClient('/unused');
  const calls = [];
  docker.ensureSessionNetworks = async () => ({ management: 'm', egress: 'e' });
  docker.request = async (method, path, body) => {
    calls.push({ method, path, body });
    if (path.startsWith('/containers/create')) return { Id: 'c1' };
    if (path.startsWith('/images/')) return { Config: { Entrypoint: ['/launch.sh'], Cmd: ['--x'] } };
    return {};
  };
  await docker.createEmulator({ sessionId: 's', agentId: 'h', selfContainerId: 'a',
    profile: { image: 'example/android:1', cpu: 2, memoryMb: 4096, guestMemoryMb: null, guestCores: null, diskGb: 4, sdcardGb: 2, emulatorParams: '', containerEnv: {} }, adbPublicKey: 'k' });
  const body = calls.find(call => call.path.startsWith('/containers/create')).body;
  assert.ok(body.Env.includes(`RDF_SD_CARD_MB=${2 * 1024}`));
  assert.ok(body.Env.some(value => value.startsWith('EMULATOR_PARAMS=') && value.includes('-partition-size 4096 -sdcard /android-home/rdf-sdcard.img')));
  assert.deepEqual(body.Entrypoint.slice(-2), ['/launch.sh', '--x']);
  assert.deepEqual(body.Cmd, []);
});

test('storage overrides configure Android data and a per-session SD card inside the Google image', async () => {
  for (const sdCardMb of [undefined, 0, 128, 32768]) {
    const docker = new DockerClient('/unused');
    let body;
    docker.ensureSessionNetworks = async () => ({ management: 'rdf-m-storage', egress: 'rdf-e-storage' });
    docker.request = async (method, endpoint, input) => {
      if (endpoint.startsWith('/containers/create')) { body = input; return { Id: 'storage' }; }
      if (endpoint.startsWith('/images/')) return { Config: { Cmd: ['/android/sdk/launch-emulator.sh'] } };
      return {};
    };
    await docker.createEmulator({ sessionId: 'storage', agentId: 'agent-1', selfContainerId: 'agent',
      profile: { image: 'google-image', cpu: 2, memoryMb: 4096, diskGb: 24, sdCardMb, emulatorParams: '-no-snapshot' },
      adbPublicKey: 'public-key' });
    const config = body.Env.find((value) => value.startsWith('AVD_CONFIG='));
    const params = body.Env.find((value) => value.startsWith('EMULATOR_PARAMS='));
    assert.match(config, /disk.dataPartition.size=24576M/);
    assert.match(params, /-partition-size 24576/);
    assert.equal(body.HostConfig.Binds, undefined);
    assert.equal(body.HostConfig.Privileged, undefined);
    assert.equal(body.HostConfig.StorageOpt, undefined, 'Android size is not a host filesystem quota');
    assert.equal(body.Image, 'google-image');
    if (sdCardMb === undefined) {
      assert.equal(body.Cmd, undefined, 'image launcher and SD defaults are preserved');
      assert.doesNotMatch(config, /sdcard|sdCard/);
    } else if (sdCardMb === 0) {
      assert.match(config, /hw.sdCard=no/);
      assert.equal(body.Cmd, undefined);
      assert.doesNotMatch(params, /-sdcard/);
    } else {
      assert.match(config, /hw.sdCard=yes/);
      assert.ok(config.includes(`sdcard.size=${sdCardMb}M`));
      assert.ok(body.Env.includes(`RDF_SD_CARD_MB=${sdCardMb}`));
      assert.match(params, /-sdcard \/android-home\/rdf-sdcard.img/);
      assert.deepEqual(body.Entrypoint, ['/bin/sh', '-ec', SD_CARD_LAUNCH_SCRIPT, 'rdf-sdcard', '/android/sdk/launch-emulator.sh']);
      assert.deepEqual(body.Cmd, []);
      assert.match(SD_CARD_LAUNCH_SCRIPT, /mksdcard/);
      assert.ok(!SD_CARD_LAUNCH_SCRIPT.includes(String(sdCardMb)), 'values are supplied through environment, not shell source');
    }
  }
});


const removalContainer = () => ({ Id: 'owned-id', State: { Status: 'removing' }, Config: { Labels: {
  'remote-device-farm.managed': 'true', 'remote-device-farm.agent': 'node-1', 'remote-device-farm.session': 'session-1',
} } });

for (const failure of ['removal of container owned-id is already in progress', 'Docker API request timed out']) {
  test('pending removal waits for confirmed absence after ' + failure, async () => {
    const docker = new DockerClient('/unused');
    docker.inspect = async () => removalContainer();
    const calls = [];
    let polls = 0;
    docker.request = async (method, path, body, options) => {
      calls.push({ method, path, options });
      if (method === 'DELETE') throw new Error(failure);
      if (++polls === 1) return removalContainer();
      throw new Error('404 No such container');
    };
    await docker.removeManaged('rdf-session-1', 'session-1', 'node-1');
    assert.equal(calls.filter(call => call.method === 'DELETE').length, 1);
    assert.equal(calls[0].options.timeoutMs, 90_000);
    assert.ok(calls.every(call => call.path.includes('/containers/owned-id')), 'removal is pinned to the owned ID');
    assert.equal(polls, 2);
  });
}

test('unconfirmed or foreign container removal cannot report successful cleanup', async () => {
  const docker = new DockerClient('/unused');
  docker.inspect = async () => removalContainer();
  docker.request = async method => {
    if (method === 'DELETE') throw new Error('removal is already in progress');
    return removalContainer();
  };
  await assert.rejects(docker.removeManaged('owned-id', 'session-1', 'node-1', { timeoutMs: 5 }), /not confirmed/);
  let deleted = false;
  docker.inspect = async () => ({ ...removalContainer(), Config: { Labels: {} } });
  docker.request = async () => { deleted = true; };
  await assert.rejects(docker.removeManaged('owned-id', 'session-1', 'node-1'), /not owned/);
  assert.equal(deleted, false);
});
