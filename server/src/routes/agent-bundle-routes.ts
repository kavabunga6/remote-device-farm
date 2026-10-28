import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Express } from 'express';
import type { ServerContext } from '../server-context.js';
import { ApiError, route } from '../http-common.js';
import { uiMessage } from '../messages.js';

type AgentBundle = { bytes: Buffer; filename: string; version: string; sha256: string };

/** Packages contain only distribution files; credential endpoints remain authenticated. */
export function registerAgentBundleRoutes(app: Express, context: Pick<ServerContext, 'requireAuth' | 'requireAdmin'>, directory = path.resolve(process.cwd(), 'agent-bundle')) {
  const { requireAuth, requireAdmin } = context;
  let pending: Promise<AgentBundle> | undefined;
  async function readBundle(): Promise<AgentBundle> {
    try {
      const version = (await readFile(path.join(directory, 'version.txt'), 'utf8')).trim();
      const sha256 = (await readFile(path.join(directory, 'sha256.txt'), 'utf8')).trim();
      if (!/^[A-Za-z0-9._-]{1,80}$/.test(version) || !/^[a-f0-9]{64}$/.test(sha256)) throw new Error();
      const filename = `rdf-linux-agent-${version}.tar.gz`;
      const bytes = await readFile(path.join(directory, filename));
      if (createHash('sha256').update(bytes).digest('hex') !== sha256) throw new Error();
      return { bytes, filename, version, sha256 };
    } catch { throw new ApiError(503, 'agent_bundle_unavailable', uiMessage('ui.4099726074e3', {}, 'en')); }
  }
  // One bounded package per server process; failed reads can be retried after repair.
  const bundle = () => pending ??= readBundle().catch(error => { pending = undefined; throw error; });
  const info = route(async (_req, res) => {
    const item = await bundle();
    res.set('Cache-Control', 'public, max-age=0, must-revalidate');
    res.json({ version: item.version, filename: item.filename, sha256: item.sha256, sizeBytes: item.bytes.length });
  });
  const download = route(async (_req, res) => {
    const item = await bundle();
    res.set('Content-Disposition', `attachment; filename="${item.filename}"`);
    res.set('Cache-Control', 'public, max-age=0, must-revalidate');
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('ETag', `"${item.sha256}"`);
    res.type('application/gzip').send(item.bytes);
  });
  app.get('/api/downloads/agent/info', info);
  app.get('/api/downloads/agent', download);
  // Compatibility aliases for existing authenticated clients.
  app.get('/api/admin/agent-bundle/info', requireAuth, requireAdmin, info);
  app.get('/api/admin/agent-bundle', requireAuth, requireAdmin, download);
}
