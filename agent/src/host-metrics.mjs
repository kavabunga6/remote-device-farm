import os from 'node:os';
import { LiveTelemetryCollector } from './live-telemetry.mjs';
import net from 'node:net';
import { access, readFile, readdir, statfs } from 'node:fs/promises';

const MB = 1024 * 1024;
const HARDWARE_TTL_MS = 10 * 60 * 1000;
const PCI_ROOT = '/sys/bus/pci/devices';
const CPU_ROOT = '/sys/devices/system/cpu';
const knownGpuVendors = { '10de': 'NVIDIA', '1002': 'AMD', '8086': 'Intel', '1af4': 'Virtio', '1a03': 'ASPEED', '15ad': 'VMware' };
const vmPatterns = [
  [/amazon ec2/i, 'Amazon EC2'], [/google compute engine/i, 'Google Compute Engine'],
  [/microsoft corporation.*virtual machine|hyper-v/i, 'Hyper-V'], [/vmware/i, 'VMware'],
  [/virtualbox|innotek/i, 'VirtualBox'], [/qemu|kvm|bochs|standard pc \(q35|standard pc \(i440/i, 'KVM/QEMU'],
  [/xen|hvm domu/i, 'Xen'], [/openstack/i, 'OpenStack'], [/parallels/i, 'Parallels'],
  [/bhyve/i, 'bhyve'], [/nutanix/i, 'Nutanix'],
];
const physicalVendor = /\b(dell|hewlett.packard|hpe|lenovo|supermicro|asus|asustek|gigabyte|micro.star|msi|acer|apple|intel|asrock|fujitsu|ibm|cisco|huawei|inspur|h3c|tyan|quanta)\b/i;
const clean = (value, max = 200) => String(value || '').replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const positiveInteger = (value) => Number.isSafeInteger(value) && value > 0 ? value : null;
const optionalText = async (fs, path) => fs.readFile(path, 'utf8').catch(() => '');
const cpuField = (block, name) => block.match(new RegExp('^' + name + '\\s*:\\s*(.+)$', 'mi'))?.[1]?.trim() || '';

function cgroupPositive(value) {
  const parsed = Number(String(value || '').trim());
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export function cgroupCpuCount(cpuMax, v1Quota, v1Period, cpuset) {
  let quota = null;
  const [v2Quota, v2Period] = String(cpuMax || '').trim().split(/\s+/);
  if (v2Quota && v2Quota !== 'max') {
    const q = cgroupPositive(v2Quota), p = cgroupPositive(v2Period);
    if (q && p) quota = Math.floor(q / p);
  }
  if (quota === null) {
    const q = cgroupPositive(v1Quota), p = cgroupPositive(v1Period);
    if (q && p) quota = Math.floor(q / p);
  }
  let cpus = null;
  if (/^[0-9,\-\s]+$/.test(String(cpuset || ''))) {
    let count = 0;
    for (const entry of String(cpuset).trim().split(',')) {
      if (!entry) continue;
      const match = /^(\d+)(?:-(\d+))?$/.exec(entry.trim());
      if (!match) return quota;
      const first = Number(match[1]), last = Number(match[2] ?? match[1]);
      if (last < first || last - first > 4096) return quota;
      count += last - first + 1;
    }
    if (count > 0 && count <= 4096) cpus = count;
  }
  return quota === null ? cpus : cpus === null ? quota : Math.min(quota, cpus);
}

export function cgroupMemoryMb(v2Limit, v1Limit) {
  const limit = cgroupPositive(v2Limit) ?? cgroupPositive(v1Limit);
  if (!limit || limit >= Number.MAX_SAFE_INTEGER) return null;
  return Math.floor(limit / MB);
}

export function parseCpuInfo(content) {
  const blocks = content.split(/\n\s*\n/).filter(Boolean);
  const cpuModel = clean(blocks.map((block) => cpuField(block, 'model name') || cpuField(block, 'Processor') || cpuField(block, 'Hardware')).find(Boolean));
  const cores = new Set();
  for (const block of blocks) {
    const packageId = cpuField(block, 'physical id');
    const coreId = cpuField(block, 'core id');
    if (packageId && coreId) cores.add(packageId + ':' + coreId);
  }
  return {
    cpuModel: cpuModel || null,
    cpuPhysicalCores: cores.size || null,
    hypervisor: /^flags\s*:\s*.*\bhypervisor\b/m.test(content),
  };
}

export function classifyEnvironment({ dmiVendor = '', dmiProduct = '', hypervisor = false, kubernetes = false, container = false }) {
  const dmi = clean(dmiVendor + ' ' + dmiProduct);
  const match = vmPatterns.find(([pattern]) => pattern.test(dmi));
  const virtualizationType = match?.[1] || (hypervisor ? 'Hypervisor' : null);
  const nodeType = virtualizationType ? 'virtual-machine' : physicalVendor.test(dmi) ? 'bare-metal' : 'unknown';
  return {
    environmentType: kubernetes ? 'kubernetes-pod' : nodeType,
    virtualizationType,
    agentRuntime: kubernetes ? 'kubernetes-pod' : container ? 'container' : 'process',
  };
}

function pciNames(text, devices) {
  const wanted = new Set(devices.map((device) => device.vendorId));
  const names = new Map();
  let vendorId = '';
  for (const line of text.split(/\r?\n/)) {
    const vendor = /^([0-9a-fA-F]{4})\s+(.+)/.exec(line);
    if (vendor) {
      vendorId = vendor[1].toLowerCase();
      if (wanted.has(vendorId)) names.set(vendorId, { name: clean(vendor[2], 80), devices: new Map() });
      continue;
    }
    if (!wanted.has(vendorId)) continue;
    const device = /^\t([0-9a-fA-F]{4})\s+(.+)/.exec(line);
    if (device) names.get(vendorId)?.devices.set(device[1].toLowerCase(), clean(device[2], 140));
  }
  return names;
}

export function describeGpuDevices(devices, pciIds = '') {
  if (!devices.length) return { gpuPresent: false };
  const names = pciNames(pciIds, devices);
  const vendors = new Set();
  const models = new Set();
  for (const { vendorId, deviceId, model: reportedModel } of devices) {
    const vendor = names.get(vendorId)?.name || knownGpuVendors[vendorId] || 'PCI ' + vendorId;
    const model = reportedModel || names.get(vendorId)?.devices.get(deviceId) || 'device ' + deviceId;
    vendors.add(vendor);
    models.add(model.startsWith(vendor + ' ') ? model : vendor + ' ' + model);
  }
  return { gpuPresent: true, gpuVendor: clean([...vendors].join(', '), 120), gpuModel: clean([...models].join('; ')) };
}

async function sysfsPhysicalCores(fs) {
  const entries = await fs.readdir(CPU_ROOT).catch(() => []);
  const pairs = await Promise.all(entries.filter((name) => /^cpu\d+$/.test(name)).map(async (name) => {
    const root = CPU_ROOT + '/' + name + '/topology';
    const [socket, core] = await Promise.all([
      optionalText(fs, root + '/physical_package_id'), optionalText(fs, root + '/core_id'),
    ]);
    return socket.trim() && core.trim() ? socket.trim() + ':' + core.trim() : null;
  }));
  return new Set(pairs.filter(Boolean)).size || null;
}

async function pciGpuDevices(fs) {
  let entries;
  try { entries = await fs.readdir(PCI_ROOT); }
  catch { return null; }
  const devices = await Promise.all(entries.map(async (name) => {
    const root = PCI_ROOT + '/' + name;
    const classCode = (await optionalText(fs, root + '/class')).trim();
    if (!/^0x03[0-9a-f]{4}$/i.test(classCode)) return null;
    const vendorId = (await optionalText(fs, root + '/vendor')).trim().replace(/^0x/i, '').toLowerCase();
    const deviceId = (await optionalText(fs, root + '/device')).trim().replace(/^0x/i, '').toLowerCase();
    return /^[0-9a-f]{4}$/.test(vendorId) && /^[0-9a-f]{4}$/.test(deviceId) ? { vendorId, deviceId, address: name } : null;
  }));
  return devices.filter(Boolean);
}

async function nvidiaModels(fs) {
  const root = '/proc/driver/nvidia/gpus';
  const entries = await fs.readdir(root).catch(() => []);
  const models = new Map();
  for (const address of entries) {
    const info = await optionalText(fs, root + '/' + address + '/information');
    const model = clean(info.match(/^Model:\s*(.+)$/m)?.[1]);
    if (model) models.set(address, model);
  }
  return models;
}
async function collectHardware(fs, env) {
  const [cpuInfo, dmiVendor, dmiProduct, boardVendor, biosVendor, gpus, dockerenv, containerenv, cgroup, serviceAccount] = await Promise.all([
    optionalText(fs, '/proc/cpuinfo'),
    optionalText(fs, '/sys/class/dmi/id/sys_vendor'),
    optionalText(fs, '/sys/class/dmi/id/product_name'),
    optionalText(fs, '/sys/class/dmi/id/board_vendor'),
    optionalText(fs, '/sys/class/dmi/id/bios_vendor'),
    pciGpuDevices(fs),
    fs.access('/.dockerenv').then(() => true, () => false),
    fs.access('/run/.containerenv').then(() => true, () => false),
    optionalText(fs, '/proc/1/cgroup'),
    fs.access('/var/run/secrets/kubernetes.io/serviceaccount').then(() => true, () => false),
  ]);
  const cpu = parseCpuInfo(cpuInfo);
  const environment = classifyEnvironment({
    dmiVendor: [dmiVendor, boardVendor, biosVendor].join(' '), dmiProduct, hypervisor: cpu.hypervisor,
    kubernetes: Boolean(env.KUBERNETES_SERVICE_HOST || serviceAccount || /kubepods/i.test(cgroup)),
    container: Boolean(dockerenv || containerenv || /docker|containerd|libpod/i.test(cgroup)),
  });
  let gpu = {};
  if (gpus !== null) {
    const nvidia = await nvidiaModels(fs);
    for (const device of gpus) if (device.vendorId === '10de') device.model = nvidia.get(device.address);
    gpu = describeGpuDevices(gpus, gpus.length ? await optionalText(fs, '/usr/share/misc/pci.ids') : '');
  }
  return {
    cpuModel: cpu.cpuModel || undefined,
    cpuPhysicalCores: cpu.cpuPhysicalCores || await sysfsPhysicalCores(fs) || undefined,
    architecture: os.arch(),
    ...gpu,
    ...environment,
  };
}

export class HostMetricsCollector {
  constructor(docker, { fs = { access, readFile, readdir, statfs }, env = process.env, clock = Date.now, runGpu } = {}) {
    this.docker = docker;
    this.fs = fs;
    this.env = env;
    this.clock = clock;
    this.hardware = null;
    this.hardwareAt = 0;
    this.telemetry = new LiveTelemetryCollector({ fs, env, clock, runGpu });
  }

  async collect() {
    if (!this.hardware || this.clock() - this.hardwareAt >= HARDWARE_TTL_MS) {
      this.hardware = await collectHardware(this.fs, this.env);
      this.hardwareAt = this.clock();
    }
    const [info, memInfo, filesystem, cpuMax, cpuQuota, cpuPeriod, cpuSet, cpuSetV1, memoryMax, memoryLimitV1] = await Promise.all([
      this.docker.hostInfo().catch(() => null),
      optionalText(this.fs, '/proc/meminfo'),
      this.fs.statfs('/').catch(() => null),
      optionalText(this.fs, '/sys/fs/cgroup/cpu.max'),
      optionalText(this.fs, '/sys/fs/cgroup/cpu/cpu.cfs_quota_us'),
      optionalText(this.fs, '/sys/fs/cgroup/cpu/cpu.cfs_period_us'),
      optionalText(this.fs, '/sys/fs/cgroup/cpuset.cpus.effective'),
      optionalText(this.fs, '/sys/fs/cgroup/cpuset/cpuset.cpus'),
      optionalText(this.fs, '/sys/fs/cgroup/memory.max'),
      optionalText(this.fs, '/sys/fs/cgroup/memory/memory.limit_in_bytes'),
    ]);
    const availableKb = Number(memInfo.match(/^MemAvailable:\s+(\d+)\s+kB/m)?.[1]);
    const daemonCpu = positiveInteger(info?.cpuThreads) || 0;
    const daemonMemoryMb = Math.floor((positiveInteger(info?.memoryTotalBytes) || 0) / MB);
    const cpuThreads = daemonCpu || os.cpus().length;
    const memoryTotal = daemonMemoryMb ? daemonMemoryMb * MB : os.totalmem();
    const memoryFreeMb = Math.round(os.freemem() / MB);
    const cgroupCpu = cgroupCpuCount(cpuMax, cpuQuota, cpuPeriod, cpuSet || cpuSetV1);
    const cgroupMemory = cgroupMemoryMb(memoryMax, memoryLimitV1);
    // The I/O process runs beside emulator containers. Its own cgroup limit must
    // not constrain sibling containers; Docker daemon capacity is authoritative.
    // A nested daemon may itself be quota-bound. Require explicit ceilings in
    // that deployment mode, and default Kubernetes to the conservative mode.
    const scope = this.env.AGENT_DOCKER_CAPACITY_SCOPE ||
      (this.hardware.agentRuntime === 'kubernetes-pod' ? 'bounded' : 'daemon');
    const cpuCeiling = cgroupPositive(this.env.AGENT_NODE_CPU_LIMIT);
    const memoryCeiling = cgroupPositive(this.env.AGENT_NODE_MEMORY_MB);
    const validScope = scope === 'daemon' || scope === 'bounded';
    const boundedReady = scope !== 'bounded' || (cpuCeiling && memoryCeiling);
    const allocatableCpu = validScope && boundedReady && daemonCpu
      ? Math.min(daemonCpu, cpuCeiling ?? daemonCpu) : 0;
    const allocatableMemory = validScope && boundedReady && daemonMemoryMb
      ? Math.min(daemonMemoryMb, memoryCeiling ?? daemonMemoryMb) : 0;
    const configuredIp = String(this.env.AGENT_HOST_IP || '').trim();
    const hostIp = net.isIP(configuredIp) ? configuredIp : undefined;
    const telemetry = await this.telemetry.collect(Boolean(info?.nvidiaRuntime || /nvidia/i.test(this.hardware.gpuVendor || '')));
    return {
      ...this.hardware, ...telemetry,
      cpuCores: cpuThreads,
      cpuThreads, cpuAllocatableCores: allocatableCpu,
      memoryTotalMb: Math.round(memoryTotal / MB), memoryAllocatableMb: allocatableMemory,
      agentCpuLimitCores: cgroupCpu, agentMemoryLimitMb: cgroupMemory,
      memoryFreeMb,
      memoryAvailableMb: availableKb > 0 ? Math.floor(availableKb / 1024) : memoryFreeMb,
      diskFreeGb: filesystem ? Math.round(filesystem.bavail * filesystem.bsize / 1024 / MB) : null,
      diskTotalGb: filesystem ? Math.round(filesystem.blocks * filesystem.bsize / 1024 / MB) : null,
      hostIp,
      kvm: Boolean(info?.kvm),
      nvidiaGpuAvailable: Boolean(info?.nvidiaRuntime),
      driGpuAvailable: Boolean(info?.driGpu),
      gpuCapabilities: [...(info?.nvidiaRuntime === true ? ['cuda'] : []), ...(info?.driGpu === true ? ['gpu'] : [])],
    };
  }
}
