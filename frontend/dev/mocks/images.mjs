// Image catalog of the image builder node: Google system images, builds with progress, registry settings.
const IMAGES = [
  [36, '16', 'google_apis_playstore', 'phone', 'google_play'], [36, '16', 'google_apis', 'phone', 'google_apis'], [36, '16', 'default', 'phone', 'aosp'],
  [35, '15', 'google_apis_playstore', 'phone', 'google_play'], [35, '15', 'google_apis', 'phone', 'google_apis'],
  [34, '14', 'google_apis_playstore', 'phone', 'google_play'], [34, '14', 'google_apis', 'phone', 'google_apis'], [34, '14', 'google-tv', 'tv', 'google_play'],
  [34, '14', 'android-automotive-playstore', 'automotive', 'google_play'], [33, '13', 'android-tv', 'tv', 'aosp'], [33, '13', 'android-wear', 'wear', 'google_play'],
  [30, '11', 'google_apis', 'phone', 'google_apis'], [30, '11', 'default', 'phone', 'aosp'],
].map(([api, androidVersion, tag, device, flavor]) => ({
  package: `system-images;android-${api};${tag};x86_64`, tag: `${api}-${tag}-x86_64`, api, minor: null, androidVersion, device, flavor, abi: 'x86_64', systemTag: tag,
}));

function initial() {
  return {
    registry: { mode: 'builtin', builtinAddress: null, externalAddress: null, externalUsername: null, externalPasswordSet: false },
    builder: null,
    built: new Map([['system-images;android-34;google_apis_playstore;x86_64', { digest: 'sha256:' + 'a'.repeat(64), sizeMb: 3420, update: false }]]),
    jobs: [], prewarm: [],
  };
}

let s = initial();
const readBody = (req) => new Promise((resolve) => {
  let raw = '';
  req.on('data', chunk => { raw += chunk; });
  req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve({}); } });
});

export default function handle(req, res, path, method, state, send) {
  if (!path.startsWith('/admin/registry') && !path.startsWith('/admin/emulator-images') && !/\/image-builder$/.test(path)) return false;
  if (method === 'GET') { respond(req, res, path, method, state, send, null); return true; }
  void readBody(req).then(body => respond(req, res, path, method, state, send, body));
  return true;
}

function respond(req, res, path, method, state, send, body) {
  if (path === '/admin/registry' && method === 'GET') { send(res, 200, { registry: s.registry }); return true; }
  if (path === '/admin/registry' && method === 'PUT') {
    const input = body ?? {};
    for (const key of ['mode', 'builtinAddress', 'externalAddress', 'externalUsername']) if (input[key] !== undefined) s.registry[key] = input[key] || null;
    if (input.externalPassword) s.registry.externalPasswordSet = true;
    send(res, 200, { registry: s.registry }); return true;
  }
  const builder = /^\/admin\/hosts\/([^/]+)\/image-builder$/.exec(path);
  if (builder && method === 'PUT') {
    const host = [state.host].find(item => item?.id === decodeURIComponent(builder[1]));
    s.builder = body?.enabled ? { id: decodeURIComponent(builder[1]), name: host?.name ?? decodeURIComponent(builder[1]) } : null;
    send(res, 200, { ok: true }); return true;
  }
  if (path === '/admin/emulator-images' && method === 'GET') {
    for (const job of s.jobs) {
      if (job.state === 'cancelling') { job.state = 'cancelled'; break; }
      if (job.state === 'queued') { job.state = 'building'; job.progress = { step: 1, steps: 12, percent: null }; break; }
      if (job.state === 'building') {
        job.progress = { step: Math.min(12, job.progress.step + 4), steps: 12, percent: job.progress.step >= 5 ? 64 : null };
        if (job.progress.step >= 12) job.state = 'validating';
        break;
      }
      if (job.state === 'validating') { job.state='pushing';break; }
      if (job.state === 'pushing') { job.state = 'done'; job.digest = 'sha256:' + 'c'.repeat(64); s.built.set(job.package, { digest: job.digest, sizeMb: 3100, update: false, validated:true }); break; }
    }
    const address = s.registry.mode === 'external' ? s.registry.externalAddress : s.registry.builtinAddress;
    send(res, 200, {
      registry: s.registry, builder: s.builder, abi: 'x86_64', refreshedAt: new Date().toISOString(),
      images: s.builder ? IMAGES.map(image => {
        const built = s.built.get(image.package);
        return { ...image, built: Boolean(built), digest: built?.digest ?? null, builtAt: built ? new Date().toISOString() : null, sizeMb: built?.sizeMb ?? null,
          profiles: built ? [{ id: 'emu-' + image.tag, name: 'Android ' + image.androidVersion, enabled: true, current: !built.update }, { id: 'emu-' + image.tag + '-tablet', name: 'Планшет', enabled: true, current: !built.update }] : [],
          validated:Boolean(built?.validated),updateAvailable: Boolean(built?.update) };
      }) : [],
      jobs: address ? s.jobs : [],
    });
    return true;
  }
  if (path === '/admin/emulator-images/prewarm' && method === 'GET') {
    for (const job of s.prewarm) {
      if (job.state === 'queued') job.state = 'pulling';
      else if (job.state === 'pulling') job.state = 'done';
    }
    send(res, 200, { items: s.prewarm }); return true;
  }
  if (path === '/admin/emulator-images/prewarm' && method === 'POST') {
    let queued = 0, skipped = 0;
    for (const image of new Set(state.profiles.filter(profile => profile.enabled !== false).map(profile => profile.image))) {
      if (!image?.includes('@sha256:') || !state.host || state.host.disabled) { skipped++; continue; }
      const existing = s.prewarm.find(job => job.hostId === state.host.id && job.image === image);
      if (existing && ['queued', 'pulling'].includes(existing.state)) { skipped++; continue; }
      const job = { hostId: state.host.id, image, state: 'queued', error: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      if (existing) Object.assign(existing, job); else s.prewarm.unshift(job);
      queued++;
    }
    send(res, 202, { queued, skipped }); return true;
  }
  const cancel = /^\/admin\/emulator-images\/builds\/([^/]+)\/cancel$/.exec(path);
  if (cancel && method === 'POST') {
    const job = s.jobs.find(item => item.id === decodeURIComponent(cancel[1]));
    if (!job || body?.builderHostId !== s.builder?.id) { send(res, 404, { error: { code: 'image_build_not_found', message: 'Сборка на этом узле не найдена.' } }); return true; }
    if (job.state === 'queued') job.state = 'cancelled';
    else if (['building', 'validating', 'pushing'].includes(job.state)) job.state = 'cancelling';
    send(res, 200, { jobs: [job] }); return true;
  }
  if (path === '/admin/emulator-images/builds' && method === 'POST') {
    const jobs = (body?.packages ?? []).map((name, index) => ({ id: `job-${Date.now()}-${index}`, package: name, image: 'farm/rdf-emulator:' + name, state: 'queued', progress: { step: 0, steps: 12, percent: null }, log: [] }));
    s.jobs.unshift(...jobs);
    send(res, 202, { jobs }); return true;
  }
  if (path === '/admin/emulator-images/apply' && method === 'POST') {
    const built = s.built.get(body?.package);
    if (built) built.update = false;
    send(res, 200, { updated: ['emu-x'] }); return true;
  }
  send(res, 404, { error: { code: 'not_found' } });
}
