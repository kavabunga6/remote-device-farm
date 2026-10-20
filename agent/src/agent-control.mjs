import { ImageCache } from './image-cache.mjs';
import { agentMessage } from './messages.mjs';
import { runKeyed } from './keyed-queue.mjs';
import os from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { EmulatorImageValidator, ImageCheckDeferred, IMAGE_CHECK_VERSION } from './emulator-image-validation.mjs';
import { access, readFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { DockerClient, sessionNetworks } from './docker.mjs';
import { farmRegistryPrefix, validateDriDevice, validateNvidiaXorgModuleDir, validateProfile, validateImage, validateRegistryAuth } from './config.mjs';
import { EmulatorImages } from './emulator-images.mjs';
import { BoundedImageBuilder } from './bounded-image-builder.mjs';
import { resolveGpuBackend } from './docker-options.mjs';
import { probeGpuReadiness } from './gpu-readiness.mjs';
import { SlotReservations } from './capacity.mjs';
import { progressReporter } from './startup-progress.mjs';
import { MAX_NODE_SLOTS, assertProfileWithinPolicy, validateNodePolicy } from './node-policy.mjs';

const MB = 1024 * 1024;
const validId = (value) => typeof value === 'string' && /^[a-zA-Z0-9-]{8,64}$/.test(value);
const isMissing = (error) => /No such container|not found|404/i.test(String(error?.message));

export function loadControlConfig(env = process.env) {
  const agentId = env.AGENT_ID;
  if (typeof agentId !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(agentId)) throw new Error('Invalid AGENT_ID');
  const slots = Number(env.AGENT_SLOTS ?? Math.max(1, Math.floor(os.cpus().length / 2)));
  if (!Number.isInteger(slots) || slots < 1 || slots > 128) throw new Error('AGENT_SLOTS must be 1–128');
  const ioContainerOverride = env.AGENT_IO_CONTAINER_ID || null;
  if (ioContainerOverride && !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(ioContainerOverride)) {
    throw new Error('Invalid AGENT_IO_CONTAINER_ID');
  }
  return {
    agentId, slots, ioContainerOverride,
    selfContainerId: os.hostname(),
    dockerSocket: env.DOCKER_SOCKET || '/var/run/docker.sock',
    imageBuildStateDir: env.AGENT_IMAGE_BUILD_STATE_DIR || '/var/lib/rdf-image-builds',
    imageBuildDiskPath: env.AGENT_IMAGE_BUILD_DISK_PATH || '/',
    allowedPrefixes: (env.AGENT_ALLOWED_IMAGE_PREFIXES || '').split(',').map((x) => x.trim()).filter(Boolean),
    trustedPrefixes: [farmRegistryPrefix(env.AGENT_BROKER_URL)].filter(Boolean),
    nvidiaXorgModuleDir: validateNvidiaXorgModuleDir(env.AGENT_NVIDIA_XORG_MODULE_DIR),
    driDevice: validateDriDevice(env.AGENT_DRI_DEVICE),
  };
}

export class AgentControl {
  constructor(config, docker = new DockerClient(config.dockerSocket)) {
    this.config = config;
    this.docker = docker;
    this.reservations = new SlotReservations();
    this.cache = new ImageCache(docker, config.imageBuildStateDir);
    this.cacheCleanup = false;
    this.cachePulls = 0;
    this.policy = { revision: 0, slots: Math.min(config.slots, MAX_NODE_SLOTS), slotCpu: 16, slotMemoryMb: 65536 };
    this.startQueue = Promise.resolve();
    this.prewarmQueue = Promise.resolve();
    this.sessionLocks = new Map();
    this.preparing = new Map();
    this.imageValidator = new EmulatorImageValidator({ docker, agentId: config.agentId, nvidiaXorgModuleDir: config.nvidiaXorgModuleDir, driDevice: config.driDevice });
    this.imageCheckFlight = null; this.imageCheckController = null;
    this.images = new EmulatorImages({ docker: this.docker, stateDir: config.imageBuildStateDir, builder: new BoundedImageBuilder({ docker, agentId: config.agentId, stateDir: config.imageBuildStateDir, diskPath: config.imageBuildDiskPath }), verify: (image, options) => this.verifyArtifact(image, options) });
  }

  async recoverImageChecks() { await this.images.builder.recover(); await this.imageValidator.recover(); }

  /** Validation yields to actual user sessions, and never overlaps a occupied node. */
  async verifyArtifact(image, { entry, profiles = [], signal, onLine }) {
    while (true) {
      signal?.throwIfAborted();
      const host = await this.hostInfo();
      if (!host.kvm) throw new Error('Image runtime validation needs a builder with /dev/kvm');
      const capacity = await this.capacity();
      const requiredMb = Math.max(entry.device === 'wear' ? 6144 : 8192,...profiles.map(profile=>Number(profile.resources?.memoryMb||0)+2048));
      if (this.preparing.size || capacity.occupied.length || capacity.host.memoryAvailableMb < requiredMb) {
        onLine('Waiting for an idle builder and enough available memory; user sessions take priority');
        await delay(5000, undefined, { signal }); continue;
      }
      const controller = new AbortController();
      const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
      // Share admission serialization with session starts. Return the test promise
      // in a wrapper so the queue protects admission, without blocking a user for
      // the entire Android boot. A new start aborts the test and waits for cleanup.
      const admitted = this.startQueue.catch(() => {}).then(() => {
        if (this.preparing.size) throw new ImageCheckDeferred();
        this.imageCheckController = controller;
        const flight = (async () => {
          const checkedProfiles = [];
          for(const profile of profiles.length ? profiles : [undefined]) {
            checkedProfiles.push(await this.imageValidator.run(checkedProfiles[0]?.imageId??image,{entry,profile,signal:combined,onLine}));
          }
          const checks = {off:checkedProfiles[0]};
          if(host.nvidiaRuntime)checks.nvidia=await this.imageValidator.run(checks.off.imageId,{entry,profile:profiles[0],mode:'nvidia',signal:combined,onLine});
          if(host.driGpu)checks.dri=await this.imageValidator.run(checks.off.imageId,{entry,profile:profiles[0],mode:'dri',signal:combined,onLine});
          return {version:IMAGE_CHECK_VERSION,builderHostId:this.config.agentId,imageId:checks.off.imageId,checks,profiles:checkedProfiles};
        })();
        this.imageCheckFlight = flight;
        return { flight };
      });
      this.startQueue = admitted.catch(() => {});
      try { return await (await admitted).flight; }
      catch (error) {
        if (error.code === 'image_check_cleanup') { this.imageCheckCleanupError=error; throw error; }
        signal?.throwIfAborted();
        if (!(error instanceof ImageCheckDeferred) && !(controller.signal.aborted && controller.signal.reason instanceof ImageCheckDeferred)) throw error;
        onLine('Image check paused for a user session; it will resume when the builder is free');
      } finally {
        if (this.imageCheckController === controller) { this.imageCheckController = null; this.imageCheckFlight = null; }
      }
    }
  }

  withSessionLock(sessionId, work) {
    return runKeyed(this.sessionLocks, sessionId, work);
  }

  async handle(request, { onProgress, onLog, signal } = {}) {
    switch (request.op) {
      case 'hostInfo': return this.hostInfo();
      case 'recover': return this.recover(onLog);
      case 'inventory': return this.inventory();
      case 'start': {
        if (this.preparing.has(request.sessionId)) throw new Error('Session startup is already pending');
        const controller = new AbortController();
        const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
        this.preparing.set(request.sessionId, controller);
        this.imageCheckController?.abort(new ImageCheckDeferred());
        try { return await this.withSessionLock(request.sessionId, () =>
          this.serialStart(request.sessionId, request.profile, request.adbPublicKey, onProgress, { signal: combined, onLog })); }
        finally { this.preparing.delete(request.sessionId); }
      }
      case 'stop':
        this.preparing.get(request.sessionId)?.abort(new Error('Session startup cancelled'));
        return this.withSessionLock(request.sessionId, () => this.stop(request.sessionId, onLog));
      case 'diagnostics': return this.withSessionLock(request.sessionId, async () => {
        for (const container of await this.sessionContainers(request.sessionId))
          await this.docker.captureDiagnostics(container.Id, request.sessionId, this.config.agentId, onLog);
        return { captured: true };
      });
      case 'setEgress': return this.withSessionLock(request.sessionId, () => this.setEgress(request.sessionId, request.enabled));
      case 'cameraImage': return this.withSessionLock(request.sessionId, () => this.cameraImage(request.sessionId, request.params));
      case 'emuConsole': return this.emuConsole(request.sessionId, request.args);
      case 'setPolicy': return this.serialPolicy(request.policy);
      case 'emulatorCatalog': return this.images.catalog({ refresh: request.refresh });
      case 'emulatorBuild':
        if (this.cacheCleanup) throw new Error('image_cache_busy');
        return this.images.enqueue(request.packages, request.target);
      case 'emulatorCancel': return this.images.cancel(request.jobId);
      case 'prewarmImage': return this.prewarmImage(request.image, request.auth, { signal });
      case 'emulatorJobs': return this.images.acknowledge(request.acknowledged);
      case 'imageCache': return this.cache.list(request.protectedRefs, signal);
      case 'imageCacheRemove': return this.removeCachedImages(request.ids, request.protectedRefs, signal);
      default: throw new Error('Invalid control operation');
    }
  }

  async removeCachedImages(ids, protectedRefs, signal) {
    if (this.cacheCleanup || this.preparing.size || this.cachePulls || this.imageCheckFlight
      || this.images.jobList().some(job => ['queued', 'building', 'validating', 'pushing', 'cancelling'].includes(job.state))) {
      throw new Error('image_cache_busy');
    }
    const deadline = AbortSignal.timeout(50000);
    const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
    combined.throwIfAborted();
    const owner = {};
    this.cacheCleanup = owner;
    let abort;
    const cancelled = new Promise((_, reject) => {
      abort = () => reject(combined.reason);
      combined.addEventListener('abort', abort, { once: true });
    });
    const work = this.startQueue.catch(() => {}).then(() => {
      combined.throwIfAborted();
      return this.cache.remove(ids, protectedRefs, combined);
    });
    this.startQueue = work.catch(() => {});
    try { return await Promise.race([work, cancelled]); }
    finally {
      combined.removeEventListener('abort', abort);
      if (this.cacheCleanup === owner) this.cacheCleanup = false;
    }
  }

  async prewarmImage(image, auth, { signal } = {}) {
    if (this.cacheCleanup) throw new Error('image_cache_busy');
    const checked = validateImage(image, this.config.allowedPrefixes, this.config.trustedPrefixes ?? []);
    if (!/@sha256:[0-9a-f]{64}$/.test(checked)) throw new Error('Image prewarm requires a pinned digest');
    const credentials = validateRegistryAuth(auth);
    const deadline = AbortSignal.timeout(30 * 60_000);
    const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
    this.cachePulls++;
    const work = this.prewarmQueue.catch(() => {}).then(async () => {
      combined.throwIfAborted();
      await this.docker.ensureImage(checked, () => {}, { signal: combined, auth: credentials });
      await this.cache.touch(checked);
      combined.throwIfAborted();
      return { image: checked, ready: true };
    });
    this.prewarmQueue = work.catch(() => {});
    return work.finally(() => { this.cachePulls--; });
  }

  async ioContainerId() {
    if (this.config.ioContainerOverride) return this.config.ioContainerOverride;
    const self = await this.docker.inspect(this.config.selfContainerId);
    const labels = self.Config?.Labels || {};
    const project = labels['com.docker.compose.project'];
    if (labels['com.docker.compose.service'] !== 'agent-control' || !project) {
      throw new Error('Cannot identify the agent I/O container from Compose labels');
    }
    const filters = encodeURIComponent(JSON.stringify({ label: [
      'com.docker.compose.project=' + project,
      'com.docker.compose.service=agent',
    ] }));
    const matches = await this.docker.request('GET', '/containers/json?filters=' + filters);
    if (matches.length !== 1 || matches[0].State !== 'running') throw new Error('Expected one running agent I/O container');
    return matches[0].Id;
  }

  async hostInfo() {
    const info = await this.docker.request('GET', '/info');
    const kvm = await access('/dev/kvm', fsConstants.R_OK | fsConstants.W_OK).then(() => true, () => false);
    return {
      cpuThreads: Number.isSafeInteger(info?.NCPU) ? info.NCPU : null,
      memoryTotalBytes: Number.isSafeInteger(info?.MemTotal) ? info.MemTotal : null,
      ...await probeGpuReadiness(info, this.config.driDevice),
      kvm,
    };
  }

  async inventory() {
    const containers = await this.docker.listManaged(this.config.agentId);
    return containers.filter((item) => validId(item.Labels?.['remote-device-farm.session']))
      .map((item) => ({
        sessionId: item.Labels['remote-device-farm.session'],
        containerId: item.Id,
        running: item.State === 'running',
      }));
  }

  entry(sessionId, container, detail, cleanupPending = false) {
    const networks = sessionNetworks(sessionId);
    const name = 'rdf-' + sessionId;
    return {
      sessionId, containerId: container.Id, name, serial: name + ':5555',
      cpu: Math.ceil((detail?.HostConfig?.NanoCpus || 0) / 1_000_000_000) || 1,
      memoryMb: Math.ceil((detail?.HostConfig?.Memory || 0) / MB) || 1024,
      networkEnabled: Boolean(detail?.NetworkSettings?.Networks?.[networks.egress]),
      cleanupPending,
    };
  }

  async recover(onLog) {
    const ioContainerId = await this.ioContainerId();
    const existing = await this.docker.listManaged(this.config.agentId);
    const recovered = [];
    const cleanup = async (sessionId, container, reason) => {
      console.warn('Removing unsafe or stopped emulator ' + sessionId + ': ' + reason);
      try {
        const emit = event => onLog?.({ ...event, sessionId });
        await emit({ code: 'session.recovery_cleanup', message: 'Восстановление агента: ' + reason, severity: 'warning', service: 'agent' });
        await this.docker.captureDiagnostics?.(container.Id, sessionId, this.config.agentId, emit);
        await this.docker.removeManaged(container.Id, sessionId, this.config.agentId);
        await this.docker.removeSessionNetworks(sessionId, this.config.agentId, ioContainerId);
        await onLog?.({ sessionId, code: 'session.recovery_cleanup_complete', message: 'Очистка после восстановления завершена', severity: 'info', service: 'agent' });
      } catch (error) {
        console.warn('Cleanup pending for emulator ' + sessionId + ': ' + error.message);
        recovered.push({ sessionId, containerId: container.Id, name: 'rdf-' + sessionId,
          cpu: 0, memoryMb: 0, networkEnabled: false, cleanupPending: true });
      }
    };
    for (const container of existing) {
      const sessionId = container.Labels?.['remote-device-farm.session'];
      if (!validId(sessionId)) continue;
      if (container.State !== 'running') {
        await cleanup(sessionId, container, 'container is not running');
        continue;
      }
      const detail = await this.docker.inspect(container.Id);
      const networks = sessionNetworks(sessionId);
      const attachments = Object.keys(detail.NetworkSettings?.Networks || {});
      if (!detail.NetworkSettings?.Networks?.[networks.management] ||
          attachments.some((network) => network !== networks.management && network !== networks.egress)) {
        await cleanup(sessionId, container, 'unexpected Docker network attachments');
        continue;
      }
      try {
        await this.docker.ensureNetwork(networks.management, sessionId, this.config.agentId, 'management');
        if (detail.NetworkSettings?.Networks?.[networks.egress]) {
          await this.docker.ensureNetwork(networks.egress, sessionId, this.config.agentId, 'egress');
        }
        await this.docker.connectAgentToManagement(networks.management, ioContainerId);
      } catch (error) {
        if (/Refusing to use unrelated Docker network|unsafe settings/.test(error.message)) {
          await cleanup(sessionId, container, error.message);
          continue;
        }
        // A transient Docker API failure must not destroy a running emulator.
        throw error;
      }
      recovered.push(this.entry(sessionId, container, detail));
    }
    const networks = await this.docker.listManagedNetworks(this.config.agentId);
    const orphans = new Set(networks.map((item) => item.Labels?.['remote-device-farm.session'])
      .filter((sessionId) => validId(sessionId) && !recovered.some((entry) => entry.sessionId === sessionId)));
    for (const sessionId of orphans) {
      try { await this.docker.removeSessionNetworks(sessionId, this.config.agentId, ioContainerId); }
      catch (error) {
        console.warn('Cleanup pending for emulator ' + sessionId + ': ' + error.message);
        recovered.push({ sessionId, containerId: 'rdf-' + sessionId, name: 'rdf-' + sessionId,
          cpu: 0, memoryMb: 0, networkEnabled: false, cleanupPending: true });
      }
    }
    return recovered;
  }

  async sessionContainers(sessionId) {
    const containers = await this.docker.listManaged(this.config.agentId);
    return containers.filter((item) => item.Labels?.['remote-device-farm.session'] === sessionId);
  }

  async capacity() {
    const [info, memInfo, containers] = await Promise.all([
      this.docker.request('GET', '/info'),
      readFile('/proc/meminfo', 'utf8').catch(() => ''),
      this.docker.listManaged(this.config.agentId),
    ]);
    const running = await Promise.all(containers.filter((item) => item.State === 'running').map((item) => this.docker.inspect(item.Id)));
    const used = running.map((detail) => ({
      cpu: Math.ceil((detail.HostConfig?.NanoCpus || 0) / 1_000_000_000) || 1,
      memoryMb: Math.ceil((detail.HostConfig?.Memory || 0) / MB) || 1024,
    }));
    const availableKb = Number(memInfo.match(/^MemAvailable:\s+(\d+)\s+kB/m)?.[1]);
    const totalMb = Math.floor((info?.MemTotal || os.totalmem()) / MB);
    return {
      occupied: used,
      host: {
        slots: this.policy.slots,
        cpuCores: info?.NCPU || os.cpus().length,
        memoryTotalMb: totalMb,
        memoryAvailableMb: availableKb > 0 ? Math.floor(availableKb / 1024) : Math.floor(os.freemem() / MB),
      },
    };
  }

  serialPolicy(input) {
    const policy = validateNodePolicy(input);
    const current = this.startQueue.catch(() => {}).then(() => {
      this.policy = policy;
      return policy;
    });
    this.startQueue = current.catch(() => {});
    return current;
  }

  serialStart(sessionId, profile, adbPublicKey, onProgress = () => {}, options = {}) {
    onProgress({ stage: 'waiting_image' });
    const work = () => { options.signal?.throwIfAborted(); return this.start(sessionId, profile, adbPublicKey, onProgress, options); };
    const current = this.startQueue.catch(() => {}).then(work);
    this.startQueue = current.catch(() => {});
    return current;
  }

  async start(sessionId, profileInput, adbPublicKey, onProgress, { signal, onLog } = {}) {
    signal?.throwIfAborted();
    const report = progressReporter(onProgress);
    const profile = validateProfile(profileInput, this.config.allowedPrefixes, this.config.trustedPrefixes ?? []);
    assertProfileWithinPolicy(profile, this.policy);
    onLog?.({ code: 'session.profile_validated', message: 'Профиль и лимиты узла проверены', severity: 'info', service: 'agent' });
    const existing = await this.sessionContainers(sessionId);
    if (existing.length) {
      if (existing.length !== 1 || existing[0].State !== 'running') throw new Error('Previous session cleanup is pending');
      const detail = await this.docker.inspect(existing[0].Id);
      const networks = sessionNetworks(sessionId);
      const attachments = Object.keys(detail.NetworkSettings?.Networks || {});
      if (!detail.NetworkSettings?.Networks?.[networks.management] ||
          attachments.some((network) => network !== networks.management && network !== networks.egress)) {
        throw new Error('Existing emulator has unsafe Docker network attachments');
      }
      await this.docker.ensureNetwork(networks.management, sessionId, this.config.agentId, 'management');
      if (detail.NetworkSettings.Networks[networks.egress]) {
        await this.docker.ensureNetwork(networks.egress, sessionId, this.config.agentId, 'egress');
      }
      await this.docker.connectAgentToManagement(networks.management, await this.ioContainerId());
      return { containerId: existing[0].Id, name: 'rdf-' + sessionId,
        networkEnabled: Boolean(detail.NetworkSettings.Networks[networks.egress]) };
    }
    if (this.imageCheckFlight) await this.imageCheckFlight.catch(error => { if(error.code === 'image_check_cleanup') throw error; });
    signal?.throwIfAborted();
    if(this.imageCheckCleanupError) { await this.recoverImageChecks();this.imageCheckCleanupError=null; }
    const capacity = await this.capacity();
    const hostInfo = await this.hostInfo();
    if (!hostInfo.kvm) throw new Error('/dev/kvm is not available to agent control');
    profile.gpuBackend = resolveGpuBackend(profile, hostInfo);
    onLog?.({ code: 'session.gpu_checked', message: 'KVM доступен; GPU backend: ' + (profile.gpuBackend || 'software'), severity: 'info', service: 'agent' });
    return this.reservations.run(sessionId, () => capacity.occupied, capacity.host, profile, async () => {
      await this.docker.ensureImage(profile.image, report, { signal, auth: profile.registryAuth ?? null });
      await this.cache.touch(profile.image);
      signal?.throwIfAborted();
      report({ stage: 'creating' });
      const created = await this.docker.createEmulator({
        sessionId, agentId: this.config.agentId, selfContainerId: await this.ioContainerId(),
        profile, adbPublicKey, nvidiaXorgModuleDir: this.config.nvidiaXorgModuleDir, driDevice: this.config.driDevice, onLog,
      });
      if (signal?.aborted) {
        await this.stop(sessionId, onLog);
        signal.throwIfAborted();
      }
      return { ...created, networkEnabled: true };
    });
  }

  async stop(sessionId, onLog) {
    const containers = await this.sessionContainers(sessionId);
    for (const container of containers) {
      await this.docker.captureDiagnostics?.(container.Id, sessionId, this.config.agentId, onLog);
      onLog?.({ code: 'session.container_removing', message: 'Удаление контейнера ' + container.Id + ' и его томов', severity: 'info', service: 'agent' });
      await this.docker.removeManaged(container.Id, sessionId, this.config.agentId);
    }
    onLog?.({ code: 'session.networks_removing', message: 'Удаление сетей сессии', severity: 'info', service: 'agent' });
    await this.docker.removeSessionNetworks(sessionId, this.config.agentId, await this.ioContainerId());
    onLog?.({ code: 'session.cleanup_complete', message: 'Контейнер, тома и сети удалены', severity: 'info', service: 'agent' });
    return { stopped: true };
  }

  async setEgress(sessionId, enabled) {
    const containers = await this.sessionContainers(sessionId);
    if (containers.length !== 1 || containers[0].State !== 'running') throw new Error('Session is not running on this agent');
    return this.docker.setEgress(containers[0].Id, sessionId, this.config.agentId, enabled);
  }

  async cameraImage(sessionId, params) {
    const containers = await this.sessionContainers(sessionId);
    if (containers.length !== 1 || containers[0].State !== 'running') throw new Error(agentMessage('agent.a14b4d584e08'));
    return this.docker.cameraImage(containers[0].Id, sessionId, this.config.agentId, params);
  }

  async emuConsole(sessionId, args) {
    const containers = await this.sessionContainers(sessionId);
    if (containers.length !== 1 || containers[0].State !== 'running') throw new Error('Session is not running on this agent');
    return this.docker.emuConsole(containers[0].Id, sessionId, this.config.agentId, args);
  }
}
