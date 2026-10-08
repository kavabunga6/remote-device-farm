import { completeImageCheck } from './image-readiness.js';
import type { Pool, PoolClient } from 'pg';
import type { AgentHub } from './agent.js';
import { transaction } from './db.js';
import { parseManifest, checkManifestProfile } from './profile-manifest.js';
import { recordAuditEvent } from './audit.js';
import { getSecretBox, sealEnv, type SecretBox } from './secrets.js';
import { IMAGE_REPOSITORY, readRegistrySettings } from './registry.js';
import { recordServiceLog } from './service-log.js';

const DIGEST = /^sha256:[0-9a-f]{64}$/;

export interface AgentJob {
  id: string; package: string; image: string; state: 'queued' | 'building' | 'validating' | 'pushing' | 'cancelling' | 'cancelled' | 'done' | 'failed';
  createdAt?: string; finishedAt?: string;
  digest?: string | null; sizeMb?: number | null; error?: string | null; progress?: unknown; log?: string[];
  profiles?: Array<Record<string, unknown>>;
  validation?: unknown;
}

/** Inserts the profiles of a finished build; existing ids stay as they are (an update is offered in the catalog). */
async function createProfiles(client: PoolClient, box: SecretBox, job: AgentJob, repository: string): Promise<string[]> {
  const tag = job.image.slice(job.image.lastIndexOf(':') + 1);
  const manifest = { version: 2, profiles: (job.profiles ?? []).map(profile => ({ ...profile, image: { repository, tag, digest: job.digest } })) };
  const { profiles: items, issues } = parseManifest(manifest);
  if (issues.length) throw new Error('Agent returned an invalid profile manifest');
  const created: string[] = [];
  for (const item of items) {
    const existing = await client.query('SELECT id FROM profiles WHERE id=$1', [item.input.id]);
    if (existing.rowCount) continue;
    const checked = checkManifestProfile(item, false);
    if (!checked.parsed) throw new Error('Agent returned an invalid profile: ' + (checked.issue?.message ?? 'unknown'));
    const p = checked.parsed;
    const sealed = await sealEnv(box, p.containerEnv, {});
    await client.query(
      `INSERT INTO profiles(id,name,android_version,image,cpu,memory_mb,guest_memory_mb,guest_cores,disk_gb,emulator_params,api_level,abi,device_model,resolution,image_flavor,device_type,image_tag,recommended,container_env,disk_max_gb,sdcard_gb,sdcard_max_gb,docker_options,enabled)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,true)`,
      [p.id, p.name, p.androidVersion, p.image, p.cpu, p.memoryMb, p.guestMemoryMb, p.guestCores, p.diskGb, p.emulatorParams, p.apiLevel, p.abi, p.deviceModel, p.resolution, p.imageFlavor, p.deviceType, p.imageTag, p.recommended, sealed, p.diskMaxGb, p.sdcardGb, p.sdcardMaxGb, p.dockerOptions]);
    created.push(p.id);
  }
  return created;
}

/** Imports each agent result exactly once, whether received by a background poll or the catalog UI. */
export class ImageBuildWorker {
  private flight: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = true;
  private readonly failedHosts = new Set<string>();

  constructor(private readonly pool: Pool, private readonly hub: Pick<AgentHub, 'command' | 'hasAgent'>,
    private readonly secretsKey?: string, private readonly intervalMs = 15_000) {}

  async recordJobs(jobs: AgentJob[], hostId: string): Promise<Record<string, string[]>> {
    const settings = await readRegistrySettings(this.pool);
    const repositories = [settings.builtinAddress, settings.externalAddress].filter(Boolean).map(address => `${address}/${IMAGE_REPOSITORY}`);
    const createdBy: Record<string, string[]> = {};
    const box = await getSecretBox(this.pool, this.secretsKey);
    // Agents return newest first. Record oldest first so a batch of completed rebuilds ends at the newest digest.
    for (const job of [...jobs].reverse()) {
      if (!job || !['done', 'failed', 'cancelled'].includes(job.state) || typeof job.id !== 'string') continue;
      const repository = repositories.find(value => job.image?.startsWith(value + ':'));
      if (!repository || (job.state === 'done' && (!job.digest || !DIGEST.test(job.digest)))) continue;
      const imported = await transaction(this.pool, async client => {
        // Serializes catalog polling, workers and multiple API replicas, including profile creation.
        await client.query('SELECT pg_advisory_xact_lock(649736216)');
        const receipt = await client.query(
          `INSERT INTO emulator_image_job_receipts(host_id,job_id,state,repository,package,digest)
           VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(host_id,job_id) DO NOTHING RETURNING job_id`,
          [hostId, job.id, job.state, repository, job.package, job.digest ?? null]);
        if (!receipt.rowCount) return null;
        if (job.state !== 'done') return [];
        if ((await client.query('SELECT 1 FROM image_removals WHERE repository=$1 AND digest=$2', [repository, job.digest])).rowCount) return [];
        if ('validation' in job && !completeImageCheck(job.validation)) throw new Error('Completed image build has no complete runtime validation evidence');
        const finishedAt = job.finishedAt && Number.isFinite(Date.parse(job.finishedAt)) ? new Date(job.finishedAt) : new Date();
        const latest = await client.query(
          `INSERT INTO emulator_images(package,repository,tag,digest,size_mb,builder_host_id,built_at,validation) VALUES($1,$2,$3,$4,$5,$6,$7,$8)
           ON CONFLICT (repository,package) DO UPDATE SET tag=EXCLUDED.tag,digest=EXCLUDED.digest,size_mb=EXCLUDED.size_mb,
             builder_host_id=EXCLUDED.builder_host_id,built_at=EXCLUDED.built_at,validation=EXCLUDED.validation
           WHERE emulator_images.built_at <= EXCLUDED.built_at RETURNING digest`,
          [job.package, repository, job.image.slice(repository.length + 1), job.digest, job.sizeMb ?? null, hostId, finishedAt, job.validation ?? null]);
        if (!latest.rowCount) return [];
        return createProfiles(client, box, job, repository);
      });
      if (imported !== null) {
        createdBy[job.id] = imported;
        await recordAuditEvent(this.pool, { action: job.state === 'done' ? 'emulator_image.built' : job.state === 'cancelled' ? 'emulator_image.build_cancelled' : 'emulator_image.build_failed', actor: null,
          targetType: 'emulator_image', targetId: job.package }).catch(() => {});
      }
    }
    return createdBy;
  }

  /** Cheap local job snapshots only: never runs sdkmanager or downloads a catalog. */
  poll(): Promise<void> {
    if (this.flight) return this.flight;
    this.flight = this.pollOnce().finally(() => { this.flight = null; });
    return this.flight;
  }

  private async pollOnce(): Promise<void> {
    // Include former builders: changing the selected builder must not orphan their pending results.
    const { rows } = await this.pool.query('SELECT id FROM hosts WHERE removed_at IS NULL');
    const hosts = rows.filter(row => this.hub.hasAgent(String(row.id)));
    for (let offset = 0; offset < hosts.length; offset += 4) {
      await Promise.all(hosts.slice(offset, offset + 4).map(async row => {
        const hostId = String(row.id);
        try {
          const result = await this.hub.command(hostId, hostId, 'emulator-jobs', {}, 15_000);
          if (!Array.isArray(result.jobs)) throw new Error('Invalid emulator job snapshot');
          const jobs = result.jobs as AgentJob[];
          let failed = false;
          for (const job of [...jobs].reverse()) {
            try { await this.recordJobs([job], hostId); }
            catch { failed = true; }
          }
          const receipts = await this.pool.query('SELECT job_id FROM emulator_image_job_receipts WHERE host_id=$1 AND job_id=ANY($2::text[])',
            [hostId, jobs.map(job => job.id)]);
          const acknowledged = receipts.rows.map(row => String(row.job_id));
          if (acknowledged.length) await this.hub.command(hostId, hostId, 'emulator-jobs', { acknowledged }, 15_000);
          if (failed) throw new Error('One or more image results could not be imported');
          this.failedHosts.delete(hostId);
        } catch {
          // Keep the agent result unacknowledged. A later poll retries after reconnect or database recovery.
          if (!this.failedHosts.has(hostId)) {
            this.failedHosts.add(hostId);
            await recordServiceLog(this.pool, { service: 'server', severity: 'error', code: 'emulator_images.reconcile_failed', hostId }).catch(() => {});
          }
        }
      }));
    }
  }

  start(): () => Promise<void> {
    if (!this.stopped) return () => this.stop();
    this.stopped = false;
    const schedule = () => {
      if (this.stopped) return;
      this.timer = setTimeout(() => {
        void this.poll().catch(() => {
          console.error('Emulator image background reconciliation failed; retrying');
        }).finally(schedule);
      }, this.intervalMs);
      this.timer.unref();
    };
    void this.poll().catch(() => {
      console.error('Emulator image background reconciliation failed; retrying');
    }).finally(schedule);
    return () => this.stop();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await this.flight;
  }
}
