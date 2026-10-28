import { diagnostic } from './diagnostics.mjs';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { tarArchive } from './tar-archive.mjs';
import { parseDockerStream } from './emu-console.mjs';
import { BuildResourceError, BuildResourceGuard } from './build-resource-guard.mjs';

// Fixed Dockerfile context only. The worker has no Docker socket, host namespaces, published ports or host binds.
export const BUILDKIT_IMAGE = 'moby/buildkit:v0.34.0@sha256:b059f8d7226d0b326bc871af489a5dddf65e36af4d20d14251b072974d9ee87c';
const managed = 'remote-device-farm.managed', agent = 'remote-device-farm.agent', role = 'remote-device-farm.role', owner = 'remote-device-farm.image-build';
const missing = error => /No such (?:container|network)|not found|404/i.test(String(error?.message));
const config = '[registry."docker.io"]\n  mirrors = ["mirror.gcr.io"]\n[worker.oci]\n  snapshotter = "auto"\n  max-parallelism = 1\n  gc = true\n  reservedSpace = "2GB"\n  maxUsedSpace = "12GB"\n  minFreeSpace = "20GB"\n';

// BuildKit creates nested cgroups. Keep the Docker quota in a hidden ancestor
// before allowing worker subgroups; a RUN step cannot raise that ancestor limit.
export const BUILDKIT_ENTRYPOINT = `#!/bin/sh
set -eu
[ -f /sys/fs/cgroup/cgroup.controllers ]
[ "$(cat /proc/self/cgroup)" = '0::/' ]
case "$(cat /sys/fs/cgroup/cpu.max)" in 'max '*) exit 64 ;; esac
[ "$(cat /sys/fs/cgroup/memory.max)" != max ]
[ "$(cat /sys/fs/cgroup/memory.swap.max)" = 0 ]
[ "$(cat /sys/fs/cgroup/pids.max)" != max ]
mount -o remount,rw /sys/fs/cgroup
mkdir /sys/fs/cgroup/rdf-worker
printf '%s\\n' "$$" > /sys/fs/cgroup/rdf-worker/cgroup.procs
exec /usr/bin/unshare --cgroup --mount /usr/bin/with-cgroupfs-remount /usr/bin/buildkitd "$@"
`;

export class BoundedImageBuilder {
  constructor({ docker, agentId, stateDir, diskPath = '/', guard = () => new BuildResourceGuard({ path: diskPath }), image = BUILDKIT_IMAGE, cpu = 4, memory = 6 * 1024 ** 3 }) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(agentId)) throw new Error(diagnostic('bounded-image-builder.d748efa9df'));
    Object.assign(this, { docker, agentId, stateDir, diskPath, guard, image, cpu, memory });
    this.active = null; this.cleanupBlocked = false;
  }
  labels(identity) { return { [managed]: 'true', [agent]: this.agentId, [role]: 'image-builder', [owner]: identity }; }
  owned(labels, identity) {
    if (labels?.[managed] !== 'true' || labels?.[agent] !== this.agentId || labels?.[role] !== 'image-builder' || labels?.[owner] !== identity) throw new BuildResourceError('build_cleanup_failed');
  }
  async cleanup(containerId, identity) {
    let detail;
    try { detail = await this.docker.request('GET', `/containers/${containerId}/json`); } catch (error) { if (missing(error)) return; throw new BuildResourceError('build_cleanup_failed'); }
    this.owned(detail.Config?.Labels, identity);
    try { await this.docker.request('DELETE', `/containers/${detail.Id}?force=1&v=1`, undefined, { timeoutMs: 90_000 }); }
    catch (error) { if (missing(error)) return; throw new BuildResourceError('build_cleanup_failed'); }
    try { await this.docker.request('GET', `/containers/${detail.Id}/json`); }
    catch (error) { if (missing(error)) return; throw new BuildResourceError('build_cleanup_failed'); }
    throw new BuildResourceError('build_cleanup_failed');
  }
  async cleanupNetwork(networkId, identity) {
    let detail;
    try { detail = await this.docker.request('GET', `/networks/${networkId}`); }
    catch (error) { if (missing(error)) return; throw new BuildResourceError('build_cleanup_failed'); }
    this.owned(detail.Labels, identity);
    if (detail.Driver !== 'bridge' || Object.keys(detail.Containers ?? {}).length) throw new BuildResourceError('build_cleanup_failed');
    try { await this.docker.request('DELETE', `/networks/${detail.Id}`, undefined, { timeoutMs: 90_000 }); }
    catch (error) { if (missing(error)) return; throw new BuildResourceError('build_cleanup_failed'); }
    try { await this.docker.request('GET', `/networks/${detail.Id}`); }
    catch (error) { if (missing(error)) return; throw new BuildResourceError('build_cleanup_failed'); }
    throw new BuildResourceError('build_cleanup_failed');
  }
  async recover() {
    const filters = encodeURIComponent(JSON.stringify({ label: [`${managed}=true`, `${agent}=${this.agentId}`, `${role}=image-builder`] }));
    const containers = await this.docker.request('GET', `/containers/json?all=1&filters=${filters}`);
    for (const item of containers) { const identity = item.Labels?.[owner]; if (typeof identity !== 'string' || !/^[0-9a-f-]{36}$/.test(identity)) throw new BuildResourceError('build_cleanup_failed'); await this.cleanup(item.Id, identity); }
    const networks = await this.docker.request('GET', `/networks?filters=${filters}`);
    for (const item of networks) { const identity = item.Labels?.[owner]; if (typeof identity !== 'string' || !/^[0-9a-f-]{36}$/.test(identity)) throw new BuildResourceError('build_cleanup_failed'); await this.cleanupNetwork(item.Id, identity); }
    this.cleanupBlocked = false;
  }
  async cacheVolume() {
    const name = 'rdf-buildkit-' + this.agentId;
    let volume;
    try { volume = await this.docker.request('GET', '/volumes/' + name); }
    catch (error) { if (!/No such volume|not found|404/i.test(String(error?.message))) throw error; volume = await this.docker.request('POST', '/volumes/create', { Name: name, Driver: 'local', Labels: { [managed]: 'true', [agent]: this.agentId, [role]: 'image-build-cache' } }); }
    if (volume?.Labels?.[managed] !== 'true' || volume.Labels[agent] !== this.agentId || volume.Labels[role] !== 'image-build-cache' || volume.Driver !== 'local' || Object.keys(volume.Options ?? {}).length) throw new BuildResourceError('build_cache_ownership');
    return name;
  }
  async exec(id, command, signal, timeoutMs = 30_000) {
    const created = await this.docker.request('POST', `/containers/${id}/exec`, { AttachStdout: true, AttachStderr: true, Tty: false, Cmd: command }, { signal });
    const output = await this.docker.requestRaw('POST', `/exec/${created.Id}/start`, { Detach: false, Tty: false }, { timeoutMs, maxBytes: 4 * 1024 * 1024, signal });
    const state = await this.docker.request('GET', `/exec/${created.Id}/json`, undefined, { signal });
    return { ...parseDockerStream(output, 1024 * 1024), exitCode: state.Running ? null : state.ExitCode };
  }
  async build(tag, args, { contextTar, target, signal, onLine = () => {}, onSample = () => {} } = {}) {
    if (this.cleanupBlocked) throw new BuildResourceError('build_cleanup_failed');
    if (this.active) throw new BuildResourceError('build_busy');
    const identity = randomUUID(); this.active = identity; let container, network;
    try {
      return await this.guard().run(async guardedSignal => {
        const deadline = AbortSignal.timeout(2 * 60 * 60_000), combined = AbortSignal.any([guardedSignal, deadline]);
        await this.docker.ensureImage(this.image, () => {}, { signal: combined });
        const cache = await this.cacheVolume();
        const networkCreated = await this.docker.request('POST', '/networks/create', { Name: 'rdf-build-' + this.agentId + '-' + identity, Driver: 'bridge', Labels: this.labels(identity) }, { signal: combined });
        network = networkCreated.Id;
        container = 'rdf-build-' + this.agentId + '-' + identity;
        const created = await this.docker.request('POST', '/containers/create?name=' + container, {
          Image: this.image, Entrypoint: ['/bin/sh'], Cmd: ['/tmp/rdf-buildkit-entrypoint.sh', '--config=/tmp/rdf-buildkit.toml'], Labels: this.labels(identity),
          HostConfig: { NetworkMode: network, NanoCpus: this.cpu * 1e9, Memory: this.memory, MemorySwap: this.memory, PidsLimit: 1024,
            CgroupnsMode: 'private', CapAdd: ['SYS_ADMIN', 'NET_ADMIN'], SecurityOpt: ['seccomp=unconfined', 'apparmor=unconfined'],
            Mounts: [{ Type: 'volume', Source: cache, Target: '/var/lib/buildkit' }], LogConfig: { Type: 'json-file', Config: { 'max-size': '5m', 'max-file': '2' } } },
        }, { signal: combined });
        container = created.Id;
        const upload = (tar) => this.docker.request('PUT', `/containers/${container}/archive?path=/tmp`, undefined, { rawBody: tar, contentType: 'application/x-tar', signal: combined });
        await upload(contextTar);
        await upload(tarArchive([{ name: 'rdf-buildkit.toml', mode: 0o600, data: Buffer.from(config) }, { name: 'rdf-buildkit-entrypoint.sh', mode: 0o700, data: Buffer.from(BUILDKIT_ENTRYPOINT) }]));
        await this.docker.request('POST', `/containers/${container}/start`, undefined, { signal: combined });
        for (let attempt = 0; ; attempt++) {
          const result = await this.exec(container, ['buildctl', 'debug', 'workers'], combined);
          if (result.exitCode === 0) break;
          if (attempt >= 30) throw new BuildResourceError('build_worker_unavailable');
          await delay(1000, undefined, { signal: combined });
        }
        const opts = [...Object.entries(args).flatMap(([name, value]) => ['--opt', `build-arg:${name}=${value}`]), ...(target ? ['--opt', `target=${target}`] : [])];
        const command = ['buildctl', 'build', '--frontend', 'dockerfile.v0', '--local', 'context=/tmp', '--local', 'dockerfile=/tmp', ...opts, '--output', `type=docker,name=${tag},dest=/tmp/rdf-image.tar`, '--progress', 'plain'];
        // Detached exec writes a bounded log inside the quota-limited worker. Polling never buffers the whole build output.
        const job = await this.docker.request('POST', `/containers/${container}/exec`, { AttachStdout: false, AttachStderr: false, Cmd: ['sh', '-c', 'exec "$@" > /tmp/rdf-build.log 2>&1', 'sh', ...command] }, { signal: combined });
        await this.docker.request('POST', `/exec/${job.Id}/start`, { Detach: true, Tty: false }, { signal: combined });
        let last = '';
        for (;;) {
          combined.throwIfAborted();
          const state = await this.docker.request('GET', `/exec/${job.Id}/json`, undefined, { signal: combined });
          const tail = await this.exec(container, ['tail', '-c', '16384', '/tmp/rdf-build.log'], combined);
          const text = tail.stdout + tail.stderr;
          if (text !== last) for (const line of text.trim().split(/\r?\n/).slice(-12)) onLine(line.slice(0, 300));
          last = text;
          if (!state.Running) { if (state.ExitCode !== 0) { const error = new Error(text.slice(-2000) || 'build_failed'); error.code = 'build_failed'; throw error; } break; }
          await delay(5000, undefined, { signal: combined });
        }
        // Stop buildkitd first. The small exporter file remains available through Docker's archive API.
        await this.docker.request('POST', `/containers/${container}/stop?t=10`, undefined, { signal: combined });
        await this.docker.importImageArchive(container, { signal: combined });
      }, { signal, onSample });
    } finally {
      try { if (container) await this.cleanup(container, identity); if (network) await this.cleanupNetwork(network, identity); }
      catch (error) { this.cleanupBlocked = true; throw error; }
      finally { this.active = null; }
    }
  }
}
