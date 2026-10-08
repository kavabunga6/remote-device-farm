import { uiMessage } from '../messages.js';
import { completeImageCheck } from '../image-readiness.js';
import type { Express } from 'express';
import type { Pool } from 'pg';
import type { AgentHub } from '../agent.js';
import type { ServerContext } from '../server-context.js';
import { ImageBuildWorker, type AgentJob } from '../image-build-worker.js';
import { ApiError, route } from '../http-common.js';
import { transaction } from '../db.js';
import { recordAuditEvent } from '../audit.js';
import { getSecretBox } from '../secrets.js';
import { IMAGE_REPOSITORY, activeAddress, authorizeRegistryRequest, readRegistrySettings, registryAuthFor, updateRegistrySettings } from '../registry.js';

export async function builderHost(pool: Pool, hub: Pick<AgentHub, 'hasAgent'>, auto = false): Promise<{ id: string; name: string } | null> {
  const existing = (await pool.query(`SELECT id, coalesce(display_name, name) AS name FROM hosts WHERE image_builder AND removed_at IS NULL LIMIT 1`)).rows[0];
  if (existing) return { id: String(existing.id), name: String(existing.name) };
  if (!auto) return null;
  return transaction(pool, async client => {
    await client.query('SELECT pg_advisory_xact_lock(649736217)');
    const selected = (await client.query(`SELECT id, coalesce(display_name, name) AS name FROM hosts WHERE image_builder AND removed_at IS NULL LIMIT 1`)).rows[0];
    if (selected) return { id: String(selected.id), name: String(selected.name) };
    const { rows } = await client.query(`SELECT id, coalesce(display_name, name) AS name FROM hosts
      WHERE removed_at IS NULL AND NOT disabled AND metrics->>'kvm'='true'
      AND metrics->>'architecture' IN ('x64','arm64') AND last_seen_at > now() - interval '60 seconds'`);
    const candidates = rows.filter(row => hub.hasAgent(String(row.id)));
    if (candidates.length !== 1) return null;
    const host = candidates[0]!;
    await client.query('UPDATE hosts SET image_builder=true WHERE id=$1', [host.id]);
    return { id: String(host.id), name: String(host.name) };
  });
}

export function registerImageRoutes(app: Express, context: ServerContext, worker = new ImageBuildWorker(context.pool, context.hub, context.config.secretsKey)): void {
  const { pool, config, hub, requireAuth, requireAdmin, current } = context;

  // nginx auth_request for the built-in registry under /v2/ (see frontend/nginx.conf).
  app.get('/api/registry/auth', route(async (req, res) => {
    const status = await authorizeRegistryRequest(pool, req.get('authorization'), String(req.get('x-original-method') || 'GET').toUpperCase());
    if (status === 401) res.set('WWW-Authenticate', 'Basic realm="Remote Device Farm registry"');
    res.status(status).end();
  }));

  app.get('/api/admin/registry', requireAuth, requireAdmin, route(async (_req, res) => {
    res.json({ registry: await readRegistrySettings(pool) });
  }));
  app.put('/api/admin/registry', requireAuth, requireAdmin, route(async (req, res) => {
    const registry = await updateRegistrySettings(pool, await getSecretBox(pool, config.secretsKey), (req.body ?? {}) as Record<string, unknown>);
    await recordAuditEvent(pool, { action: 'registry.updated', actor: current(res).user, targetType: 'registry', targetId: registry.mode }).catch(() => {});
    res.json({ registry });
  }));

  app.put('/api/admin/hosts/:id/image-builder', requireAuth, requireAdmin, route(async (req, res) => {
    const enabled = req.body?.enabled === true;
    await transaction(pool, async client => {
      await client.query('SELECT pg_advisory_xact_lock(649736217)');
      const host = await client.query('SELECT id FROM hosts WHERE id=$1 AND removed_at IS NULL FOR UPDATE', [req.params.id]);
      if (!host.rowCount) throw new ApiError(404, 'not_found', uiMessage('ui.aa0a65c4fcfd', {}, 'en'));
      if (enabled) await client.query('UPDATE hosts SET image_builder=false WHERE image_builder AND id<>$1', [req.params.id]);
      await client.query('UPDATE hosts SET image_builder=$2 WHERE id=$1', [req.params.id, enabled]);
    });
    res.json({ ok: true, builder: enabled ? req.params.id : null });
  }));

  async function profilesByImage(): Promise<Map<string, Array<{ id: string; name: string; enabled: boolean; current: boolean }>>> {
    const images = await pool.query('SELECT * FROM emulator_images');
    const profiles = await pool.query(`SELECT id,name,enabled,image FROM profiles WHERE removed_at IS NULL AND id NOT LIKE 'device-%'`);
    const result = new Map<string, Array<{ id: string; name: string; enabled: boolean; current: boolean }>>();
    for (const image of images.rows) {
      const base = `${image.repository}:${image.tag}`;
      result.set(`${image.repository}|${image.package}`, profiles.rows
        .filter(row => String(row.image).startsWith(base + '@') || String(row.image) === base)
        .map(row => ({ id: String(row.id), name: String(row.name), enabled: row.enabled === true, current: String(row.image) === `${base}@${image.digest}` })));
    }
    return result;
  }

  app.get('/api/admin/emulator-images', requireAuth, requireAdmin, route(async (req, res) => {
    const registry = await readRegistrySettings(pool);
    const builder = await builderHost(pool, hub, config.autoImageBuilder);
    if (!builder) { res.json({ registry, builder: null, images: [], jobs: [] }); return; }
    const catalog = await hub.command(builder.id, builder.id, 'emulator-catalog', { refresh: req.query.refresh === '1' }, 15 * 60_000) as { abi?: string; refreshedAt?: string; images?: Array<Record<string, unknown>>; jobs?: AgentJob[] };
    await worker.recordJobs(catalog.jobs ?? [], builder.id);
    const address = activeAddress(registry);
    const repository = address ? `${address}/${IMAGE_REPOSITORY}` : null;
    const built = repository ? (await pool.query('SELECT * FROM emulator_images WHERE repository=$1', [repository])).rows : [];
    const profiles = await profilesByImage();
    res.json({
      registry, builder, abi: catalog.abi, refreshedAt: catalog.refreshedAt,
      images: (catalog.images ?? []).map(image => {
        const row = built.find(item => item.package === image.package);
        const linked = row ? profiles.get(`${row.repository}|${row.package}`) ?? [] : [];
        return { ...image, built: Boolean(row), digest: row?.digest ?? null, builtAt: row?.built_at ?? null, sizeMb: row?.size_mb ?? null,
          validated:completeImageCheck(row?.validation), profiles: linked, updateAvailable: linked.some(profile => !profile.current) };
      }),
      jobs: catalog.jobs ?? [],
    });
  }));

  app.post('/api/admin/emulator-images/builds', requireAuth, requireAdmin, route(async (req, res) => {
    if ((await pool.query("SELECT 1 FROM image_cleanup_jobs WHERE scope='registry' AND state IN ('queued','running') LIMIT 1")).rowCount) throw new ApiError(409, 'image_maintenance', uiMessage('images.error.image_maintenance'));
    const packages = req.body?.packages;
    if (!Array.isArray(packages) || !packages.length || packages.length > 50 || packages.some(item => typeof item !== 'string' || item.length > 120)) {
      throw new ApiError(400, 'invalid_build', uiMessage('ui.3a073dc149ec', {}, 'en'));
    }
    const builder = await builderHost(pool, hub, config.autoImageBuilder);
    if (!builder) throw new ApiError(409, 'no_image_builder', uiMessage('ui.51073b594baa', {}, 'en'));
    const address = activeAddress(await readRegistrySettings(pool));
    if (!address) throw new ApiError(409, 'registry_not_configured', uiMessage('ui.bd7912b42362', {}, 'en'));
    const repository = `${address}/${IMAGE_REPOSITORY}`;
    const auth = await registryAuthFor(pool, await getSecretBox(pool, config.secretsKey), repository, 'push', builder.id);
    if (!auth) throw new ApiError(409, 'registry_not_configured', uiMessage('ui.15558d622182', {}, 'en'));
    const result = await hub.command(builder.id, builder.id, 'emulator-build', { packages, target: { repository, auth } }, 60_000);
    await recordAuditEvent(pool, { action: 'emulator_image.build_requested', actor: current(res).user, targetType: 'host', targetId: builder.id }).catch(() => {});
    res.status(202).json(result);
  }));

  app.post('/api/admin/emulator-images/builds/:jobId/cancel', requireAuth, requireAdmin, route(async (req, res) => {
    const jobId = req.params.jobId!;
    const hostId = req.body?.builderHostId;
    if (!/^[A-Za-z0-9-]{1,64}$/.test(jobId) || typeof hostId !== 'string' ||
        !hostId.length || hostId.length > 200 || hostId.trim() !== hostId || /[\x00-\x1f\x7f]/.test(hostId)) {
      throw new ApiError(400, 'invalid_build_cancel', uiMessage('ui.836de7d8cb7f', {}, 'en'));
    }
    // The catalog snapshot owns this host/job pair. Never switch a cancellation
    // to the currently selected builder after the administrator changes it.
    const host = await pool.query('SELECT id FROM hosts WHERE id=$1 AND removed_at IS NULL', [hostId]);
    if (!host.rowCount) throw new ApiError(404, 'not_found', uiMessage('ui.aa0a65c4fcfd', {}, 'en'));
    if (!hub.hasAgent(hostId)) throw new ApiError(409, 'agent_offline', uiMessage('ui.5d8d8846b76f', {}, 'en'));
    let result: Record<string, unknown>;
    try {
      result = await hub.command(hostId, hostId, 'emulator-cancel', { jobId }, 30_000);
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      if (message === 'Emulator build job not found') throw new ApiError(404, 'image_build_not_found', uiMessage('ui.b8e9c4ee4ceb', {}, 'en'));
      if (message === 'Invalid emulator build job ID') throw new ApiError(400, 'invalid_build_cancel', uiMessage('ui.898e8f7a1684', {}, 'en'));
      if (message === 'agent offline' || message === 'agent disconnected') throw new ApiError(409, 'agent_offline', uiMessage('ui.5d8d8846b76f', {}, 'en'));
      if (message === 'agent command timed out') throw new ApiError(504, 'agent_timeout', uiMessage('ui.85dbe00ec0ae', {}, 'en'));
      throw new ApiError(502, 'image_build_cancel_failed', uiMessage('ui.c2764d4b9302', {}, 'en'));
    }
    const jobs = Array.isArray(result.jobs) ? (result.jobs as AgentJob[]).filter(job => job?.id === jobId) : [];
    if (jobs.length !== 1 || !['cancelling', 'cancelled', 'done', 'failed'].includes(jobs[0]!.state)) {
      throw new ApiError(502, 'image_build_cancel_failed', uiMessage('ui.a6384d09b25c', {}, 'en'));
    }
    await recordAuditEvent(pool, { action: 'emulator_image.build_cancel_requested', actor: current(res).user,
      targetType: 'emulator_image_build', targetId: jobId }).catch(() => {});
    res.json({ jobs });
  }));

  /** Moves the profiles of one system image to its newest build (the digest every node will pull). */
  app.post('/api/admin/emulator-images/apply', requireAuth, requireAdmin, route(async (req, res) => {
    const name = typeof req.body?.package === 'string' ? req.body.package : '';
    const address = activeAddress(await readRegistrySettings(pool));
    if (!address) throw new ApiError(409, 'registry_not_configured', uiMessage('ui.bd7912b42362', {}, 'en'));
    const repository = `${address}/${IMAGE_REPOSITORY}`;
    const row = (await pool.query('SELECT * FROM emulator_images WHERE repository=$1 AND package=$2', [repository, name])).rows[0];
    if (!row) throw new ApiError(404, 'not_found', uiMessage('ui.25431857627b', {}, 'en'));
    const base = `${repository}:${row.tag}`;
    const updated = await pool.query(`UPDATE profiles SET image=$1 WHERE removed_at IS NULL AND (image=$2 OR image LIKE $3) AND image<>$1 RETURNING id`,
      [`${base}@${row.digest}`, base, base.replace(/[\\%_]/g, '\\$&') + '@%']);
    for (const profile of updated.rows) await recordAuditEvent(pool, { action: 'profile.image_updated', actor: current(res).user, targetType: 'profile', targetId: String(profile.id) }).catch(() => {});
    res.json({ updated: updated.rows.map(item => String(item.id)) });
  }));
}

