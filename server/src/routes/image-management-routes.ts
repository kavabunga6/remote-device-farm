import type { Express } from 'express';
import type { ServerContext } from '../server-context.js';
import { ImageManagement } from '../image-management.js';
import { ApiError, route } from '../http-common.js';
import { uiMessage } from '../messages.js';
import { assertPermission } from '../permissions.js';
import { recordAuditEvent } from '../audit.js';
export function registerImageManagementRoutes(app: Express, context: ServerContext, manager: ImageManagement) {
  const { requireAuth, requireAdmin, current, pool } = context;
  const body = (value: unknown): Record<string, unknown> => {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['scope', 'action', 'hostId', 'digests', 'ids', 'removeProfiles', 'token', 'registryEnabled', 'registryKeep', 'registryDays', 'cacheEnabled', 'cacheDays', 'cacheMaxGb', 'intervalHours'].includes(key))) throw new ApiError(400, 'invalid_image_management', uiMessage('images.error.invalid'));
    return value as Record<string, unknown>;
  };
  app.get('/api/admin/image-management/registry', requireAuth, requireAdmin, route(async (_req, res) => { res.json(await manager.registryImages()); }));
  app.get('/api/admin/image-management/cache/:hostId', requireAuth, requireAdmin, route(async (req, res) => { assertPermission(current(res).user, 'nodes.view'); res.json(await manager.cache(req.params.hostId!)); }));
  app.get('/api/admin/image-management/policy', requireAuth, requireAdmin, route(async (_req, res) => { res.json({ policy: await manager.policy() }); }));
  app.put('/api/admin/image-management/policy', requireAuth, requireAdmin, route(async (req, res) => {
    const input = body(req.body);
    if (input.registryEnabled || input.cacheEnabled) assertPermission(current(res).user, 'images.cleanup');
    const policy = await manager.savePolicy(input);
    await recordAuditEvent(pool, { action: 'images.policy_updated', actor: current(res).user, targetType: 'images' }).catch(() => { });
    res.json({ policy });
  }));
  app.get('/api/admin/image-management/jobs', requireAuth, requireAdmin, route(async (_req, res) => { res.json({ items: await manager.jobs() }); }));
  app.post('/api/admin/image-management/preview', requireAuth, requireAdmin, route(async (req, res) => { const input = body(req.body); if (input.scope === 'cache') assertPermission(current(res).user, 'nodes.view'); res.json({ plan: await manager.preview(input) }); }));
  app.post('/api/admin/image-management/jobs', requireAuth, requireAdmin, route(async (req, res) => {
    const input = body(req.body);
    assertPermission(current(res).user, input.scope === 'registry' && input.action === 'delete' ? 'images.delete' : 'images.cleanup');
    res.status(202).json(await manager.enqueue(input, current(res).user.id));
  }));
}
