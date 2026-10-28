import { diagnostic } from './diagnostics.js';
import { uiMessage } from './messages.js';
import { randomUUID } from 'node:crypto';
import type { Express } from 'express';
import type { Pool } from 'pg';
import type { AgentHub } from './agent.js';
import type { ServerContext } from './server-context.js';
import { ApiError, route } from './http-common.js';
import { transaction } from './db.js';
import { getSecretBox } from './secrets.js';
import { registryAuthFor } from './registry.js';
import { recordAuditEvent } from './audit.js';

const DIGEST = /@sha256:[0-9a-f]{64}$/;
const PULL_TIMEOUT_MS = 30 * 60_000;
const PARALLEL_PULLS = 2;
type Job = { worker_id: string | null; host_id: string; image: string; state: string; error: string | null; created_at: Date; updated_at: Date };

/** Durable, bounded downloads. No credentials are persisted and no session or slot is allocated. */
export class ImagePrewarmWorker {
  private stopped = true;
  private timer?: ReturnType<typeof setTimeout>;
  private flight: Promise<void> | null = null;
  private readonly pulls = new Set<Promise<void>>();
  constructor(private readonly pool: Pool, private readonly hub: Pick<AgentHub, 'command' | 'hasAgent'>,
    private readonly secretsKey?: string, private readonly intervalMs = 10_000) {}

  async enqueue(hostIds?: string[], profileIds?: string[]): Promise<{ queued: number; skipped: number }> {
    return transaction(this.pool, async client => {
      const hosts = (await client.query(`SELECT id,metrics FROM hosts WHERE removed_at IS NULL AND NOT disabled
        AND ($1::text[] IS NULL OR id=ANY($1))`, [hostIds ?? null])).rows;
      const profiles = (await client.query(`SELECT id,image,abi FROM profiles WHERE removed_at IS NULL AND enabled
        AND ($1::text[] IS NULL OR id=ANY($1))`, [profileIds ?? null])).rows;
      if (hostIds && hosts.length !== new Set(hostIds).size) throw new ApiError(400, 'invalid_prewarm_hosts', uiMessage('ui.c2483f0fa8e4', {}, 'en'));
      if (profileIds && profiles.length !== new Set(profileIds).size) throw new ApiError(400, 'invalid_prewarm_profiles', uiMessage('ui.9447fc55b469', {}, 'en'));
      let queued = 0, skipped = 0;
      const pairs = new Set<string>();
      for (const host of hosts) for (const profile of profiles) {
        const image = String(profile.image);
        const architecture = host.metrics?.architecture;
        const mismatch = (architecture === 'x64' && profile.abi && !['x86', 'x86_64'].includes(profile.abi)) ||
          (architecture === 'arm64' && profile.abi && !['arm64-v8a', 'arm64'].includes(profile.abi));
        if (!DIGEST.test(image) || mismatch) { skipped++; continue; }
        const pair = `${host.id}|${image}`;
        if (pairs.has(pair)) continue;
        pairs.add(pair);
        // Re-requesting a completed download verifies the local cache; active work keeps its lease.
        const result = await client.query(`INSERT INTO image_prewarm_jobs(host_id,image) VALUES($1,$2)
          ON CONFLICT(host_id,image) DO UPDATE SET state='queued',error=NULL,worker_id=NULL,lease_until=NULL,updated_at=now()
          WHERE image_prewarm_jobs.state IN ('done','failed') RETURNING host_id`, [host.id, image]);
        queued += result.rowCount ?? 0;
      }
      return { queued, skipped };
    });
  }

  async list(): Promise<unknown[]> {
    const { rows } = await this.pool.query<Job>(`SELECT * FROM image_prewarm_jobs ORDER BY updated_at DESC LIMIT 500`);
    return rows.map(row => ({ hostId: row.host_id, image: row.image, state: row.state, error: row.error,
      createdAt: row.created_at, updatedAt: row.updated_at }));
  }

  poll(): Promise<void> {
    if (this.flight) return this.flight;
    this.flight = this.dispatch().finally(() => { this.flight = null; });
    return this.flight;
  }

  private async dispatch(): Promise<void> {
    const claimed = await transaction(this.pool, async client => {
      // Serialize claiming across API replicas; network work happens outside this short transaction.
      await client.query('SELECT pg_advisory_xact_lock(649736218)');
      await client.query(`UPDATE image_prewarm_jobs SET state='queued',worker_id=NULL,lease_until=NULL,updated_at=now()
        WHERE state='pulling' AND lease_until < now()`);
      await client.query(`UPDATE image_prewarm_jobs j SET state='failed',error=$1,updated_at=now()
        WHERE state='queued' AND (NOT EXISTS(SELECT 1 FROM hosts h WHERE h.id=j.host_id AND NOT h.disabled AND h.removed_at IS NULL)
          OR NOT EXISTS(SELECT 1 FROM profiles p WHERE p.image=j.image AND p.enabled AND p.removed_at IS NULL))`, [uiMessage('api.prewarm_unavailable', {}, 'en')]);
      const active = (await client.query<{ host_id: string }>("SELECT host_id FROM image_prewarm_jobs WHERE state='pulling'")).rows;
      const busy = new Set(active.map(job => job.host_id));
      const candidates = (await client.query<Job>(`SELECT j.* FROM image_prewarm_jobs j
        WHERE j.state='queued' ORDER BY j.created_at`)).rows;
      const selected: Job[] = [];
      for (const job of candidates) {
        if (selected.length >= PARALLEL_PULLS - active.length) break;
        if (busy.has(job.host_id) || !this.hub.hasAgent(job.host_id)) continue;
        busy.add(job.host_id);
        const claim = randomUUID();
        await client.query(`UPDATE image_prewarm_jobs SET state='pulling',worker_id=$3,lease_until=now()+interval '32 minutes',updated_at=now()
          WHERE host_id=$1 AND image=$2`, [job.host_id, job.image, claim]);
        selected.push({ ...job, worker_id: claim });
      }
      return selected;
    });
    for (const job of claimed) {
      const pull = this.download(job).finally(() => this.pulls.delete(pull));
      this.pulls.add(pull);
    }
  }

  private async download(job: Job): Promise<void> {
    let state = 'done', error: string | null = null;
    try {
      const auth = await registryAuthFor(this.pool, await getSecretBox(this.pool, this.secretsKey), job.image, 'pull', job.host_id);
      const result = await this.hub.command(job.host_id, job.host_id, 'image-prewarm', { image: job.image, auth }, PULL_TIMEOUT_MS);
      if (result.ready !== true || result.image !== job.image) throw new Error(diagnostic('image-prewarm.f5a6d3e46b'));
    } catch {
      // Never put registry credentials or arbitrary agent diagnostics in status responses.
      state = 'failed'; error = 'Image download failed. Check node connectivity, registry access and free disk space; request prewarm again to retry.';
    }
    await this.pool.query(`UPDATE image_prewarm_jobs SET state=$4,error=$5,worker_id=NULL,lease_until=NULL,updated_at=now()
      WHERE host_id=$1 AND image=$2 AND worker_id=$3`, [job.host_id, job.image, job.worker_id, state, error]).catch(() => {
      // An expired lease is retried after a database outage; ensureImage is idempotent.
    });
  }

  start(): () => Promise<void> {
    if (!this.stopped) return () => this.stop();
    this.stopped = false;
    const tick = async () => {
      try { await this.poll(); } catch { /* Database outage: retry on the next tick. */ }
      if (!this.stopped) { this.timer = setTimeout(() => { void tick(); }, this.intervalMs); this.timer.unref(); }
    };
    void tick();
    return () => this.stop();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.flight;
    // Server shutdown disposes AgentHub concurrently, interrupting the in-flight commands.
    await Promise.allSettled([...this.pulls]);
  }

  async drain(): Promise<void> { await this.flight; await Promise.allSettled([...this.pulls]); }
}

function ids(value: unknown, name: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.length || value.length > 256 || value.some(id => typeof id !== 'string' || !id || id.length > 200)) {
    throw new ApiError(400, 'invalid_prewarm', uiMessage('ui.c6c9dda668bd', { p0: name }, 'en'));
  }
  return [...new Set(value as string[])];
}

export function registerImagePrewarmRoutes(app: Express, context: ServerContext, worker: ImagePrewarmWorker): void {
  const { pool, requireAuth, requireAdmin, current } = context;
  app.get('/api/admin/emulator-images/prewarm', requireAuth, requireAdmin, route(async (_req, res) => {
    res.json({ items: await worker.list() });
  }));
  app.post('/api/admin/emulator-images/prewarm', requireAuth, requireAdmin, route(async (req, res) => {
    const body = req.body ?? {};
    if (typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !['hostIds', 'profileIds'].includes(key))) {
      throw new ApiError(400, 'invalid_prewarm', uiMessage('ui.b34dfca98530', {}, 'en'));
    }
    const result = await worker.enqueue(ids(body.hostIds, 'hostIds'), ids(body.profileIds, 'profileIds'));
    await recordAuditEvent(pool, { action: 'emulator_image.prewarm_requested', actor: current(res).user, targetType: 'emulator_image' }).catch(() => {});
    res.status(202).json(result);
  }));
}
