import { diagnosticReporter, diagnosticSecrets, diagnosticSeverity, dockerLogLines } from './session-diagnostics.mjs';
import { DEFAULT_NVIDIA_CAPABILITIES, FARM_FLAGS, gpuKind } from './docker-options.mjs';

// Farm-built images (deploy/emulator) declare this label and read only RDF_* variables; the farm needs no
// per-image flags, variable names or entrypoint tricks for them.
/** Docker's X-Registry-Auth header for one pull or push; the credentials are never stored by the agent. */
export function registryAuthHeader(auth) {
  if (!auth) return {};
  return { 'X-Registry-Auth': Buffer.from(JSON.stringify({ username: auth.username, password: auth.password, serveraddress: auth.serveraddress })).toString('base64url') };
}

export const EMULATOR_CONTRACT = 'emulator-v1';
// The I/O agent owns ADB. The SDK's headless helper would otherwise create a
// different private key and request trust on Android's screen. Keep it off
// through the emulator's standard option; no farm private key enters a guest.
export const CONTRACT_ADB_OPTIONS = '-adb-path /bin/false';
const CONTRACT_DEVICES = { tv: 'tv', automotive: 'automotive', wear: 'wear', desktop: 'desktop' };

/** RDF_* environment of a contract image (deploy/emulator/rdf-emulator.sh documents each variable). */
export function contractEnv(profile, adbPublicKey, gpu) {
  const [width, height] = /^\d+x\d+$/.test(profile.resolution ?? '') ? profile.resolution.split('x').map(Number) : [];
  const device = CONTRACT_DEVICES[profile.deviceType] ?? (width && Math.min(width, height) >= 1200 ? 'tablet' : 'phone');
  const sdCardMb = profile.sdCardMb ?? 0;
  return [
    `ADBKEY_PUB=${adbPublicKey.trim()}`,
    `RDF_RAM_MB=${profile.guestMemoryMb ?? Math.max(1024, profile.memoryMb - 1024)}`,
    `RDF_CORES=${profile.guestCores ?? profile.cpu}`,
    `RDF_DATA_MB=${profile.diskGb * 1024}`,
    `RDF_SDCARD_MB=${sdCardMb}`,
    `RDF_DEVICE=${device}`,
    ...(width ? [`RDF_SCREEN=${width}x${height}`] : []),
    `RDF_GPU=${gpu}`,
    `RDF_EXTRA_ARGS=${[profile.emulatorParams, CONTRACT_ADB_OPTIONS].filter(Boolean).join(' ')}`,
  ];
}
import { createHash } from 'node:crypto';
import http from 'node:http';
import { Readable } from 'node:stream';
import { archiveFile } from './docker-archive.mjs';
import { applyCameraImage } from './camera-image.mjs';
import { validateNvidiaXorgModuleDir } from './config.mjs';
import { runEmuConsole, validateEmuConsoleArgs } from './emu-console.mjs';

const MIN_API_MINOR = 44;
const MAX_ERROR_RESPONSE_BYTES = 1024 * 1024;

// Only validated numeric size enters this script. The inherited entrypoint and command
// are passed as positional arguments, preserving GPU initialization and image startup.
export const SD_CARD_LAUNCH_SCRIPT = [
  'test -x /android/sdk/emulator/mksdcard || { echo "SD card creation requires mksdcard in the Google image" >&2; exit 1; }',
  '/android/sdk/emulator/mksdcard "${RDF_SD_CARD_MB}M" /android-home/rdf-sdcard.img',
  'unset RDF_SD_CARD_MB',
  'exec "$@"',
].join('\n');

export function sessionNetworks(sessionId) {
  return { management: `rdf-m-${sessionId}`, egress: `rdf-e-${sessionId}` };
}

// Egress bridges get a predictable name prefix so the host firewall can match them with `-i rdfe+`
// (see deploy/firewall). Linux limits interface names to 15 characters.
export function egressBridgeName(sessionId) {
  return 'rdfe' + createHash('sha256').update(String(sessionId)).digest('hex').slice(0, 11);
}

const SDCARD_PATH = '/android-home/rdf-sdcard.img';

export class DockerClient {
  constructor(socketPath) { this.socketPath = socketPath; this.apiPrefix = null; this.apiVersionPromise = null; }

  async request(method, path, body, options) {
    this.apiVersionPromise ??= this._request('GET', '/version').then((version) => {
      const match = /^1\.(\d+)$/.exec(String(version?.ApiVersion || ''));
      if (!match || Number(match[1]) < MIN_API_MINOR) {
        throw new Error('Docker Engine API 1.44 or newer is required');
      }
      this.apiPrefix = `/v${version.ApiVersion}`;
    });
    await this.apiVersionPromise;
    return this._request(method, this.apiPrefix + path, body, options);
  }

  // Like request() but returns the response body as a Buffer (needed for the binary exec stream).
  async requestRaw(method, path, body, options) {
    return this.request(method, path, body, { ...options, raw: true });
  }

  async _request(method, path, body, { maxBytes = 8 * 1024 * 1024, timeoutMs = 60000,
    raw = false, rawBody, contentType, onJsonEvent, signal, headers: extraHeaders = {} } = {}) {
    signal?.throwIfAborted();
    const payload = rawBody ?? (body === undefined ? undefined : Buffer.from(JSON.stringify(body)));
    return new Promise((resolve, reject) => {
      let timer, settled = false;
      const finish = (error, value) => {
        if (settled) return;
        settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
        if (error) { if (payload instanceof Readable) payload.destroy(); reject(error); } else resolve(value);
      };
      const req = http.request({ socketPath: this.socketPath, path, method,
        headers: { ...extraHeaders, ...(payload ? { 'Content-Type': contentType || 'application/json', ...(Buffer.isBuffer(payload) ? { 'Content-Length': payload.length } : {}) } : {}) },
      }, res => {
        const chunks = []; let size = 0, pending = Buffer.alloc(0);
        // Build/pull streams permit large cumulative output, but HTTP error bodies
        // are buffered for Docker's message and must remain small regardless.
        const responseLimit = res.statusCode >= 400 ? Math.min(maxBytes, MAX_ERROR_RESPONSE_BYTES) : maxBytes;
        const event = line => {
          if (!line.toString('utf8').trim()) return;
          if (line.length > 256 * 1024) throw new Error('Docker progress event exceeds limit');
          let value;
          try { value = JSON.parse(line.toString('utf8')); } catch { throw new Error('Invalid Docker progress JSON'); }
          if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Docker progress event');
          if (value.error || value.errorDetail?.message) throw new Error(String(value.errorDetail?.message || value.error).slice(0, 1024));
          onJsonEvent(value);
        };
        res.on('data', chunk => {
          size += chunk.length;
          if (size > responseLimit) return req.destroy(new Error(res.statusCode >= 400
            ? `Docker API HTTP ${res.statusCode} error response too large`
            : 'Docker API response too large'));
          if (!onJsonEvent || res.statusCode >= 400) { chunks.push(chunk); return; }
          try {
            pending = Buffer.concat([pending, chunk]);
            let newline;
            while ((newline = pending.indexOf(10)) >= 0) { event(pending.subarray(0, newline)); pending = pending.subarray(newline + 1); }
            if (pending.length > 256 * 1024) throw new Error('Docker progress event exceeds limit');
          } catch (error) { req.destroy(error); }
        });
        res.on('error', error => finish(error));
        res.on('aborted', () => finish(new Error('Docker API response aborted')));
        res.on('end', () => {
          if (onJsonEvent && res.statusCode < 400) {
            try { if (pending.length) event(pending); finish(null, null); } catch (error) { finish(error); }
            return;
          }
          if (raw && res.statusCode < 400) { finish(null, Buffer.concat(chunks)); return; }
          const text = Buffer.concat(chunks).toString('utf8'); let result = text;
          try { result = text ? JSON.parse(text) : null; } catch { /* Docker may return text. */ }
          if (res.statusCode >= 400) finish(new Error(result?.message || `Docker API HTTP ${res.statusCode}`));
          else finish(null, result);
        });
      });
      const abort = () => req.destroy(signal.reason instanceof Error ? signal.reason : new Error('Image preparation cancelled'));
      signal?.addEventListener('abort', abort, { once: true });
      req.on('error', error => finish(error));
      timer = setTimeout(() => req.destroy(new Error('Docker API request timed out')), timeoutMs);
      if (signal?.aborted) { abort(); return; }
      if (payload instanceof Readable) { payload.once('error', error => req.destroy(error)); payload.pipe(req); }
      else { if (payload) req.write(payload); req.end(); }
    });
  }

  /** Import one exported file with backpressure; multi-gigabyte image archives never enter a Buffer. */
  async importImageArchive(containerId, { signal } = {}) {
    await this.request('GET', '/version', undefined, { signal });
    const response = await new Promise((resolve, reject) => {
      const request = http.get({ socketPath: this.socketPath, path: `${this.apiPrefix}/containers/${encodeURIComponent(containerId)}/archive?path=/tmp/rdf-image.tar` }, resolve);
      const abort = () => request.destroy(signal?.reason instanceof Error ? signal.reason : new Error('build_cancelled'));
      signal?.addEventListener('abort', abort, { once: true });
      request.setTimeout(30_000, () => request.destroy(new Error('Docker API request timed out')));
      request.once('error', reject);
      request.once('close', () => signal?.removeEventListener('abort', abort));
      if (signal?.aborted) abort();
    });
    try {
      if (response.statusCode !== 200) throw new Error('build_archive_unavailable');
      const input = Readable.from(archiveFile(response, 'rdf-image.tar'));
      await this.request('POST', '/images/load?quiet=1', undefined, { rawBody: input, contentType: 'application/x-tar', timeoutMs: 30 * 60_000, signal, maxBytes: 4 * 1024 * 1024, onJsonEvent: () => {} });
    } finally { response.destroy(); }
  }

  async ensureImage(image, onProgress = () => {}, { signal, auth = null } = {}) {
    onProgress({ stage: 'checking_image' }); signal?.throwIfAborted();
    try { await this.request('GET', `/images/${encodeURIComponent(image)}/json`, undefined, { signal }); return; }
    catch (error) { if (!/No such image|404/.test(String(error.message))) throw error; }
    onProgress({ stage: 'downloading' });
    const layers = new Map();
    const emit = value => {
      if (value.error || value.errorDetail?.message) throw new Error(String(value.errorDetail?.message || value.error).slice(0, 1024));
      if (typeof value.id === 'string' && value.id.length < 256 && value.status === 'Downloading') {
        const current = value.progressDetail?.current, total = value.progressDetail?.total;
        if (Number.isSafeInteger(current) && current >= 0 && Number.isSafeInteger(total) && total > 0 && current <= total) {
          if (layers.size >= 4096 && !layers.has(value.id)) throw new Error('Too many image layers');
          layers.set(value.id, { current, total });
        }
      }
      if (['Download complete', 'Pull complete', 'Already exists'].includes(value.status) && layers.has(value.id)) {
        const layer = layers.get(value.id); layer.current = layer.total;
      }
      const counts = [...layers.values()];
      const currentBytes = counts.reduce((sum, layer) => sum + layer.current, 0);
      const totalBytes = counts.reduce((sum, layer) => sum + layer.total, 0);
      onProgress({ stage: 'downloading', ...(totalBytes ? { currentBytes, totalBytes, percent: Math.floor(currentBytes * 100 / totalBytes) } : {}),
        ...(typeof value.status === 'string' ? { detail: value.status.slice(0, 256) } : {}) });
    };
    const response = await this.request('POST', `/images/create?fromImage=${encodeURIComponent(image)}`, undefined,
      { maxBytes: 64 * 1024 * 1024, timeoutMs: 60 * 60_000, onJsonEvent: emit, signal, headers: registryAuthHeader(auth) });
    // Also handle injected transports and older non-streaming callers returning a single JSON error.
    if (response && typeof response === 'object') emit(response);
    else if (typeof response === 'string') for (const line of response.split('\n')) if (line.trim()) emit(JSON.parse(line));
    signal?.throwIfAborted();
    await this.request('GET', `/images/${encodeURIComponent(image)}/json`, undefined, { signal });
  }

  async hasNvidiaRuntime() {
    const info = await this.request('GET', '/info');
    return Boolean(info?.Runtimes?.nvidia);
  }

  async inspectNetwork(name) {
    return this.request('GET', `/networks/${encodeURIComponent(name)}`);
  }

  async ensureNetwork(name, sessionId, agentId, purpose) {
    let current;
    try { current = await this.inspectNetwork(name); }
    catch (error) {
      if (!/not found|404/i.test(String(error.message))) throw error;
    }
    if (!current) {
      try {
        await this.request('POST', '/networks/create', {
          Name: name,
          CheckDuplicate: true,
          Driver: 'bridge',
          Internal: purpose === 'management',
          EnableIPv6: false,
          Labels: {
            'remote-device-farm.managed': 'true',
            'remote-device-farm.agent': agentId,
            'remote-device-farm.session': sessionId,
            'remote-device-farm.purpose': purpose,
          },
          Options: purpose === 'management'
            ? { 'com.docker.network.bridge.gateway_mode_ipv4': 'isolated' }
            : { 'com.docker.network.bridge.name': egressBridgeName(sessionId) },
        });
      } catch (error) {
        // A concurrent retry may have created it. Inspection below still verifies ownership.
        current = await this.inspectNetwork(name).catch(() => { throw error; });
      }
      current ??= await this.inspectNetwork(name);
    }
    const labels = current.Labels || {};
    if (labels['remote-device-farm.managed'] !== 'true' ||
        labels['remote-device-farm.agent'] !== agentId ||
        labels['remote-device-farm.session'] !== sessionId ||
        labels['remote-device-farm.purpose'] !== purpose) {
      throw new Error(`Refusing to use unrelated Docker network ${name}`);
    }
    if (current.Driver !== 'bridge' || current.EnableIPv6 ||
        (purpose === 'management' &&
          (!current.Internal || current.Options?.['com.docker.network.bridge.gateway_mode_ipv4'] !== 'isolated')) ||
        (purpose === 'egress' && (current.Internal ||
          current.Options?.['com.docker.network.bridge.name'] !== egressBridgeName(sessionId)))) {
      throw new Error(`Docker ${purpose} network has unsafe settings; Docker Engine 28+ is required`);
    }
    return current;
  }

  async connectAgentToManagement(name, selfContainerId) {
    const self = await this.inspect(selfContainerId);
    if (self.NetworkSettings?.Networks?.[name]) return;
    await this.request('POST', `/networks/${encodeURIComponent(name)}/connect`, { Container: selfContainerId });
  }

  async ensureSessionNetworks(sessionId, agentId, selfContainerId) {
    const names = sessionNetworks(sessionId);
    await this.ensureNetwork(names.management, sessionId, agentId, 'management');
    await this.connectAgentToManagement(names.management, selfContainerId);
    await this.ensureNetwork(names.egress, sessionId, agentId, 'egress');
    return names;
  }

  async createEmulator({ sessionId, agentId, selfContainerId, profile, adbPublicKey,
    nvidiaXorgModuleDir = null, driDevice = null, onLog }) {
    const name = `rdf-${sessionId}`;
    let networks;
    const accelerated = profile.gpuMode === 'nvidia';
    const kind = gpuKind(profile);
    if (accelerated && !kind) throw new Error('GPU backend must be selected from the node capabilities');
    const xorgModuleSource = accelerated && kind === 'nvidia' ? validateNvidiaXorgModuleDir(nvidiaXorgModuleDir) : null;
    if (accelerated && kind === 'dri' && !driDevice) throw new Error('GPU mode requires AGENT_DRI_DEVICE');
    const options = profile.dockerOptions ?? {};
    // Flags the farm adds itself; an image that already passes some of them lists only the rest in farmFlags.
    const farm = new Set(options.farmFlags ?? FARM_FLAGS);
    // The image advertises its own switch through Config.Env. Leave its launcher intact;
    // generic images receive one renderer flag through their declared argument variable.
    const image = await this.request('GET', `/images/${encodeURIComponent(profile.image)}/json`);
    const imageEnvNames = new Set((image.Config?.Env ?? []).filter(value => typeof value === 'string' && value.includes('='))
      .map(value => value.slice(0, value.indexOf('='))));
    const imageControlsGpu = imageEnvNames.has('GPU_ACCELERATED');
    const contract = image.Config?.Labels?.['remote-device-farm.contract'] === EMULATOR_CONTRACT;
    // Some launchers read guest resources from environment variables instead of farm flags.
    // Only update declared keys and configured guest values; keep image defaults and the
    // profile's explicit farmFlags contract intact. Container limits are independent.
    const containerEnv = { ...profile.containerEnv };
    const launchEnvNames = new Set([options.adbKeyEnv ?? 'ADBKEY_PUB', options.emulatorParamsEnv ?? 'EMULATOR_PARAMS']);
    for (const [name, flag, value] of [['MEMORY', 'memory', profile.guestMemoryMb], ['CORES', 'cores', profile.guestCores]]) {
      if (value == null || contract) continue;
      const declared = !launchEnvNames.has(name) && (Object.hasOwn(containerEnv, name) || imageEnvNames.has(name));
      if (declared) containerEnv[name] = String(value);
      else if (!farm.has(flag)) throw new Error(`Guest ${flag} cannot be applied by this image profile; enable the ${flag} farm flag or declare ${name}`);
    }
    const diskMb = profile.diskGb * 1024;
    const sdCardMb = profile.sdCardMb ?? (profile.sdcardGb == null ? null : profile.sdcardGb * 1024);
    const paramsWithDisk = `${profile.emulatorParams} ${farm.has('partition-size') ? `-partition-size ${diskMb}` : ''}`.trim();
    const avdConfig = [`disk.dataPartition.size=${diskMb}M`];
    if (sdCardMb != null) {
      avdConfig.push(`hw.sdCard=${sdCardMb === 0 ? 'no' : 'yes'}`);
      if (sdCardMb > 0) avdConfig.push(`sdcard.size=${sdCardMb}M`, 'sdcard.path=/android-home/rdf-sdcard.img');
    }
    const guestParams = [
      profile.guestMemoryMb == null || !farm.has('memory') ? '' : `-memory ${profile.guestMemoryMb}`,
      profile.guestCores == null || !farm.has('cores') ? '' : `-cores ${profile.guestCores}`,
    ].filter(Boolean).join(' ');
    const launchParams = [paramsWithDisk, guestParams, sdCardMb > 0 && farm.has('sdcard') ? `-sdcard ${SDCARD_PATH}` : ''].filter(Boolean).join(' ');
    const gpuFlags = !imageControlsGpu && (accelerated || farm.has('gpu')) ? ['-gpu', accelerated ? 'host' : 'swiftshader_indirect'] : [];
    const params = [launchParams, ...gpuFlags].filter(Boolean).join(' ');
    const body = {
      Image: profile.image,
      // Farm-owned variables are reserved in container-env.mjs and cannot be overridden. Images that read the key and the
      // emulator arguments from differently named variables say so in the profile.
      Env: contract
        ? [...Object.entries(containerEnv).map(([name, value]) => `${name}=${value}`),
          ...contractEnv(profile, adbPublicKey, accelerated ? kind : 'off'),
          ...(accelerated && kind === 'nvidia' ? [`NVIDIA_DRIVER_CAPABILITIES=${DEFAULT_NVIDIA_CAPABILITIES.join(',')}`] : ['NVIDIA_VISIBLE_DEVICES=void'])]
        : [...Object.entries(containerEnv).map(([name, value]) => `${name}=${value}`),
        `${options.adbKeyEnv ?? 'ADBKEY_PUB'}=${adbPublicKey.trim()}`, `${options.emulatorParamsEnv ?? 'EMULATOR_PARAMS'}=${params}`, `AVD_CONFIG=${avdConfig.join('\n')}`,
        ...(accelerated && kind === 'nvidia' ? [`NVIDIA_DRIVER_CAPABILITIES=${DEFAULT_NVIDIA_CAPABILITIES.join(',')}`] : ['NVIDIA_VISIBLE_DEVICES=void']),
        ...(imageControlsGpu ? [`GPU_ACCELERATED=${accelerated ? 'true' : 'false'}`] : [])],
      Labels: {
        'remote-device-farm.managed': 'true',
        'remote-device-farm.agent': agentId,
        'remote-device-farm.session': sessionId,
      },
      ExposedPorts: { '5555/tcp': {}, '8554/tcp': {} },
      HostConfig: {
        Devices: [{ PathOnHost: '/dev/kvm', PathInContainer: '/dev/kvm', CgroupPermissions: 'rwm' }],
        NetworkMode: '',
        Memory: profile.memoryMb * 1024 * 1024,
        MemorySwap: profile.memoryMb * 1024 * 1024,
        NanoCpus: profile.cpu * 1_000_000_000,
        PidsLimit: 2048,
        CapDrop: ['ALL'],
        SecurityOpt: ['no-new-privileges:true'],
        AutoRemove: false,
        ...(options.shmSizeMb ? { ShmSize: options.shmSizeMb * 1024 * 1024 } : {}),
        ...(options.ulimits ? { Ulimits: options.ulimits.map((item) => ({ Name: item.name, Soft: item.soft, Hard: item.hard })) } : {}),
        Tmpfs: { ...Object.fromEntries((options.tmpfs ?? []).map((item) => [item.path, `rw,noexec,nosuid,size=${item.sizeMb}m`])), '/rdf-network': 'rw,noexec,nosuid,size=40m,mode=0700' },
        ...(options.sysctls ? { Sysctls: options.sysctls } : {}),
      },
      NetworkingConfig: { EndpointsConfig: {} },
    };
    if (!contract && options.entrypoint) body.Entrypoint = options.entrypoint;
    if (!contract && options.command) body.Cmd = options.command;
    if (!contract && sdCardMb > 0) await this.addSdcardEntrypoint(body, profile, sdCardMb);
    if (accelerated && kind === 'dri') {
      // Plain GPU: pass the render node through; no NVIDIA runtime, no X server module.
      body.HostConfig.Devices.push({ PathOnHost: driDevice, PathInContainer: driDevice, CgroupPermissions: 'rwm' });
    }
    if (accelerated && kind === 'nvidia') {
      // The NVIDIA runtime also injects Vulkan/EGL configuration. DeviceRequests alone
      // only adds the prestart hook when Docker's default runtime is runc.
      body.HostConfig.Runtime = 'nvidia';
      body.Tty = true;
      body.HostConfig.DeviceRequests = [{ Driver: 'nvidia', Count: 1, Capabilities: [['gpu']] }];
      if (xorgModuleSource) {
        body.HostConfig.Mounts = [{
          Type: 'bind', Source: xorgModuleSource, Target: '/opt/nvidia-xorg',
          ReadOnly: true, BindOptions: { Propagation: 'rprivate' },
        }];
      }
    }
    let created;
    try {
      networks = await this.ensureSessionNetworks(sessionId, agentId, selfContainerId);
      body.HostConfig.NetworkMode = networks.management;
      body.NetworkingConfig.EndpointsConfig = { [networks.management]: { Aliases: [name] } };
      created = await this.request('POST', `/containers/create?name=${encodeURIComponent(name)}`, body);
      await this.request('POST', `/containers/${encodeURIComponent(created.Id)}/start`);
      await this.request('POST', `/networks/${encodeURIComponent(networks.egress)}/connect`, { Container: created.Id });
    } catch (error) {
      // The create request can succeed in Docker while its HTTP response is
      // lost. Resolve by the deterministic name and verify labels before
      // deleting, so this does not leave an untracked running emulator.
      await this.captureDiagnostics(created?.Id || name, sessionId, agentId, onLog);
      await this.removeManaged(created?.Id || name, sessionId, agentId).catch(() => {});
      await this.removeSessionNetworks(sessionId, agentId, selfContainerId).catch(() => {});
      throw error;
    }
    return { containerId: created.Id, name };
  }

  // Create the per-session FAT image before running the original image's full command.
  // Keep it outside /tmp, which the Google launcher cleans during startup.
  async addSdcardEntrypoint(body, profile, sdCardMb) {
    const image = await this.request('GET', `/images/${encodeURIComponent(profile.image)}/json`);
    const original = [...(body.Entrypoint ?? image.Config?.Entrypoint ?? []), ...(body.Cmd ?? image.Config?.Cmd ?? [])];
    if (!original.length) throw new Error('Image has no entrypoint; cannot attach an SD card');
    body.Env.push(`RDF_SD_CARD_MB=${sdCardMb}`);
    body.Entrypoint = ['/bin/sh', '-ec', SD_CARD_LAUNCH_SCRIPT, 'rdf-sdcard', ...original];
    body.Cmd = [];
  }

  async inspect(containerId) {
    return this.request('GET', `/containers/${encodeURIComponent(containerId)}/json`);
  }

  async setEgress(containerId, sessionId, agentId, enabled) {
    const current = await this.inspect(containerId);
    const labels = current.Config?.Labels || {};
    if (labels['remote-device-farm.managed'] !== 'true' ||
        labels['remote-device-farm.agent'] !== agentId ||
        labels['remote-device-farm.session'] !== sessionId) {
      throw new Error('Refusing to change network of a container not owned by this session');
    }
    const egressNetwork = sessionNetworks(sessionId).egress;
    const managementNetwork = sessionNetworks(sessionId).management;
    const attachedNetworks = Object.keys(current.NetworkSettings?.Networks || {});
    if (!attachedNetworks.includes(managementNetwork) ||
        attachedNetworks.some((name) => name !== managementNetwork && name !== egressNetwork)) {
      throw new Error('Emulator network attachments differ from the isolated session networks');
    }
    const attached = attachedNetworks.includes(egressNetwork);
    await this.ensureNetwork(managementNetwork, sessionId, agentId, 'management');
    if (enabled || attached) await this.ensureNetwork(egressNetwork, sessionId, agentId, 'egress');
    if (enabled && !attached) {
      await this.request('POST', `/networks/${encodeURIComponent(egressNetwork)}/connect`, { Container: containerId });
    } else if (!enabled && attached) {
      await this.request('POST', `/networks/${encodeURIComponent(egressNetwork)}/disconnect`, { Container: containerId, Force: false });
    }
    if (!enabled) {
      const after = await this.inspect(containerId);
      const remaining = Object.keys(after.NetworkSettings?.Networks || {});
      if (remaining.length !== 1 || remaining[0] !== managementNetwork) {
        throw new Error('Could not confirm network isolation after disabling egress');
      }
    }
    return { enabled };
  }

  // Runs an allowlisted emulator console command inside the session's emulator container.
  async emuConsole(containerId, sessionId, agentId, args) {
    const valid = validateEmuConsoleArgs(args);
    const current = await this.inspect(containerId);
    const labels = current.Config?.Labels || {};
    if (labels['remote-device-farm.managed'] !== 'true' ||
        labels['remote-device-farm.agent'] !== agentId ||
        labels['remote-device-farm.session'] !== sessionId) {
      throw new Error('Refusing to run a console command in a container not owned by this session');
    }
    if (current.State?.Running === false) throw new Error('Emulator container is not running');
    return runEmuConsole(this, containerId, valid);
  }

  cameraImage(containerId, sessionId, agentId, params) { return applyCameraImage(this, containerId, sessionId, agentId, params); }

  async removeSessionNetworks(sessionId, agentId, selfContainerId) {
    const names = sessionNetworks(sessionId);
    for (const [purpose, name] of [['egress', names.egress], ['management', names.management]]) {
      let network;
      try { network = await this.inspectNetwork(name); }
      catch (error) {
        if (/not found|404/i.test(String(error.message))) continue;
        throw error;
      }
      const labels = network.Labels || {};
      if (labels['remote-device-farm.managed'] !== 'true' ||
          labels['remote-device-farm.agent'] !== agentId ||
          labels['remote-device-farm.session'] !== sessionId ||
          labels['remote-device-farm.purpose'] !== purpose) {
        throw new Error(`Refusing to remove unrelated Docker network ${name}`);
      }
      if (purpose === 'management') {
        const self = await this.inspect(selfContainerId);
        if (self.NetworkSettings?.Networks?.[name]) {
          await this.request('POST', `/networks/${encodeURIComponent(name)}/disconnect`, { Container: selfContainerId, Force: false });
        }
      }
      await this.request('DELETE', `/networks/${encodeURIComponent(name)}`);
    }
  }

  async listManaged(agentId) {
    const filters = encodeURIComponent(JSON.stringify({ label: [`remote-device-farm.agent=${agentId}`, 'remote-device-farm.managed=true'] }));
    return this.request('GET', `/containers/json?all=1&filters=${filters}`);
  }

  async listManagedNetworks(agentId) {
    const filters = encodeURIComponent(JSON.stringify({ label: [`remote-device-farm.agent=${agentId}`, 'remote-device-farm.managed=true'] }));
    return this.request('GET', `/networks?filters=${filters}`);
  }

  async captureDiagnostics(containerId, sessionId, agentId, onLog) {
    const report = diagnosticReporter(onLog);
    try {
      const detail = await this.inspect(containerId);
      if (detail.Config?.Labels?.['remote-device-farm.session'] !== sessionId ||
          detail.Config?.Labels?.['remote-device-farm.agent'] !== agentId) throw new Error('Container ownership mismatch');
      const state = detail.State || {};
      const secrets = diagnosticSecrets(detail.Config?.Env);
      const emit = diagnosticReporter(onLog, secrets);
      emit('container.state', JSON.stringify({ containerId: detail.Id, status: state.Status, running: state.Running,
        exitCode: state.ExitCode, oomKilled: state.OOMKilled, error: state.Error,
        startedAt: state.StartedAt, finishedAt: state.FinishedAt }), state.OOMKilled || state.Error || state.ExitCode ? 'error' : 'info', 'emulator');
      const raw = await this.requestRaw('GET', `/containers/${encodeURIComponent(containerId)}/logs?stdout=1&stderr=1&timestamps=1&tail=2000`,
        undefined, { maxBytes: 2 * 1024 * 1024, timeoutMs: 5000 });
      for (const { stream, text } of dockerLogLines(raw, detail.Config?.Tty === true)) {
        const lines = text.replace(/-----BEGIN [\s\S]*?-----END [^\n]+-----/g, '[redacted key]').split(/\r?\n/).filter(Boolean);
        for (const line of lines) await emit('container.' + stream, line, diagnosticSeverity(line, stream), 'emulator');
      }
      await emit('container.output_captured', 'Снимок stdout/stderr контейнера: последние 2000 строк.', 'info', 'emulator');
    } catch (error) { report('container.diagnostics_failed', 'Не удалось получить диагностику контейнера: ' + error.message, 'warning'); }
  }

  async removeManaged(containerId, sessionId, agentId, { timeoutMs = 90_000 } = {}) {
    let current;
    try {
      current = await this.inspect(containerId);
    } catch (error) {
      if (/No such container|404/.test(String(error.message))) return;
      throw error;
    }
    const labels = current.Config?.Labels || {};
    if (labels['remote-device-farm.managed'] !== 'true' ||
        labels['remote-device-farm.agent'] !== agentId ||
        labels['remote-device-farm.session'] !== sessionId) {
      throw new Error('Refusing to remove a container not owned by this session');
    }
    // Removal of a large writable layer can outlive the ordinary API timeout.
    // Pin retries to the inspected ID so reusing a name cannot remove another container.
    const id = encodeURIComponent(current.Id || containerId);
    const deadline = Date.now() + timeoutMs;
    try {
      await this.request('DELETE', `/containers/${id}?force=true&v=true`, undefined, { timeoutMs });
      return;
    } catch (error) {
      if (/No such container|404/.test(String(error.message))) return;
      if (!/already in progress|Docker API request timed out/i.test(String(error.message))) throw error;
    }
    // Docker may still be deleting after its HTTP connection timed out. An
    // in-progress response is not a failure or permission to release the slot.
    for (;;) {
      let remaining;
      try { remaining = await this.request('GET', `/containers/${id}/json`, undefined, { timeoutMs: 5000 }); }
      catch (error) {
        if (/No such container|404/.test(String(error.message))) return;
        throw error;
      }
      const owner = remaining.Config?.Labels || {};
      if (owner['remote-device-farm.managed'] !== 'true' ||
          owner['remote-device-farm.agent'] !== agentId || owner['remote-device-farm.session'] !== sessionId) {
        throw new Error('Container ownership changed during removal');
      }
      const left = deadline - Date.now();
      if (left <= 0) throw new Error('Container removal was not confirmed before the cleanup deadline');
      await new Promise(resolve => setTimeout(resolve, Math.min(250, left)));
    }
  }
}
