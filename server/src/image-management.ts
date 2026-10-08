import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { AgentHub } from './agent.js';
import { ApiError } from './http-common.js';
import { uiMessage } from './messages.js';
import { IMAGE_REPOSITORY, readRegistrySettings } from './registry.js';
import { RegistryMaintenanceClient, type RegistryMaintenance } from './image-maintenance-client.js';
import { defaultPolicy, imageMatches, planToken, registryCandidates, validDigest, type CleanupPolicy, type ImageUse, type ManagedImage } from './image-retention.js';
import { recordAuditEvent } from './audit.js';
import { recordServiceLog } from './service-log.js';
import { assertStoredPermission } from './permissions.js';
type DB = Pick<PoolClient, 'query'>;
export type CacheImage = { id: string; tags: string[]; digests: string[]; sizeBytes: number; package: string | null; firstSeenAt: string; lastUsedAt: string | null; containers: string[]; blockers: string[]; uses?: ImageUse[] };
type Job = { id: string; scope: 'registry' | 'cache'; host_id: string | null; actor_id: string | null; automatic: boolean; state: string; stage: string; payload: Plan; result: unknown; error_code: string | null };
export type Plan = { scope: 'registry' | 'cache'; action: 'delete' | 'retention' | 'gc'; hostId?: string; digests?: string[]; ids?: string[]; removeProfiles?: boolean; token: string; items: Array<ManagedImage | CacheImage>; blocked: boolean };
const activeBuild = ['queued', 'building', 'validating', 'pushing', 'cancelling'];
const fail = (code: string, status = 409) => new ApiError(status, code, uiMessage('images.error.' + code));
export class ImageManagement {
  private flight: Promise<void> | null = null; private timer?: ReturnType<typeof setTimeout>; private stopped = true;
  constructor(private readonly pool: Pool, private readonly hub: Pick<AgentHub, 'command' | 'hasAgent'>, private readonly registry: RegistryMaintenance = new RegistryMaintenanceClient()) { }
  async policy(db: DB = this.pool): Promise<CleanupPolicy & { lastRunAt: string | null }> {
    const row = (await db.query('SELECT * FROM image_cleanup_policy WHERE id')).rows[0];
    return {
      registryEnabled: row.registry_enabled, registryKeep: row.registry_keep, registryDays: row.registry_days,
      cacheEnabled: row.cache_enabled, cacheDays: row.cache_days, cacheMaxGb: row.cache_max_gb, intervalHours: row.interval_hours, lastRunAt: row.last_run_at
    };
  }
  async savePolicy(input: Record<string, unknown>) {
    if (Object.keys(input).some(key => !Object.hasOwn(defaultPolicy, key)) || Object.keys(defaultPolicy).some(key => !Object.hasOwn(input, key))) throw fail('invalid', 400);
    for (const key of ['registryEnabled', 'cacheEnabled']) if (typeof input[key] !== 'boolean') throw fail('invalid', 400);
    for (const [key, min, max] of [['registryKeep', 1, 100], ['registryDays', 1, 3650], ['cacheDays', 1, 3650], ['cacheMaxGb', 0, 100000], ['intervalHours', 1, 720]] as const)
      if (!Number.isSafeInteger(input[key]) || Number(input[key]) < min || Number(input[key]) > max) throw fail('invalid', 400);
    await this.pool.query('UPDATE image_cleanup_policy SET registry_enabled=$1,registry_keep=$2,registry_days=$3,cache_enabled=$4,cache_days=$5,cache_max_gb=$6,interval_hours=$7,updated_at=now() WHERE id',
      [input.registryEnabled, input.registryKeep, input.registryDays, input.cacheEnabled, input.cacheDays, input.cacheMaxGb, input.intervalHours]);
    return this.policy();
  }
  private async uses(db: DB = this.pool): Promise<ImageUse[]> {
    const rows = (await db.query(`SELECT 'profile' AS kind,id,name,image FROM profiles WHERE removed_at IS NULL
      UNION ALL SELECT 'session',s.id::text,s.id::text,COALESCE(s.launch_image,p.image) FROM sessions s JOIN profiles p ON p.id=s.profile_id
        WHERE s.state IN ('starting','running','stopping') OR EXISTS(SELECT 1 FROM host_slots hs WHERE hs.session_id=s.id)
      UNION ALL SELECT 'queue',q.id::text,q.id::text,p.image FROM queue_entries q JOIN profiles p ON p.id=q.profile_id WHERE q.state='waiting' OR(q.state='assigned' AND q.resolved_at IS NULL)
      UNION ALL SELECT 'catalog',package,package,repository || ':' || tag || '@' || digest FROM emulator_images
      UNION ALL SELECT 'prewarm',host_id,host_id,image FROM image_prewarm_jobs WHERE state IN ('queued','pulling')`)).rows;
    return rows as ImageUse[];
  }
  async registryImages(db: DB = this.pool) {
    const settings = await readRegistrySettings(db);
    if (settings.mode !== 'builtin' || !settings.builtinAddress) return { supported: false, repository: null, items: [] as ManagedImage[], maintenance: false, blockers: [] as string[] };
    const repository = settings.builtinAddress + '/' + IMAGE_REPOSITORY;
    const inventory = await this.registry.inventory();
    const refs = await this.uses(db);
    const completed = (await db.query("SELECT digest FROM emulator_image_job_receipts WHERE repository=$1 AND state='done' UNION SELECT digest FROM emulator_images WHERE repository=$1", [repository])).rows;
    const known = new Set(completed.map(row => row.digest));
    const items: ManagedImage[] = inventory.items.map(item => ({
      ...item, known: known.has(item.digest),
      uses: refs.filter(ref => imageMatches(ref.image, repository, item)).sort((a, b) => (a.kind + a.id).localeCompare(b.kind + b.id)), blockers: []
    }));
    for (const item of items) {
      item.blockers.push(...item.uses.filter(use => ['session', 'queue', 'prewarm'].includes(use.kind)).map(use => use.kind));
      if (items.some(parent => parent.digest !== item.digest && parent.children.includes(item.digest))) item.blockers.push('index');
      if (inventory.repositories.some(repo => repo !== IMAGE_REPOSITORY)) item.blockers.push('sharedRegistry');
      item.blockers = [...new Set(item.blockers)];
    }
    return { supported: true, repository, items: items.sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? '') || a.digest.localeCompare(b.digest)), maintenance: inventory.maintenance, blockers: inventory.repositories.some(repo => repo !== IMAGE_REPOSITORY) ? ['sharedRegistry'] : [] };
  }
  private async registryWork(db: DB = this.pool): Promise<string[]> {
    const settings = await readRegistrySettings(db), prefix = settings.builtinAddress + '/' + IMAGE_REPOSITORY + ':';
    const hosts = (await db.query('SELECT id FROM hosts WHERE removed_at IS NULL')).rows;
    const blockers: string[] = [];
    await Promise.all(hosts.filter(row => this.hub.hasAgent(String(row.id))).map(async row => {
      const reply = await this.hub.command(String(row.id), String(row.id), 'emulator-jobs', {}, 15000);
      if (!Array.isArray(reply.jobs)) throw fail('unavailable', 503);
      if (reply.jobs.some((job: any) => activeBuild.includes(job.state) && job.image?.startsWith(prefix))) blockers.push('build');
    }));
    const pulling = (await db.query("SELECT 1 FROM image_prewarm_jobs WHERE state='pulling' LIMIT 1")).rowCount;
    const starting = (await db.query("SELECT 1 FROM sessions WHERE state='starting' LIMIT 1")).rowCount;
    if (pulling || starting) blockers.push('transfer');
    return [...new Set(blockers)];
  }
  async cache(hostId: string, db: DB = this.pool) {
    const host = (await db.query('SELECT id,coalesce(display_name,name) AS name FROM hosts WHERE id=$1 AND removed_at IS NULL', [hostId])).rows[0];
    if (!host) throw fail('not_found', 404); if (!this.hub.hasAgent(hostId)) throw fail('offline');
    const refs = await this.uses(db);
    const reply = await this.hub.command(hostId, hostId, 'image-cache', { protectedRefs: [...new Set(refs.map(ref => ref.image))] }, 60000);
    if (!Array.isArray(reply.items) || reply.items.length > 10000) throw fail('unavailable', 503);
    const items = reply.items as CacheImage[];
    if (items.some(item => !validDigest(item.id) || !Number.isSafeInteger(item.sizeBytes) || item.sizeBytes < 0
      || !Number.isFinite(Date.parse(item.firstSeenAt)) || (item.lastUsedAt !== null && !Number.isFinite(Date.parse(item.lastUsedAt)))
      || [item.blockers, item.tags, item.digests, item.containers].some(values => !Array.isArray(values) || values.length > 1000 || values.some(value => typeof value !== 'string' || value.length > 512))
      || (item.package !== null && (typeof item.package !== 'string' || item.package.length > 512)))) throw fail('unavailable', 503);
    for (const item of items) {
      item.uses = refs.filter(ref => item.tags.includes(ref.image) || item.digests.includes(ref.image) || ref.image.includes('@') && item.digests.some(digest => digest.split('@')[1] === ref.image.split('@')[1])).sort((a, b) => (a.kind + a.id).localeCompare(b.kind + b.id));
      if (item.uses.length && !item.blockers.includes('reference')) item.blockers.push('reference');
    }
    return { hostId, name: String(host.name), items };
  }
  async preview(input: Record<string, unknown>, db: DB = this.pool): Promise<Plan> {
    if (Object.keys(input).some(key => !['scope', 'action', 'hostId', 'digests', 'ids', 'removeProfiles', 'token', 'items', 'blocked'].includes(key))) throw fail('invalid', 400);
    if (!['registry', 'cache'].includes(String(input.scope)) || !['delete', 'retention', 'gc'].includes(String(input.action))) throw fail('invalid', 400);
    if (input.removeProfiles !== undefined && typeof input.removeProfiles !== 'boolean') throw fail('invalid', 400);
    const scope = input.scope as 'registry' | 'cache', action = input.action as Plan['action'], policy = await this.policy(db);
    if (input.removeProfiles === true && (scope !== 'registry' || action !== 'delete')) throw fail('invalid', 400);
    if (scope === 'registry') {
      const data = await this.registryImages(db); if (!data.supported) throw fail('external');
      let digests: string[];
      if (action === 'delete') {
        if (!Array.isArray(input.digests) || !input.digests.length || input.digests.length > 500 || input.digests.some(value => !validDigest(value))) throw fail('invalid', 400);
        digests = [...new Set(input.digests as string[])].sort();
      } else digests = action === 'gc' ? [] : registryCandidates(data.items, policy).map(item => item.digest).sort();
      const selected = data.items.filter(item => digests.includes(item.digest));
      if (selected.length !== digests.length) throw fail('not_found', 404);
      const selectedDigests = new Set(digests);
      const blockers = [...await this.registryWork(db), ...data.blockers, ...(data.maintenance ? ['transfer'] : [])];
      const items = selected.map(item => ({
        ...item, blockers: [...item.blockers.filter(reason => reason !== 'index'),
        ...(data.items.some(parent => !selectedDigests.has(parent.digest) && parent.children.includes(item.digest)) ? ['index'] : []), ...blockers]
      }));
      // Inventory + references are signed together, so a stale confirmation cannot delete a newly used image.
      const token = planToken(scope, { action, digests, removeProfiles: input.removeProfiles === true, items, blockers });
      return { scope, action, digests, removeProfiles: input.removeProfiles === true, token, items, blocked: Boolean(blockers.length || items.some(item => item.blockers.length)) };
    }
    if (action === 'gc' || typeof input.hostId !== 'string' || input.hostId.length > 200) throw fail('invalid', 400);
    const data = await this.cache(input.hostId, db);
    const candidates = data.items.filter(item => !item.blockers.length);
    let ids: string[];
    if (action === 'delete') {
      if (!Array.isArray(input.ids) || !input.ids.length || input.ids.length > 100 || input.ids.some(value => !validDigest(value))) throw fail('invalid', 400);
      ids = [...new Set(input.ids as string[])].sort();
    } else {
      const expired = candidates.filter(item => Date.parse(item.lastUsedAt ?? item.firstSeenAt) < Date.now() - policy.cacheDays * 86400000);
      const selected = new Set(expired.map(item => item.id));
      let bytes = data.items.reduce((sum, item) => sum + item.sizeBytes, 0) - expired.reduce((sum, item) => sum + item.sizeBytes, 0);
      if (policy.cacheMaxGb) for (const item of [...candidates].sort((a, b) => (a.lastUsedAt ?? a.firstSeenAt).localeCompare(b.lastUsedAt ?? b.firstSeenAt))) {
        if (bytes <= policy.cacheMaxGb * 1024 ** 3) break;
        if (!selected.has(item.id)) { selected.add(item.id); bytes -= item.sizeBytes; }
      }
      ids = [...selected].slice(0, 100).sort();
    }
    const items = data.items.filter(item => ids.includes(item.id));
    if (items.length !== ids.length) throw fail('not_found', 404);
    return { scope, action, hostId: input.hostId, ids, token: planToken(scope, { hostId: input.hostId, ids, items }), items, blocked: items.some(item => item.blockers.length > 0) };
  }
  async enqueue(input: Record<string, unknown>, actorId: string | null, automatic = false) {
    const plan = await this.preview(input);
    if (plan.blocked) throw fail('protected');
    if (!automatic && input.token !== plan.token) throw fail('changed');
    if (plan.action !== 'gc' && !(plan.digests?.length || plan.ids?.length)) throw fail('empty');
    const id = randomUUID();
    try {
      await this.pool.query('INSERT INTO image_cleanup_jobs(id,scope,host_id,actor_id,automatic,payload) VALUES($1,$2,$3,$4,$5,$6)', [id, plan.scope, plan.hostId ?? null, actorId, automatic, JSON.stringify(plan)]);
    } catch (error) { if ((error as { code?: string }).code === '23505') throw fail('busy'); throw error; }
    await recordAuditEvent(this.pool, { action: 'images.cleanup_requested', actor: actorId ? { id: actorId } as any : null, targetType: 'image_cleanup', targetId: id }).catch(() => { });
    await recordServiceLog(this.pool, { service: 'server', severity: 'info', code: 'image_cleanup.requested', hostId: plan.hostId, message: JSON.stringify({ jobId: id, scope: plan.scope, action: plan.action }) }).catch(() => { });
    void this.poll().catch(() => { }); return { id, state: 'queued' };
  }
  async jobs() { return (await this.pool.query('SELECT id,scope,host_id AS "hostId",automatic,state,stage,result,error_code AS "errorCode",created_at AS "createdAt",updated_at AS "updatedAt" FROM image_cleanup_jobs ORDER BY created_at DESC LIMIT 100')).rows; }
  poll(): Promise<void> { if (this.flight) return this.flight; this.flight = this.tick().finally(() => { this.flight = null; }); return this.flight; }
  private async tick() {
    const client = await this.pool.connect();
    try {
      const acquired = (await client.query('SELECT pg_try_advisory_lock(649736219) AS acquired')).rows[0]?.acquired;
      if (!acquired) return;
      try {
        const job = (await client.query<Job>("SELECT * FROM image_cleanup_jobs WHERE state IN ('queued','running') ORDER BY created_at LIMIT 1")).rows[0];
        if (job) await this.execute(client, job); else await this.schedule();
      } finally { await client.query('SELECT pg_advisory_unlock(649736219)'); }
    } finally { client.release(); }
  }
  private async execute(client: PoolClient, job: Job) {
    try {
      if (job.state === 'queued') {
        if (job.actor_id) await assertStoredPermission(client, job.actor_id, job.scope === 'registry' && job.payload.action === 'delete' ? 'images.delete' : 'images.cleanup');
        let plan = await this.preview(job.payload as unknown as Record<string, unknown>, client);
        if (plan.blocked || (!job.automatic && plan.token !== job.payload.token)) throw fail('changed');
        if (job.scope === 'registry') {
          await client.query('BEGIN');
          try {
            await client.query("SET LOCAL lock_timeout='5s'");
            await client.query('LOCK TABLE profiles,sessions,host_slots,queue_entries,emulator_images,image_prewarm_jobs IN SHARE ROW EXCLUSIVE MODE');
            plan = await this.preview(job.payload as unknown as Record<string, unknown>, client);
            if (plan.blocked || (!job.automatic && plan.token !== job.payload.token)) throw fail('changed');
            await client.query("SELECT set_config('rdf.image_maintenance','on',true)");
            const settings = await readRegistrySettings(client), repository = settings.builtinAddress + '/' + IMAGE_REPOSITORY;
            for (const item of plan.items as ManagedImage[]) {
              const refs = [...item.tags.map(tag => repository + ':' + tag), ...item.uses.map(use => use.image)];
              await client.query('INSERT INTO image_removals(repository,digest,refs,job_id) VALUES($1,$2,$3,$4) ON CONFLICT(repository,digest) DO UPDATE SET refs=EXCLUDED.refs,job_id=EXCLUDED.job_id,removed_at=now()', [repository, item.digest, refs, job.id]);
              const profiles = item.uses.filter(use => use.kind === 'profile').map(use => use.id);
              if (profiles.length) await client.query(`UPDATE profiles SET enabled=false,recommended=false,removed_at=CASE WHEN $2 THEN now() ELSE removed_at END WHERE id=ANY($1)`, [profiles, plan.removeProfiles === true]);
              await client.query('DELETE FROM emulator_images WHERE repository=$1 AND digest=$2', [repository, item.digest]);
            }
            await client.query("UPDATE image_cleanup_jobs SET state='running',stage='submitted',updated_at=now() WHERE id=$1", [job.id]);
            await client.query('COMMIT');
          } catch (error) { await client.query('ROLLBACK'); throw error; }
          // Store intent first: retrying this exact id recovers an uncertain HTTP outcome.
          await this.registry.submit(job.id, plan.digests ?? []);
          await this.log(job, 'submitted');
        } else {
          const refs = await this.uses(client);
          await client.query("UPDATE image_cleanup_jobs SET state='running',stage='deleting',updated_at=now() WHERE id=$1", [job.id]);
          const result = await this.hub.command(job.host_id!, job.host_id!, 'image-cache-remove', { ids: plan.ids, protectedRefs: [...new Set(refs.map(ref => ref.image))] }, 60000);
          await client.query("UPDATE image_cleanup_jobs SET state=$2,stage='done',result=$3,error_code=$4,updated_at=now() WHERE id=$1", [job.id, Array.isArray(result.failed) && result.failed.length ? 'failed' : 'done', JSON.stringify(result), Array.isArray(result.failed) && result.failed.length ? 'partial' : null]);
          await recordAuditEvent(this.pool, { action: Array.isArray(result.failed) && result.failed.length ? 'images.cleanup_failed' : 'images.cleanup_done', actor: null, targetType: 'image_cleanup', targetId: job.id }).catch(() => { });
          await this.log(job, Array.isArray(result.failed) && result.failed.length ? 'failed' : 'done', Array.isArray(result.failed) && result.failed.length ? 'partial' : undefined);
        }
      } else if (job.scope === 'cache') {
        // Never replay destructive node commands after an uncertain disconnect.
        await client.query("UPDATE image_cleanup_jobs SET state='failed',error_code='interrupted',updated_at=now() WHERE id=$1", [job.id]);
        await this.log(job, 'failed', 'interrupted');
      } else {
        let remote = await this.registry.status(job.id);
        if (!remote) {
          // A lost supervisor state must not trap all new launches indefinitely.
          // Missing manifests remain tombstoned; retry only those still present.
          const present = new Set((await this.registry.inventory()).items.map(item => item.digest));
          remote = await this.registry.submit(job.id, (job.payload.digests ?? []).filter(digest => present.has(digest)));
        }
        // Keep intent running until post-cleanup inventory is available: a transient
        // read failure must not leave an existing image permanently tombstoned.
        if (['done', 'failed'].includes(remote.state)) {
          const present = (await this.registry.inventory()).items.map(item => item.digest);
          await client.query('DELETE FROM image_removals WHERE job_id=$1 AND digest=ANY($2)', [job.id, present]);
        }
        await client.query('UPDATE image_cleanup_jobs SET state=$2,stage=$3,result=$4,error_code=$5,updated_at=now() WHERE id=$1',
          [job.id, remote.state, remote.stage, JSON.stringify({ deleted: remote.deleted }), remote.errorCode ?? null]);
        if (remote.stage !== job.stage || ['done', 'failed'].includes(remote.state)) await this.log(job, remote.state === 'failed' ? 'failed' : remote.stage, remote.errorCode ?? undefined);
        if (['done', 'failed'].includes(remote.state)) await recordAuditEvent(this.pool, { action: 'images.cleanup_' + remote.state, actor: null, targetType: 'image_cleanup', targetId: job.id }).catch(() => { });
      }
    } catch (error) {
      // A registry request may have reached the supervisor: preserve running intent and poll again.
      if (job.scope === 'registry' && (await client.query("SELECT state FROM image_cleanup_jobs WHERE id=$1", [job.id])).rows[0]?.state === 'running'
        && error instanceof ApiError && error.status === 503) return;
      const code = error instanceof ApiError ? error.code : 'cleanup_failed';
      await client.query("UPDATE image_cleanup_jobs SET state='failed',error_code=$2,updated_at=now() WHERE id=$1", [job.id, code]);
      await this.log(job, 'failed', error instanceof Error ? error.message : code);
    }
  }
  private async log(job: Job, stage: string, error?: string) {
    await recordServiceLog(this.pool, { service: 'server', severity: error ? 'error' : 'info', code: 'image_cleanup.' + stage as `image_cleanup.${string}`, hostId: job.host_id ?? undefined, message: JSON.stringify({ jobId: job.id, scope: job.scope, ...(error ? { error } : {}) }) }).catch(() => { });
  }
  private async schedule() {
    const policy = await this.policy();
    if (!policy.registryEnabled && !policy.cacheEnabled) return;
    const claimed = await this.pool.query('UPDATE image_cleanup_policy SET last_run_at=now() WHERE id AND (last_run_at IS NULL OR last_run_at < now()-make_interval(hours=>interval_hours)) RETURNING id');
    if (!claimed.rowCount) return;
    if (policy.registryEnabled) {
      try { const plan = await this.preview({ scope: 'registry', action: 'retention' }); if (!plan.blocked && plan.digests?.length) await this.enqueue({ scope: 'registry', action: 'retention' }, null, true); }
      catch { await this.scheduleFailure('registry', null); }
    }
    if (policy.cacheEnabled) for (const host of (await this.pool.query('SELECT id FROM hosts WHERE removed_at IS NULL AND NOT disabled')).rows) {
      if (!this.hub.hasAgent(String(host.id))) continue;
      try { const plan = await this.preview({ scope: 'cache', action: 'retention', hostId: host.id }); if (!plan.blocked && plan.ids?.length) await this.enqueue({ scope: 'cache', action: 'retention', hostId: host.id }, null, true); }
      catch { await this.scheduleFailure('cache', String(host.id)); }
    }
  }
  private async scheduleFailure(scope: string, hostId: string | null) {
    await this.pool.query("INSERT INTO image_cleanup_jobs(id,scope,host_id,automatic,state,payload,error_code) VALUES($1,$2,$3,true,'failed','{}','cleanup_failed')", [randomUUID(), scope, hostId]);
  }
  start() { if (!this.stopped) return () => this.stop(); this.stopped = false; const tick = async () => { try { await this.poll(); } catch { } if (!this.stopped) { this.timer = setTimeout(() => void tick(), 5000); this.timer.unref(); } }; void tick(); return () => this.stop(); }
  async stop() { this.stopped = true; clearTimeout(this.timer); await this.flight; }
}
