import { diagnostic } from './diagnostics.mjs';
import { CONTRACT_ADB_OPTIONS } from './docker.mjs';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { redactDiagnostic } from './session-diagnostics.mjs';

export const IMAGE_CHECK_VERSION = 1;
export class ImageCheckDeferred extends Error { constructor() { super('Image check yielded to a user session'); this.code = 'image_check_deferred'; } }
const missing = error => /No such container|not found|404/i.test(String(error?.message));
const label = 'remote-device-farm.image-check';

export function imageCheckResult(output) {
  const line = String(output).split(/\r?\n/).findLast(line => line.startsWith('RDF_VALIDATION '));
  let result;
  try { result = line && JSON.parse(line.slice('RDF_VALIDATION '.length)); } catch { /* Fail closed below. */ }
  if (result?.version !== IMAGE_CHECK_VERSION || ['bootCompleted', 'adbSecure', 'unauthorizedAdb', 'rendererVerified', 'deviceVerified', 'resourcesVerified'].some(key => result[key] !== true)) {
    const errors = String(output).split(/\r?\n/).filter(line => /image.validation:|ADB authentication gate:|rdf-emulator:.*(?:exited|missing|must)/.test(line));
    const error = new Error(diagnostic('emulator-image-validation.6a15ada84f', { p0: redactDiagnostic(errors.slice(-5).join(' | ') || 'no complete validation result').slice(0, 1500) }));
    error.code = 'image_invalid'; throw error;
  }
  return result;
}

export class EmulatorImageValidator {
  constructor({ docker, agentId, nvidiaXorgModuleDir = null, driDevice = null, timeoutMs = 11 * 60_000 }) {
    Object.assign(this, { docker, agentId, nvidiaXorgModuleDir, driDevice, timeoutMs });
  }

  async cleanup(id, identity) {
    let details;
    try { details = await this.docker.inspect(id); } catch (error) { if (missing(error)) return; throw error; }
    const labels = details.Config?.Labels || {};
    if (labels[label] !== identity || labels['remote-device-farm.agent'] !== this.agentId || labels['remote-device-farm.role'] !== 'image-validation') {
      throw new Error(diagnostic('emulator-image-validation.d75125277b'));
    }
    const immutableId = details.Id;
    try { await this.docker.request('DELETE', `/containers/${immutableId}?force=1&v=1`, undefined, { timeoutMs: 90_000 }); }
    catch (error) {
      if (missing(error)) return;
      if (!/timeout|already.*(?:remov|progress)/i.test(error.message)) throw error;
      const deadline = Date.now() + 90_000;
      while (Date.now() < deadline) {
        try { await this.docker.inspect(immutableId); } catch (error) { if (missing(error)) return; throw error; }
        await delay(250);
      }
      throw new Error(diagnostic('emulator-image-validation.a05e82a682'));
    }
    try { await this.docker.inspect(immutableId); } catch (error) { if (missing(error)) return; throw error; }
    throw new Error(diagnostic('emulator-image-validation.1400d9df7b'));
  }

  async cleanupNetwork(id, identity) {
    let network;
    try { network = await this.docker.request('GET', '/networks/' + encodeURIComponent(id)); }
    catch(error) { if(missing(error))return; throw error; }
    if(network.Labels?.[label]!==identity || network.Labels?.['remote-device-farm.agent']!==this.agentId || network.Labels?.['remote-device-farm.role']!=='image-validation')throw new Error(diagnostic('emulator-image-validation.70de94c15e'));
    if(Object.keys(network.Containers??{}).length)throw new Error(diagnostic('emulator-image-validation.40c9870008'));
    await this.docker.request('DELETE','/networks/'+network.Id);
  }

  async recover() {
    const containers = await this.docker.listManaged(this.agentId);
    for (const item of containers) {
      if (item.Labels?.['remote-device-farm.role'] === 'image-validation' && /^[0-9a-f-]{36}$/.test(item.Labels[label] || '')) {
        await this.cleanup(item.Id, item.Labels[label]);
      }
    }
    const filters = encodeURIComponent(JSON.stringify({label:['remote-device-farm.agent='+this.agentId,'remote-device-farm.role=image-validation']}));
    for(const network of await this.docker.request('GET','/networks?filters='+filters)) {
      if(/^[0-9a-f-]{36}$/.test(network.Labels?.[label]??''))await this.cleanupNetwork(network.Id,network.Labels[label]);
    }
  }

  async run(image, { entry, profile, mode = 'off', signal, onLine = () => {} } = {}) {
    signal?.throwIfAborted();
    const metadata = await this.docker.request('GET', `/images/${encodeURIComponent(image)}/json`, undefined, { signal });
    if (metadata.Config?.Labels?.['remote-device-farm.contract'] !== 'emulator-v1' || metadata.Config?.Labels?.['remote-device-farm.system-image'] !== entry.package) {
      const error = new Error(diagnostic('emulator-image-validation.9fc045ace8')); error.code='image_invalid'; throw error;
    }
    const identity = randomUUID(), name = 'rdf-image-check-' + identity, networkName = name + '-net';
    const script = await readFile(new URL('./verify-emulator-image.sh', import.meta.url), 'utf8');
    const small = entry.device === 'wear' || entry.api <= 25;
    const resources=profile?.resources;
    const memoryMb=resources?.memoryMb ?? (small?4096:6144);
    const screen=profile?.android?.resolution;
    const device=entry.device==='phone' && screen && Math.min(...screen.split('x').map(Number))>=1200 ? 'tablet' : entry.device;
    const body = {
      Image: metadata.Id, Entrypoint: ['/bin/bash'], Cmd: ['-c', script], Tty: true,
      Env: [`RDF_EXTRA_ARGS=${CONTRACT_ADB_OPTIONS}`, `RDF_DEVICE=${device}`, `RDF_GPU=${mode}`, `RDF_RAM_MB=${resources?.guestMemoryMb??(small?2048:4096)}`, `RDF_CORES=${resources?.guestCores??(small?2:4)}`, `RDF_DATA_MB=${(resources?.diskGb??8)*1024}`, 'NVIDIA_VISIBLE_DEVICES=' + (mode === 'nvidia' ? 'all' : 'void')],
      Labels: { 'remote-device-farm.managed': 'true', 'remote-device-farm.agent': this.agentId, 'remote-device-farm.role': 'image-validation', [label]: identity },
      HostConfig: { NetworkMode: networkName, Devices: [{ PathOnHost: '/dev/kvm', PathInContainer: '/dev/kvm', CgroupPermissions: 'rwm' }],
        Memory: memoryMb * 1048576, MemorySwap: memoryMb * 1048576, NanoCpus: (resources?.cpu??4)*1e9,
        ShmSize: 256 * 1048576, PidsLimit: 2048, CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges:true'], AutoRemove: false },
    };
    if(screen)body.Env.push('RDF_SCREEN='+screen);
    if (mode === 'nvidia') {
      body.HostConfig.Runtime = 'nvidia';
      body.HostConfig.DeviceRequests = [{ Driver: 'nvidia', Count: 1, Capabilities: [['gpu']] }];
      body.Env.push('NVIDIA_DRIVER_CAPABILITIES=compute,utility,graphics,display,video');
      if (this.nvidiaXorgModuleDir) body.HostConfig.Binds = [this.nvidiaXorgModuleDir + ':/opt/nvidia-xorg:ro'];
    } else if (mode === 'dri') {
      if (!this.driDevice) throw new Error(diagnostic('emulator-image-validation.9f84211fea'));
      body.HostConfig.Devices.push({ PathOnHost: this.driDevice, PathInContainer: this.driDevice, CgroupPermissions: 'rwm' });
    }
    let id, networkId;
    try {
      const network = await this.docker.request('POST','/networks/create',{Name:networkName,Driver:'bridge',Internal:true,EnableIPv6:false,Labels:body.Labels},{signal});
      networkId=network.Id;
      const created = await this.docker.request('POST', '/containers/create?name=' + name, body, { signal });
      id = created.Id;
      onLine('Checking Android boot, ADB authentication and renderer: '+device+' / '+mode);
      await this.docker.request('POST', `/containers/${id}/start`, undefined, { signal });
      const waited = await this.docker.request('POST', `/containers/${id}/wait`, undefined, { timeoutMs: this.timeoutMs, signal });
      const bytes = await this.docker.request('GET', `/containers/${id}/logs?stdout=1&stderr=1`, undefined, { raw: true, maxBytes: 512 * 1024, signal });
      const output = Buffer.isBuffer(bytes) ? bytes.toString('utf8') : String(bytes);
      if(waited?.StatusCode!==0)for(const line of output.split(/\r?\n/).filter(Boolean).slice(-100))onLine(redactDiagnostic(line).slice(0,300));
      if (waited?.StatusCode !== 0) imageCheckResult(output); // Preserve the concrete failure, never accept a marker from an exited checker.
      if (waited?.StatusCode !== 0) throw new Error(diagnostic('emulator-image-validation.b5fac0a247', { p0: waited?.StatusCode }));
      const result = imageCheckResult(output);
      return { ...result, imageId: metadata.Id, device, mode, checkedAt: new Date().toISOString() };
    } finally {
      try {
        await this.cleanup(id??name,identity);
        await this.cleanupNetwork(networkId??networkName,identity);
      } catch(error) { error.code='image_check_cleanup'; throw error; }
    }
  }
}
