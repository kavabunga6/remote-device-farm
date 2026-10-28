import { tarArchive } from './tar-archive.mjs';
import { BoundedImageBuilder } from './bounded-image-builder.mjs';
export { tarArchive } from './tar-archive.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { buildManifest, imageTag, parseSdkList, selectEntries, parsePackage } from './emulator-catalog.mjs';
import { registryAuthHeader } from './docker.mjs';
import { ImageJobStore } from './emulator-image-job-store.mjs';
import { IMAGE_CHECK_VERSION } from './emulator-image-validation.mjs';
import { emulatorPushDigest } from './emulator-push-digest.mjs';

// Farm emulator images are built once, on the image builder node, from the fixed context in agent/emulator-image, then
// pushed to the farm or company registry. Every node pulls the same digest. The UI chooses only which Google system
// image goes in; the Dockerfile itself never comes from the network or the server.
export const CONTRACT_LABEL = 'remote-device-farm.contract';
export const SYSTEM_IMAGE_LABEL = 'remote-device-farm.system-image';

const CONTEXT_FILES = [['Dockerfile', 0o644], ['rdf-emulator.sh', 0o755], ['adb-auth-gate.sh', 0o755], ['secure-ramdisk.py', 0o644], ['ramdisk.py', 0o644], ['xorg.conf', 0o644]];
const CATALOG_TTL_MS = 60 * 60_000;
const BUILD_TIMEOUT_MS = 2 * 60 * 60_000;
const MAX_JOBS = 50;
const MAX_LOG_LINES = 40;

/** Host architecture as an Android ABI. */
export const hostAbi = (arch = process.arch) => arch === 'arm64' ? 'arm64-v8a' : arch === 'x64' ? 'x86_64' : arch;

/** Progress of a classic Docker build: "Step 4/12" and sdkmanager's "[===  ] 35% Downloading" lines. */
export function buildProgress(line, previous = { step: 0, steps: 0, percent: null }) {
  const step = /^Step (\d+)\/(\d+) :/.exec(line);
  if (step) return { step: Number(step[1]), steps: Number(step[2]), percent: null };
  const percent = /\b(\d{1,3})% (?:Downloading|Unzipping|Installing)/.exec(line);
  if (percent) return { ...previous, percent: Math.min(100, Number(percent[1])) };
  return previous;
}

export class EmulatorImages {
  constructor({ docker, verify = async () => { throw new Error('Image runtime validation is not configured'); }, abi = hostAbi(), contextDir = new URL('../emulator-image/', import.meta.url), now = Date.now, stateDir, store = stateDir ? new ImageJobStore(stateDir) : null, builder = new BoundedImageBuilder({ docker, agentId: 'standalone', stateDir: stateDir ?? '/var/lib/rdf-image-builds' }) }) {
    Object.assign(this, { docker, verify, abi, contextDir, now, store, builder });
    this.cache = null;
    this.jobs = store?.read() ?? [];
    this.running = null;
    this.runningController = null;
    this.storageError = null;
    let interrupted = false;
    for (const job of this.jobs) {
      if (['queued', 'building', 'validating', 'pushing', 'cancelling'].includes(job.state)) {
        job.error = job.state === 'cancelling'
          ? 'Build cancellation interrupted by agent-control restart; Docker request termination could not be confirmed.'
          : 'Build interrupted by agent-control restart. Request the build again.';
        job.errorCode = job.state === 'cancelling' ? 'build_cancelled' : 'build_interrupted';
        job.state = 'failed';
        job.finishedAt = new Date(this.now()).toISOString();
        interrupted = true;
      }
      delete job.auth;
      delete job.entry;
    }
    if (interrupted) this.persist();
  }

  async context() {
    const files = await Promise.all(CONTEXT_FILES.map(async ([name, mode]) => ({ name, mode, data: await readFile(new URL(name, this.contextDir)) })));
    const hash = createHash('sha256');
    for (const file of files) hash.update(file.name).update('\0').update(file.data);
    return { tar: tarArchive(files), hash: hash.digest('hex').slice(0, 12) };
  }

  async build(tag, buildArgs, { target, onLine = () => {}, signal } = {}) {
    const { tar } = await this.context();
    await this.builder.build(tag, buildArgs, { contextTar: tar, target, onLine, signal });
  }

  /** The tools stage (Java + sdkmanager), rebuilt only when the bundled Dockerfile changes. */
  async toolsImage() {
    const { hash } = await this.context();
    const tag = `rdf-emulator-tools:${hash}`;
    try { await this.docker.request('GET', `/images/${encodeURIComponent(tag)}/json`); return tag; }
    catch (error) { if (!/No such image|404/.test(String(error.message))) throw error; }
    await this.build(tag, {}, { target: 'tools' });
    return tag;
  }

  /** `sdkmanager --list` in a short-lived tools container; the network is only used to read Google's repository. */
  async sdkList() {
    const image = await this.toolsImage();
    const created = await this.docker.request('POST', '/containers/create', {
      Image: image, Cmd: ['sdkmanager', '--list', '--channel=0'], Tty: true,
      Labels: { 'remote-device-farm.managed': 'true', 'remote-device-farm.role': 'image-catalog' },
      HostConfig: { AutoRemove: false, CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges:true'], Memory: 1024 * 1024 * 1024 },
    });
    try {
      await this.docker.request('POST', `/containers/${created.Id}/start`);
      const result = await this.docker.request('POST', `/containers/${created.Id}/wait`, undefined, { timeoutMs: 10 * 60_000 });
      const output = await this.docker.request('GET', `/containers/${created.Id}/logs?stdout=1&stderr=1`, undefined, { raw: true, maxBytes: 4 * 1024 * 1024 });
      const text = Buffer.isBuffer(output) ? output.toString('utf8') : String(output ?? '');
      if (result?.StatusCode !== 0) throw new Error('sdkmanager --list failed: ' + text.split('\n').slice(-5).join(' ').slice(0, 500));
      return text;
    } finally {
      await this.docker.request('DELETE', `/containers/${created.Id}?force=1`).catch(() => {});
    }
  }

  async catalog({ refresh = false } = {}) {
    if (refresh || !this.cache || this.now() - this.cache.at > CATALOG_TTL_MS) {
      const entries = selectEntries(parseSdkList(await this.sdkList()), { abi: this.abi });
      this.cache = { at: this.now(), entries };
    }
    return {
      abi: this.abi, refreshedAt: new Date(this.cache.at).toISOString(),
      images: this.cache.entries.map((entry) => ({
        package: entry.package, tag: imageTag(entry), api: entry.api, minor: entry.minor,
        androidVersion: entry.androidVersion, device: entry.device, flavor: entry.flavor, abi: entry.abi, systemTag: entry.tag,
        description: entry.description,
      })),
      jobs: this.jobList(),
    };
  }

  /** Queues builds of catalog entries for one registry repository; anything not in the current catalog is refused. */
  enqueue(packages, target) {
    if (!target?.repository) throw new Error('Registry target is required');
    if (!Array.isArray(packages) || !packages.length || packages.length > 50) throw new Error('Choose 1 to 50 system images');
    if (!this.cache) throw new Error('Load the image catalog first');
    if (this.storageError) throw this.storageError;
    const entries = [...new Set(packages)].map(name => {
      const entry = this.cache.entries.find(item => item.package === name);
      if (!entry) throw new Error('Unknown system image: ' + String(name).slice(0, 100));
      return entry;
    });
    const queued = [];
    const previous = this.jobs;
    const next = [...previous];
    for (const entry of entries) {
      const image = `${target.repository}:${imageTag(entry)}`;
      const active = next.find(job => job.package === entry.package && job.image === image && ['queued', 'building', 'validating', 'pushing', 'cancelling'].includes(job.state));
      if (active) { queued.push(active.id); continue; }
      const job = { id: randomUUID(), package: entry.package, image, state: 'queued', validation: null,
        createdAt: new Date(this.now()).toISOString(), progress: { step: 0, steps: 0, percent: null }, log: [], error: null,
        digest: null, sizeMb: null, profiles: buildManifest([entry], { registry: target.repository, abi: entry.abi }).profiles, entry,
        auth: target.auth ?? null };
      next.unshift(job);
      queued.push(job.id);
    }
    // Unacknowledged results must survive until the server imports them, even if the UI is closed.
    const pending = next.filter(job => !job.acknowledged);
    if (pending.length > MAX_JOBS) throw new Error('Build queue is full. Wait for the server to record completed builds.');
    let retained = MAX_JOBS - pending.length;
    this.jobs = next.filter(job => !job.acknowledged || retained-- > 0);
    try { this.persist(); }
    catch (error) { this.jobs = previous; throw error; }
    void this.drain();
    return { jobs: this.jobList().filter(job => queued.includes(job.id)) };
  }

  async check(job, signal) {
    job.state = 'validating';
    this.persist();
    const entry = job.entry ?? parsePackage(job.package);
    const result = await this.verify(job.image, { entry, profiles: job.profiles, signal, onLine: line => {
      job.log.push(String(line).slice(0, 300)); if (job.log.length > MAX_LOG_LINES) job.log.shift();
    } });
    signal.throwIfAborted();
    const check = result?.checks?.off;
    if (result?.version !== IMAGE_CHECK_VERSION || ['bootCompleted', 'adbSecure', 'unauthorizedAdb', 'rendererVerified', 'deviceVerified', 'resourcesVerified'].some(key => check?.[key] !== true)) {
      const error = new Error('Image runtime validation did not return complete boot/authentication evidence');
      error.code = 'image_invalid'; throw error;
    }
    job.validation = result;
    this.persist();
  }

  persist() {
    this.store?.write(this.jobs);
  }

  acknowledge(ids = []) {
    if (!Array.isArray(ids) || ids.length > MAX_JOBS || ids.some(id => typeof id !== 'string' || id.length > 64)) throw new Error('Invalid build acknowledgements');
    let changed = false;
    for (const job of this.jobs) {
      if (ids.includes(job.id) && ['done', 'failed', 'cancelled'].includes(job.state) && !job.acknowledged) {
        job.acknowledged = true;
        changed = true;
      }
    }
    if (changed) this.persist();
    return { jobs: this.jobList() };
  }

  /** Stop only this queued build or its active Docker request, never unrelated containers. */
  cancel(jobId) {
    if (typeof jobId !== 'string' || !/^[a-zA-Z0-9-]{1,64}$/.test(jobId)) throw new Error('Invalid emulator build job ID');
    const job = this.jobs.find(item => item.id === jobId);
    if (!job) throw new Error('Emulator build job not found');
    if (['queued', 'building', 'validating', 'pushing'].includes(job.state)) {
      const previous = { ...job };
      job.cancelRequestedAt = new Date(this.now()).toISOString();
      job.error = null;
      if (job.state === 'queued') {
        job.state = 'cancelled';
        job.finishedAt = job.cancelRequestedAt;
        job.auth = null;
      } else {
        job.state = 'cancelling';
      }
      // Durably accept the intent before aborting; failures leave the running job unchanged.
      try { this.persist(); }
      catch (error) {
        delete job.cancelRequestedAt;
        delete job.finishedAt;
        Object.assign(job, previous);
        throw error;
      }
      if (this.running === job) this.runningController.abort(new Error('Emulator image build cancelled'));
    }
    return { jobs: this.jobList().filter(item => item.id === jobId) };
  }

  async drain() {
    if (this.running || this.storageError) return;
    while (true) {
      const job = [...this.jobs].reverse().find((item) => item.state === 'queued');
      if (!job) return;
      this.running = job;
      const controller = new AbortController();
      this.runningController = controller;
      const { signal } = controller;
      job.state = 'building';
      job.startedAt = new Date(this.now()).toISOString();
      try {
        this.persist();
        await this.build(job.image, { SYSTEM_IMAGE: job.package }, {
          signal,
          onLine: (line) => {
            job.progress = buildProgress(line, job.progress);
            job.log.push(line.slice(0, 300));
            if (job.log.length > MAX_LOG_LINES) job.log.shift();
          },
        });
        signal.throwIfAborted();
        await this.check(job, signal);
        const validatedImage = job.validation.imageId;
        const currentImage = await this.docker.request('GET',`/images/${encodeURIComponent(job.image)}/json`,undefined,{signal});
        if(typeof validatedImage !== 'string' || currentImage?.Id !== validatedImage)throw new Error('The image tag changed after validation; refusing to publish an unverified artifact');
        job.state = 'pushing';
        job.progress = { ...job.progress, percent: null };
        this.persist();
        job.digest = await this.push(job.image, job.auth, (line) => { job.log.push(line.slice(0, 300)); if (job.log.length > MAX_LOG_LINES) job.log.shift(); }, { signal });
        signal.throwIfAborted();
        const inspect = await this.docker.request('GET', `/images/${encodeURIComponent(job.image)}/json`, undefined, { signal }).catch(() => null);
        signal.throwIfAborted();
        job.sizeMb = inspect?.Size ? Math.round(inspect.Size / 1048576) : null;
        job.state = 'done';
      } catch (error) {
        const phase = job.state;
        job.state = signal.aborted && !['image_check_cleanup', 'build_cleanup_failed'].includes(error.code) ? 'cancelled' : 'failed';
        job.error = job.state === 'cancelled' ? null : String(error?.message || error).slice(0, 2000);
        job.errorCode = job.state === 'cancelled' ? null : error.code ?? (!job.digest && job.validation === null && phase === 'validating' ? 'validation_unavailable' : 'build_failed');
      } finally {
        job.finishedAt = new Date(this.now()).toISOString();
        job.auth = null;
        this.running = null;
        this.runningController = null;
        try { this.persist(); }
        catch (error) {
          this.storageError = new Error('Cannot persist emulator builds; restore the state volume before requesting another build');
          console.error(this.storageError.message);
        }
      }
      if (this.storageError) return;
    }
  }

  /** Pushes a built image; returns the registry digest every node will pull. */
  async push(image, auth, onLine = () => {}, { signal } = {}) {
    const colon = image.lastIndexOf(':');
    let digest = null;
    await this.docker.request('POST', `/images/${encodeURIComponent(image.slice(0, colon))}/push?tag=${encodeURIComponent(image.slice(colon + 1))}`, undefined, {
      timeoutMs: BUILD_TIMEOUT_MS, maxBytes: 256 * 1024 * 1024, headers: registryAuthHeader(auth), signal,
      onJsonEvent: (event) => {
        const nextDigest = emulatorPushDigest(event, image.slice(colon + 1));
        if (nextDigest) {
          if (digest && digest !== nextDigest) throw new Error('Docker push returned conflicting image digests');
          digest = nextDigest;
        }
        if (typeof event.status === 'string' && !event.progressDetail?.current) onLine(event.status);
      },
    });
    if (!/^sha256:[0-9a-f]{64}$/.test(digest ?? '')) throw new Error('The registry did not report an image digest');
    return digest;
  }

  jobList() {
    return this.jobs.map(({ entry, auth, acknowledged, ...job }) => ({ ...job, log: job.log.slice(-8) }));
  }
}
