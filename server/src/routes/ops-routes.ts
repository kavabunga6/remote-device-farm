import { uiMessage } from '../messages.js';
import type { Express } from 'express';
import type { ServerContext } from '../server-context.js';
import { ApiError } from '../http-common.js';
import { collectFamilies, renderMetrics, tokenMatches } from '../metrics.js';
import { computeSummary, startSampler } from '../ops-samples.js';

// Metrics and operations.
export function registerOpsRoutes(app: Express, context: ServerContext): () => Promise<void> {
  const { pool, config, requireAuth, requireAdmin } = context;
  const stopSampler = startSampler(pool, config.opsSampleSeconds);

  app.get('/metrics', (req, res, next) => {
    const token = config.metricsToken;
    if (!token) { next(new ApiError(404, 'not_found', uiMessage('ui.183b873d6248', { p0: req.path }, 'en'))); return; }
    if (!tokenMatches(req.headers.authorization, token)) {
      res.setHeader('WWW-Authenticate', 'Bearer realm="metrics"');
      next(new ApiError(401, 'unauthorized', uiMessage('ui.cc518196cb09', {}, 'en'))); return;
    }
    collectFamilies(pool).then(families => {
      res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.send(renderMetrics(families));
    }).catch(next);
  });

  app.get('/api/admin/ops/summary', requireAuth, requireAdmin, (_req, res, next) => {
    computeSummary(pool).then(summary => { res.setHeader('Cache-Control', 'no-store'); res.json(summary); }).catch(next);
  });
  return stopSampler;
}
