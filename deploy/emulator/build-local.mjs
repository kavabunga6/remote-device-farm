import { readFile, open, mkdir, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { DockerClient } from '../../agent/src/docker.mjs';
import { BoundedImageBuilder } from '../../agent/src/bounded-image-builder.mjs';
import { tarArchive } from '../../agent/src/tar-archive.mjs';
import { parsePackage } from '../../agent/src/emulator-catalog.mjs';
import { validateImage } from '../../agent/src/config.mjs';

const [tag, systemImage = '', target = ''] = process.argv.slice(2);
validateImage(tag, [tag]);
if (target !== '' && target !== 'tools') throw new Error('Invalid build target');
if (!target && !parsePackage(systemImage)) throw new Error('Invalid Android SDK package');
const directory = new URL('./out/', import.meta.url);
await mkdir(directory, { recursive: true });
const lock = new URL('.build.lock', directory);
const held = await open(lock, 'wx', 0o600).catch(() => { throw new Error('build_busy'); });
await held.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }) + '\n');
const controller = new AbortController();
const abort = () => controller.abort(new Error('build_cancelled'));
process.on('SIGINT', abort); process.on('SIGTERM', abort);
try {
  const docker = new DockerClient(process.env.DOCKER_SOCKET || '/var/run/docker.sock');
  const info = await docker.request('GET', '/info');
  const diskPath = process.env.AGENT_IMAGE_BUILD_DISK_PATH || info.DockerRootDir;
  if (typeof diskPath !== 'string' || !diskPath.startsWith('/')) throw new Error('build_metrics_unavailable');
  const agentId = 'cli-' + createHash('sha256').update(resolve('.')).digest('hex').slice(0, 16);
  const builder = new BoundedImageBuilder({ docker, agentId, diskPath });
  await builder.recover();
  const names = ['Dockerfile', 'rdf-emulator.sh', 'adb-auth-gate.sh', 'secure-ramdisk.py', 'ramdisk.py', 'xorg.conf'];
  const files = await Promise.all(names.map(async name => ({ name, mode: 0o755, data: await readFile(new URL('../../agent/emulator-image/' + name, import.meta.url)) })));
  await builder.build(tag, target ? {} : { SYSTEM_IMAGE: systemImage }, { target: target || undefined, contextTar: tarArchive(files), signal: controller.signal,
    onLine: line => console.log(line), onSample: ({ freeGiB, availableGiB, cpuPercent, ioPressure }) => console.log(JSON.stringify({ event: 'build.resources', freeGiB, availableGiB, cpuPercent, ioPressure })) });
} catch (error) { console.error(JSON.stringify({ event: 'build.failed', code: error.code ?? 'build_failed' })); process.exitCode = 1; }
finally { await held.close(); await unlink(lock); process.off('SIGINT', abort); process.off('SIGTERM', abort); }
