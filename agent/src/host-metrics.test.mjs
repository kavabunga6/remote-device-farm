import test from 'node:test';
import assert from 'node:assert/strict';
import { HostMetricsCollector, cgroupCpuCount, cgroupMemoryMb, classifyEnvironment, describeGpuDevices, parseCpuInfo } from './host-metrics.mjs';

const cpuInfo = Array.from({ length: 32 }, (_, index) => [
  'processor : ' + index,
  'model name : Example CPU',
  'physical id : 0',
  'core id : ' + Math.floor(index / 2),
  'flags : fpu vmx',
].join('\n')).join('\n\n');

test('CPU topology counts unique socket/core pairs, not logical threads', () => {
  const result = parseCpuInfo(cpuInfo);
  assert.equal(result.cpuPhysicalCores, 16);
  assert.equal(result.cpuModel, 'Example CPU');
  assert.equal(result.hypervisor, false);
});

test('environment distinguishes hardware, virtual machines and Kubernetes pods', () => {
  assert.deepEqual(classifyEnvironment({ dmiVendor: 'INTEL', dmiProduct: '', container: true }), {
    environmentType: 'bare-metal', virtualizationType: null, agentRuntime: 'container',
  });
  assert.deepEqual(classifyEnvironment({ dmiVendor: 'QEMU', hypervisor: true, container: true }), {
    environmentType: 'virtual-machine', virtualizationType: 'KVM/QEMU', agentRuntime: 'container',
  });
  assert.deepEqual(classifyEnvironment({ dmiVendor: 'QEMU', kubernetes: true }), {
    environmentType: 'kubernetes-pod', virtualizationType: 'KVM/QEMU', agentRuntime: 'kubernetes-pod',
  });
  assert.equal(classifyEnvironment({ container: true }).environmentType, 'unknown');
});

test('GPU names use NVIDIA driver model when PCI ID names are unavailable', () => {
  assert.deepEqual(describeGpuDevices([{ vendorId: '10de', deviceId: '1fff', model: 'NVIDIA Example GPU' }]), {
    gpuPresent: true, gpuVendor: 'NVIDIA', gpuModel: 'NVIDIA Example GPU',
  });
  const database = '10de  NVIDIA Corporation\n\t1fff  Example [Example GPU]\n';
  assert.equal(describeGpuDevices([{ vendorId: '10de', deviceId: '1fff' }], database).gpuModel,
    'NVIDIA Corporation Example [Example GPU]');
  assert.deepEqual(describeGpuDevices([]), { gpuPresent: false });
});

test('collector reports Docker host capacity and caches hardware probes', async () => {
  const files = new Map([
    ['/proc/cpuinfo', cpuInfo],
    ['/proc/meminfo', 'MemAvailable: 8388608 kB\n'],
    ['/sys/class/dmi/id/sys_vendor', 'INTEL\n'],
    ['/sys/class/dmi/id/product_name', '\n'],
    ['/sys/class/dmi/id/board_vendor', 'INTEL\n'],
    ['/sys/class/dmi/id/bios_vendor', 'American Megatrends Inc.\n'],
    ['/sys/bus/pci/devices/0000:03:00.0/class', '0x030000\n'],
    ['/sys/bus/pci/devices/0000:03:00.0/vendor', '0x10de\n'],
    ['/sys/bus/pci/devices/0000:03:00.0/device', '0x1fff\n'],
    ['/proc/driver/nvidia/gpus/0000:03:00.0/information', 'Model: NVIDIA Example GPU\n'],
  ]);
  let pciLists = 0;
  const fs = {
    readFile: async (path) => {
      if (!files.has(path)) throw new Error('missing');
      return files.get(path);
    },
    readdir: async (path) => {
      if (path === '/sys/bus/pci/devices') { pciLists++; return ['0000:03:00.0']; }
      if (path === '/proc/driver/nvidia/gpus') return ['0000:03:00.0'];
      if (path === '/sys/devices/system/cpu') return [];
      throw new Error('missing');
    },
    access: async (path) => {
      if (path === '/.dockerenv' || path === '/dev/kvm') return;
      throw new Error('missing');
    },
    statfs: async () => ({ bavail: 1000, bsize: 1024 * 1024 }),
  };
  const docker = { hostInfo: async () => ({ cpuThreads: 32, memoryTotalBytes: 64 * 1024 * 1024 * 1024, nvidiaRuntime: true, kvm: true }) };
  const collector = new HostMetricsCollector(docker, { fs, env: {}, clock: () => 12345, runGpu: async () => ({ stdout: '0, 25, 1024, 16384' }) });
  const first = await collector.collect();
  const second = await collector.collect();
  assert.equal(first.cpuCores, 32);
  assert.equal(first.cpuThreads, 32);
  assert.equal(first.cpuPhysicalCores, 16);
  assert.equal(first.memoryTotalMb, 65536);
  assert.equal(first.memoryAvailableMb, 8192);
  assert.equal(first.gpuModel, 'NVIDIA Example GPU');
  assert.equal(first.gpuPresent, true);
  assert.equal(first.environmentType, 'bare-metal');
  assert.equal(first.agentRuntime, 'container');
  assert.equal(first.kvm, true);
  assert.equal(first.gpuTelemetry[0].utilizationPercent, 25);
  assert.equal(first.gpuTelemetry[0].memoryUsedMb, 1024);
  assert.match(first.agentVersion, /^\d+\.\d+\.\d+/);
  assert.equal(first.cpuUsagePercent, undefined);
  assert.equal(first.nvidiaGpuAvailable, true);
  assert.deepEqual(first.gpuCapabilities, ['cuda']);
  assert.equal(second.gpuModel, first.gpuModel);
  assert.equal(pciLists, 1);
});

test('cgroup quota and cpuset bound allocatable CPU without trusting host total', () => {
  assert.equal(cgroupCpuCount('250000 100000', '', '', '0-7'), 2);
  assert.equal(cgroupCpuCount('max 100000', '400000', '100000', '0-1,4'), 3);
  assert.equal(cgroupCpuCount('50000 100000', '', '', ''), 0);
  assert.equal(cgroupMemoryMb(String(5 * 1024 * 1024 * 1024), ''), 5120);
  assert.equal(cgroupMemoryMb('max', '9223372036854771712'), null);
});

test('I/O sidecar cgroup does not cap sibling emulator capacity', async () => {
  const files = new Map([
    ['/sys/fs/cgroup/cpu.max', '50000 100000'],
    ['/sys/fs/cgroup/cpuset.cpus.effective', '0-31'],
    ['/sys/fs/cgroup/memory.max', String(128 * 1024 * 1024)],
  ]);
  const fs = {
    readFile: async path => { if (!files.has(path)) throw new Error('missing'); return files.get(path); },
    readdir: async () => [], access: async () => { throw new Error('missing'); },
    statfs: async () => ({ blocks: 30000, bavail: 10000, bsize: 1024 * 1024 }),
  };
  const docker = { hostInfo: async () => ({ cpuThreads: 32, memoryTotalBytes: 64 * 1024 * 1024 * 1024 }) };
  const collector = new HostMetricsCollector(docker, { fs, env: { AGENT_HOST_IP: '192.0.2.10' } });
  const metrics = await collector.collect();
  assert.equal(metrics.cpuAllocatableCores, 32);
  assert.equal(metrics.memoryAllocatableMb, 65536);
  assert.equal(metrics.agentCpuLimitCores, 0);
  assert.equal(metrics.agentMemoryLimitMb, 128);
  assert.equal(metrics.diskTotalGb, 29);
  assert.equal(metrics.hostIp, '192.0.2.10');
  assert.deepEqual(metrics.gpuCapabilities, []);
  assert.ok(Math.min(Math.floor((32 - 6) / 4), Math.floor((65536 - 13108) / 4096)) > 1);
});

test('nested daemon requires explicit node ceilings and unavailable Docker info gives zero capacity', async () => {
  const fs = {
    readFile: async () => { throw new Error('missing'); },
    readdir: async () => [], access: async () => { throw new Error('missing'); },
    statfs: async () => null,
  };
  const docker = { hostInfo: async () => ({ cpuThreads: 32, memoryTotalBytes: 64 * 1024 * 1024 * 1024 }) };
  const bounded = new HostMetricsCollector(docker, { fs, env: { AGENT_DOCKER_CAPACITY_SCOPE: 'bounded' } });
  assert.equal((await bounded.collect()).cpuAllocatableCores, 0);
  assert.equal((await bounded.collect()).memoryAllocatableMb, 0);
  const explicit = new HostMetricsCollector(docker, { fs, env: {
    AGENT_DOCKER_CAPACITY_SCOPE: 'bounded', AGENT_NODE_CPU_LIMIT: '8', AGENT_NODE_MEMORY_MB: '16384',
  } });
  assert.equal((await explicit.collect()).cpuAllocatableCores, 8);
  assert.equal((await explicit.collect()).memoryAllocatableMb, 16384);
  const missing = new HostMetricsCollector({ hostInfo: async () => { throw new Error('unavailable'); } }, { fs, env: {} });
  assert.equal((await missing.collect()).cpuAllocatableCores, 0);
  assert.equal((await missing.collect()).memoryAllocatableMb, 0);
});
