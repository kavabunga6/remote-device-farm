import { createHash } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { IMAGE_REPOSITORY } from './registry.js';

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const TYPES = [
  'application/vnd.docker.distribution.manifest.v2+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.oci.image.index.v1+json',
];
const RETENTION_PREFIX = 'rdf-retain-';
export interface CleanupReferences { repository: string; images: string[]; knownCompletedDigests: string[]; activeSessions: number; recentNodes: number }
export interface Manifest { digest: string; contentType: string; body: string; children: string[] }
export interface CleanupRegistry {
  repositories(): Promise<string[]>;
  tags(): Promise<string[]>;
  resolve(tag: string): Promise<string>;
  manifest(digest: string): Promise<Manifest>;
  retain(tag: string, manifest: Manifest): Promise<void>;
  remove(digest: string): Promise<void>;
}
export interface CleanupPlan {
  repository: string;
  retain: string[];
  remove: string[];
  tags: Record<string, string>;
  references: string[];
  unreconciledTags: Record<string, string>;
  activeSessions: number;
  recentNodes: number;
}

/** Distribution API adapter. It never follows redirects or foreign pagination links. */
export class DistributionRegistry implements CleanupRegistry {
  private readonly base: URL;
  constructor(url: string, private readonly request: typeof fetch = fetch) {
    this.base = new URL(url);
    if (!['http:', 'https:'].includes(this.base.protocol) || this.base.username || this.base.password ||
      this.base.pathname !== '/' || this.base.search || this.base.hash) throw new Error('Registry maintenance URL must be an HTTP(S) origin without credentials or path');
  }

  private async call(path: string, method = 'GET', body?: string, contentType?: string, missing = false): Promise<Response> {
    const response = await this.request(new URL(path, this.base), { method, redirect: 'error', signal: AbortSignal.timeout(30_000),
      headers: { Accept: TYPES.join(', '), ...(contentType ? { 'Content-Type': contentType } : {}) }, body });
    if (!response.ok && !(missing && response.status === 404)) throw new Error(`Registry ${method} failed (${response.status}); nothing further will be deleted`);
    return response;
  }

  private async list(path: string, field: 'repositories' | 'tags'): Promise<string[]> {
    const items: string[] = [];
    const seen = new Set<string>();
    let page = path + '?n=100';
    while (page) {
      if (seen.has(page) || seen.size > 1000) throw new Error('Invalid registry pagination');
      seen.add(page);
      const response = await this.call(page, 'GET', undefined, undefined, field === 'tags');
      if (response.status === 404) return [];
      const data = await response.json() as Record<string, unknown>;
      const values = data[field];
      if (values !== null && (!Array.isArray(values) || values.some(value => typeof value !== 'string'))) throw new Error('Invalid registry list');
      items.push(...(values as string[] | null ?? []));
      const link = response.headers.get('link');
      if (!link) break;
      const match = /^<([^>]+)>;\s*rel="?next"?$/.exec(link);
      if (!match) throw new Error('Invalid registry pagination link');
      const next = new URL(match[1]!, this.base);
      if (next.origin !== this.base.origin || next.pathname !== path) throw new Error('Foreign registry pagination is not permitted');
      page = next.pathname + next.search;
    }
    return [...new Set(items)];
  }

  repositories() { return this.list('/v2/_catalog', 'repositories'); }
  tags() { return this.list(`/v2/${IMAGE_REPOSITORY}/tags/list`, 'tags'); }
  async resolve(tag: string): Promise<string> {
    if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(tag)) throw new Error('Invalid registry tag');
    const response = await this.call(`/v2/${IMAGE_REPOSITORY}/manifests/${tag}`, 'HEAD');
    const digest = response.headers.get('docker-content-digest') ?? '';
    if (!DIGEST.test(digest)) throw new Error('Registry omitted a valid manifest digest');
    return digest;
  }
  async manifest(digest: string): Promise<Manifest> {
    if (!DIGEST.test(digest)) throw new Error('Invalid manifest digest');
    const response = await this.call(`/v2/${IMAGE_REPOSITORY}/manifests/${digest}`);
    const contentType = response.headers.get('content-type')?.split(';')[0] ?? '';
    if (!TYPES.includes(contentType)) throw new Error('Unsupported manifest type; refusing garbage collection');
    const body = await response.text();
    if (Buffer.byteLength(body) > 8 * 1024 * 1024) throw new Error('Registry manifest exceeds size limit');
    const actual = 'sha256:' + createHash('sha256').update(body).digest('hex');
    if (actual !== digest || response.headers.get('docker-content-digest') !== digest) throw new Error('Registry manifest digest mismatch');
    const data = JSON.parse(body) as { schemaVersion?: number; manifests?: Array<{ digest?: string }> };
    if (data.schemaVersion !== 2 || (data.manifests !== undefined && !Array.isArray(data.manifests))) throw new Error('Invalid registry manifest');
    const children = (data.manifests ?? []).map(item => item.digest ?? '');
    if (children.some(value => !DIGEST.test(value))) throw new Error('Invalid child manifest digest');
    return { digest, body, contentType, children };
  }
  async retain(tag: string, manifest: Manifest): Promise<void> {
    await this.call(`/v2/${IMAGE_REPOSITORY}/manifests/${tag}`, 'PUT', manifest.body, manifest.contentType);
    if (await this.resolve(tag) !== manifest.digest) throw new Error('Retention tag verification failed; refusing deletion');
  }
  async remove(digest: string): Promise<void> {
    if (!DIGEST.test(digest)) throw new Error('Invalid manifest digest');
    const response = await this.call(`/v2/${IMAGE_REPOSITORY}/manifests/${digest}`, 'DELETE');
    if (response.status !== 202) throw new Error('Registry did not confirm manifest deletion');
  }
}

/** Resolve every reference before producing a deletion plan. Missing protected images stop the whole operation. */
export async function planRegistryCleanup(registry: CleanupRegistry, refs: CleanupReferences): Promise<CleanupPlan> {
  const repositories = await registry.repositories();
  // Distribution GC is global; do not offer --delete-untagged if another consumer's repository shares this store.
  if (repositories.some(name => name !== IMAGE_REPOSITORY)) throw new Error('The registry contains other repositories; their retention must be managed separately');
  const tags: Record<string, string> = {};
  for (const tag of await registry.tags()) tags[tag] = await registry.resolve(tag);
  const protectedDigests = new Set<string>();
  const pending: string[] = [];
  const completed = new Set(refs.knownCompletedDigests);
  if ([...completed].some(digest => !DIGEST.test(digest))) throw new Error('Invalid completed build digest');
  const unreconciledTags: Record<string, string> = {};
  for (const [tag, digest] of Object.entries(tags)) {
    const retentionTag = tag === RETENTION_PREFIX + digest.slice(7);
    if (!retentionTag && !completed.has(digest)) {
      unreconciledTags[tag] = digest;
      pending.push(digest);
    }
  }
  for (const image of refs.images) {
    const marker = image.lastIndexOf('/' + IMAGE_REPOSITORY);
    if (marker < 0) continue;
    const reference = image.slice(marker + IMAGE_REPOSITORY.length + 1);
    if (!reference.startsWith(':') && !reference.startsWith('@')) continue;
    const pinned = reference.includes('@') ? reference.slice(reference.indexOf('@') + 1) : null;
    if (pinned && !DIGEST.test(pinned)) throw new Error('A protected image has an invalid digest');
    pending.push(pinned ?? await registry.resolve(reference.slice(1)));
  }
  while (pending.length) {
    const digest = pending.pop()!;
    if (protectedDigests.has(digest)) continue;
    if (protectedDigests.size >= 10_000) throw new Error('Manifest graph exceeds safety limit');
    const manifest = await registry.manifest(digest);
    protectedDigests.add(digest);
    // Retain index children too: --delete-untagged must not remove platform manifests.
    pending.push(...manifest.children);
  }
  return { repository: refs.repository, retain: [...protectedDigests].sort(),
    remove: [...new Set(Object.values(tags))].filter(digest => !protectedDigests.has(digest)).sort(), tags,
    references: [...new Set(refs.images)].sort(), unreconciledTags, activeSessions: refs.activeSessions, recentNodes: refs.recentNodes };
}

export async function applyRegistryCleanup(registry: CleanupRegistry, plan: CleanupPlan, maintenance: boolean): Promise<void> {
  if (!maintenance) throw new Error('--apply requires --maintenance: stop API servers and image builders first');
  if (Object.keys(plan.unreconciledTags).length) throw new Error('Unreconciled build tags found. Reconnect every current and former builder and import/acknowledge terminal jobs before maintenance; no manifests were deleted');
  if (plan.activeSessions || plan.recentNodes) throw new Error('Stop active sessions and writers, then wait at least 90 seconds for node heartbeats to expire');
  // Every protected manifest receives a tag before any deletion, including profiles pinned to old builds.
  for (const digest of plan.retain) await registry.retain(RETENTION_PREFIX + digest.slice(7), await registry.manifest(digest));
  for (const digest of plan.remove) {
    if (plan.retain.includes(digest)) throw new Error('Refusing to delete a protected manifest');
    await registry.remove(digest);
  }
}

export async function cleanupReferences(client: Pick<PoolClient, 'query'>): Promise<CleanupReferences> {
  const settings = (await client.query('SELECT mode,builtin_address FROM registry_settings WHERE id')).rows[0];
  if (settings?.mode !== 'builtin' || !settings.builtin_address) throw new Error('Cleanup supports the configured built-in registry only');
  const repository = `${settings.builtin_address}/${IMAGE_REPOSITORY}`;
  const rows = (await client.query(`SELECT image FROM profiles WHERE removed_at IS NULL OR id IN
      (SELECT profile_id FROM sessions WHERE state IN ('starting','running','stopping'))
    UNION SELECT launch_image AS image FROM sessions WHERE state IN ('starting','running','stopping') AND launch_image IS NOT NULL
    UNION SELECT repository || ':' || tag || '@' || digest AS image FROM emulator_images
    UNION SELECT image FROM image_prewarm_jobs WHERE state IN ('queued','pulling')`)).rows;
  const completed = (await client.query(`SELECT digest FROM emulator_image_job_receipts WHERE repository=$1 AND state='done' AND digest IS NOT NULL
    UNION SELECT digest FROM emulator_images WHERE repository=$1`, [repository])).rows;
  const activeSessions = Number((await client.query("SELECT count(*) AS count FROM sessions WHERE state IN ('starting','running','stopping')")).rows[0]?.count ?? 0);
  const recentNodes = Number((await client.query("SELECT count(*) AS count FROM hosts WHERE removed_at IS NULL AND last_seen_at > now() - interval '90 seconds'")).rows[0]?.count ?? 0);
  return { repository, images: rows.map(row => String(row.image)), knownCompletedDigests: completed.map(row => String(row.digest)), activeSessions, recentNodes };
}

export async function registryCleanupCli(argv = process.argv.slice(2), env = process.env): Promise<void> {
  if (argv.some(arg => !['--dry-run', '--apply', '--maintenance'].includes(arg)) || (argv.includes('--apply') && argv.includes('--dry-run'))) throw new Error('Usage: registry-cleanup [--dry-run | --apply --maintenance]');
  const apply = argv.includes('--apply');
  if (apply && !argv.includes('--maintenance')) throw new Error('--apply requires --maintenance');
  if (!env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  // Run from an isolated server one-shot container on the Compose network. No bypass is exposed to the host.
  const registry = new DistributionRegistry(env.RDF_REGISTRY_MAINTENANCE_URL || 'http://registry:5000');
  const pool = new Pool({ connectionString: env.DATABASE_URL, max: 1 });
  let client: PoolClient | undefined;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout='5s'");
    // Shares the prewarm claim lock: a maintenance plan cannot race a new cache-pull lease.
    const lock = await client.query('SELECT pg_try_advisory_xact_lock(649736218) AS acquired');
    if (!lock.rows[0]?.acquired) throw new Error('Another registry cleanup is already running');
    if (apply) await client.query('LOCK TABLE profiles,sessions,emulator_images,image_prewarm_jobs,hosts,registry_settings IN SHARE MODE');
    const refs = await cleanupReferences(client);
    const plan = await planRegistryCleanup(registry, refs);
    console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', ...plan }, null, 2));
    if (apply) {
      await applyRegistryCleanup(registry, plan, true);
      console.log('Manifests prepared. Keep writers stopped, stop the registry or enable read-only mode, back up registry_data, then run distribution garbage-collect. Only add --delete-untagged after separately verifying that every current and former builder has no active builds and every terminal build was imported/acknowledged. This CLI cannot verify offline agent ledgers. Do not run global GC on a shared registry.');
    }
    await client.query('COMMIT');
  } catch (error) {
    await client?.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client?.release(); await pool.end(); }
}

if (process.argv[1] && /(?:^|[\\/])registry-cleanup\.(?:ts|js)$/.test(process.argv[1])) {
  registryCleanupCli().catch(error => { console.error(error instanceof Error ? error.message : 'Registry cleanup failed'); process.exitCode = 1; });
}
