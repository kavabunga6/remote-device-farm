import { createHash, randomUUID } from 'node:crypto';
const digest = letter => 'sha256:' + letter.repeat(64);
const repo = 'registry.example.test/rdf-emulator';
let policy = { registryEnabled: false, registryKeep: 3, registryDays: 30, cacheEnabled: false, cacheDays: 30, cacheMaxGb: 0, intervalHours: 24 };
let items = ['a', 'b', 'c'].map((letter, index) => ({ digest: digest(letter), tags: index === 0 ? ['36-default-x86_64'] : [], package: 'system-images;android-36;default;x86_64', sizeBytes: 3 * 1024 ** 3, createdAt: '2026-01-0' + (3 - index) + 'T00:00:00Z', children: [], known: true, uses: index === 0 ? [{ kind: 'profile', id: 'a13', name: 'Android 16 · AOSP', image: repo + ':36-default-x86_64@' + digest(letter) }, { kind: 'catalog', id: 'sdk', name: 'sdk', image: repo + '@' + digest(letter) }] : [], blockers: index === 2 ? ['session'] : [] }));
let cache = [{ id: digest('d'), tags: [repo + ':old'], digests: [repo + '@' + digest('b')], package: 'system-images;android-35;default;x86_64', sizeBytes: 3 * 1024 ** 3, firstSeenAt: '2026-01-01T00:00:00Z', lastUsedAt: '2026-02-01T00:00:00Z', uses: [], blockers: [] }], jobs = [];
export default function handle(req, res, path, method, state, send) {
  if (!path.startsWith('/admin/image-management')) return false;
  const respond = body => {
    if (path.endsWith('/registry')) return send(res, 200, { supported: true, repository: repo, items, maintenance: false });
    if (path.includes('/cache/')) return send(res, 200, { hostId: path.split('/').at(-1), items: cache });
    if (path.endsWith('/policy')) { if (method === 'PUT') policy = body; return send(res, 200, { policy }); }
    if (path.endsWith('/preview')) {
      const selected = body.scope === 'registry' ? body.action === 'gc' ? [] : items.filter(item => body.digests ? body.digests.includes(item.digest) : !item.uses.length && !item.blockers.length) : cache.filter(item => body.ids ? body.ids.includes(item.id) : !item.blockers.length);
      const plan = { ...body, items: selected, blocked: selected.some(item => item.blockers.length), token: createHash('sha256').update(JSON.stringify(selected) + body.removeProfiles).digest('hex') };
      return send(res, 200, { plan });
    }
    if (path.endsWith('/jobs')) {
      if (method === 'POST') {
        const selected = body.scope === 'registry' ? items.filter(item => body.digests?.includes(item.digest)) : cache.filter(item => body.ids?.includes(item.id));
        for (const profile of selected.flatMap(item => item.uses)) if (profile.kind === 'profile') { const target = state.profiles.find(item => item.id === profile.id); if (target) { target.enabled = false; if (body.removeProfiles) target.removedAt = new Date().toISOString(); } }
        if (body.scope === 'registry') items = items.filter(item => !body.digests?.includes(item.digest)); else cache = cache.filter(item => !body.ids?.includes(item.id));
        const job = { id: randomUUID(), scope: body.scope, hostId: body.hostId ?? null, state: 'done', stage: 'done', automatic: false, errorCode: null, result: { removed: selected.map(item => item.digest ?? item.id) }, createdAt: new Date().toISOString() }; jobs.unshift(job); return send(res, 202, { id: job.id });
      } return send(res, 200, { items: jobs });
    } send(res, 404, {});
  };
  if (method === 'GET') respond({}); else { let raw = ''; req.on('data', chunk => raw += chunk); req.on('end', () => respond(JSON.parse(raw || '{}'))); }
  return true;
}
