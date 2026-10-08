import { useAccess } from './permissions';
import { getLanguage, localizeText, t, type MessageKey } from './i18n';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, type Host } from './api';
import { Icon } from './icons';
import { ActivityIndicator } from './ActivityIndicator';
import { useAdminDialog } from './useAdminDialog';
import { imagesApi, type BuildJob, type CatalogImage, type ImageCatalog, type ImagePrewarmJob, type RegistrySettings } from './images-api';
import { useNotifications } from './notifications';
import './EmulatorCatalogDialog.css';

const DEVICES: Record<CatalogImage['device'], string> = { get phone() { return t('ui.e5179e680c13'); }, get tv() { return t('ui.8794f1ba68df'); }, get automotive() { return t('ui.8dca2f783130'); }, get wear() { return t('ui.7e6da98020ac'); }, get desktop() { return t('device.desktop'); } };
const FLAVORS: Record<CatalogImage['flavor'], string> = { aosp: 'AOSP', google_apis: 'Google APIs', google_play: 'Google Play' };
const PREWARM_LABELS: Record<ImagePrewarmJob['state'], string> = { get queued() { return t('ui.b22a2454bd69'); }, get pulling() { return t('ui.a1d278794b00'); }, get done() { return t('ui.d7638391d8f0'); }, get failed() { return t('ui.bd54852c0848'); } };
const BUILD_ERRORS = new Set(['build_disk_reserve', 'build_memory_reserve', 'build_host_pressure', 'build_metrics_unavailable', 'build_worker_unavailable', 'build_cache_ownership', 'build_cleanup_failed', 'build_busy']);
const buildError = (job: BuildJob) => job.errorCode && BUILD_ERRORS.has(job.errorCode) ? t(('images.error.' + job.errorCode) as MessageKey) : localizeText(job.error ?? '');
const CANCELLABLE: BuildJob['state'][] = ['queued', 'building', 'validating', 'pushing'];
const ACTIVE: BuildJob['state'][] = [...CANCELLABLE, 'cancelling'];
const isActive = (job: BuildJob | undefined) => Boolean(job && ACTIVE.includes(job.state));

function jobLabel(job: BuildJob): string {
  if (job.state === 'queued') return t('ui.b22a2454bd69');
  if (job.state === 'validating') return t('ui.1cea37d373ed');
  if (job.state === 'pushing') return t('ui.cc1d788a5fae');
  if (job.state === 'cancelling') return t('ui.546ea337315e');
  if (job.state === 'cancelled') return t('ui.0823a590adb7');
  if (job.state === 'failed') return t('ui.9641c283e58a');
  if (job.state === 'done') return t('ui.aebfbdcacbcf');
  const step = job.progress?.steps ? t('ui.146ce47d22f0', { p0: job.progress.step, p1: job.progress.steps }) : t('ui.af2e97ea3bd5');
  return step + (job.progress?.percent != null ? t('ui.83b6a4e2fc3f', { p0: job.progress.percent }) : '');
}

const systemTag = (image: CatalogImage) => image.package.split(';')[2] || image.tag;
const STANDARD_TAGS = new Set(['default', 'google_apis', 'google_apis_playstore', 'android-tv', 'google-tv', 'android-automotive', 'android-automotive-playstore', 'android-wear', 'android-wear-signed', 'android-desktop']);
// ATD purpose and rendering limits: https://developer.android.com/studio/test/managed-devices#use-automated-test-devices
const isAtd = (image: CatalogImage) => ['aosp_atd', 'google_atd'].includes(systemTag(image));
const imageName = (image: CatalogImage) => {
  const tag = systemTag(image);
  const variant = tag === 'aosp_atd' ? 'AOSP ATD' : tag === 'google_atd' ? 'Google APIs ATD'
    : FLAVORS[image.flavor] + (STANDARD_TAGS.has(tag) ? '' : ` · ${tag}`);
  return `Android ${image.androidVersion} · ${variant}` + (image.device === 'phone' ? '' : ` · ${DEVICES[image.device]}`)
    + (image.minor != null ? ` · API ${image.api}.${image.minor}` : '');
};

/**
 * Google emulator images for the farm. One node (the image builder) builds each image once and pushes it to the
 * registry; profiles point at that exact digest, so every node runs the same build.
 */
export function EmulatorCatalogDialog({ onClose, onChanged }: { onClose: () => void; onChanged: () => void }) {
  const can = useAccess();
  const { notify, notifyError } = useNotifications();
  const [prewarmJobs, setPrewarmJobs] = useState<ImagePrewarmJob[]>([]);
  const [catalog, setCatalog] = useState<ImageCatalog | null>(null);
  const [hosts, setHosts] = useState<Host[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [buildSending, setBuildSending] = useState(false);
  const buildInFlight = useRef(false);
  const cancelInFlight = useRef(new Set<string>());
  const [cancelSending, setCancelSending] = useState(new Set<string>());
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [filters, setFilters] = useState({ android: '', device: '', flavor: '', state: '' });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [draft, setDraft] = useState<Partial<RegistrySettings> & { externalPassword?: string }>({});
  const dialogRef = useAdminDialog(true, busy, onClose);
  const doneJobs = useRef<Set<string> | null>(null);
  const loadInFlight = useRef<Promise<void> | null>(null);
  const loadGeneration = useRef(0);
  const loadQueued = useRef(false);
  const refreshQueued = useRef(false);
  const changed = useRef(onChanged);
  changed.current = onChanged;

  const load = useCallback(function loadCatalog(refresh = false, afterMutation = false): Promise<void> {
    if (afterMutation) loadGeneration.current++;
    if (loadInFlight.current) {
      // Polls share one request. A mutation or manual refresh gets one fresh request after it.
      if (afterMutation || refresh) loadQueued.current = true;
      refreshQueued.current ||= refresh;
      return loadInFlight.current;
    }
    const generation = loadGeneration.current;
    loadQueued.current = false;
    refresh = refresh || refreshQueued.current;
    refreshQueued.current = false;
    setError('');
    const request = (async () => {
      try {
        const [next, nodes, prewarm] = await Promise.all([imagesApi.catalog(refresh), api.hosts(), imagesApi.prewarmJobs()]);
        // A GET sent before an accepted mutation must not erase the jobs returned by its POST.
        if (generation !== loadGeneration.current) return;
        setPrewarmJobs(prewarm.items);
        const done = new Set(next.jobs.filter(job => job.state === 'done').map(job => job.id));
        if (doneJobs.current && [...done].some(id => !doneJobs.current!.has(id))) changed.current();
        doneJobs.current = done;
        setCatalog(next);
        setHosts(nodes);
        if (!next.builder || !(next.registry.mode === 'external' ? next.registry.externalAddress : next.registry.builtinAddress)) setSettingsOpen(true);
      } catch (cause) {
        if (generation === loadGeneration.current) setError(cause instanceof Error ? cause.message : t('ui.2998ba4c2a5c'));
      } finally {
        if (generation === loadGeneration.current) setLoading(false);
        loadInFlight.current = null;
        if (loadQueued.current) void loadCatalog();
      }
    })();
    loadInFlight.current = request;
    return request;
  }, []);

  useEffect(() => { void load(); }, [load]);
  const building = Boolean(catalog?.jobs.some(job => ACTIVE.includes(job.state)));
  const downloading = prewarmJobs.some(job => job.state === 'queued' || job.state === 'pulling');
  useEffect(() => {
    if (!building && !downloading) return;
    const timer = window.setInterval(() => void load(), 4000);
    return () => window.clearInterval(timer);
  }, [building, downloading, load]);

  const jobsByPackage = useMemo(() => {
    const map = new Map<string, BuildJob>();
    for (const job of catalog?.jobs ?? []) if (!map.has(job.package)) map.set(job.package, job);
    return map;
  }, [catalog, getLanguage()]);
  const versions = useMemo(() => [...new Set((catalog?.images ?? []).map(image => image.androidVersion))], [catalog, getLanguage()]);
  const visible = (catalog?.images ?? []).filter(image => (!filters.android || image.androidVersion === filters.android)
    && (!filters.device || image.device === filters.device) && (!filters.flavor || image.flavor === filters.flavor)
    && (!filters.state || (filters.state === 'active' ? isActive(jobsByPackage.get(image.package))
      : filters.state === 'failed' ? jobsByPackage.get(image.package)?.state === 'failed'
        : filters.state === 'cancelled' ? jobsByPackage.get(image.package)?.state === 'cancelled'
          : filters.state === 'built' ? image.built : !image.built)));

  const registry = catalog?.registry;
  const address = registry ? (registry.mode === 'external' ? registry.externalAddress : registry.builtinAddress) : null;
  const ready = Boolean(catalog?.builder && address);

  const toggle = (name: string) => setSelected(previous => {
    const next = new Set(previous);
    if (next.has(name)) next.delete(name); else next.add(name);
    return next;
  });
  const build = async () => {
    if (buildInFlight.current || busy || !ready || !selected.size) return;
    buildInFlight.current = true;
    setBuildSending(true); setBusy(true); setError('');
    try {
      const { jobs } = await imagesApi.build([...selected]);
      // Show the accepted jobs immediately; refreshing the SDK catalog can take minutes.
      setCatalog(previous => previous ? { ...previous, jobs: [...jobs, ...previous.jobs.filter(job => !jobs.some(next => next.id === job.id))] } : previous);
      setSelected(new Set());
      notify({ kind: 'success', title: t('ui.b53fbcc36019'), message: t('ui.e17e148c3973', { p0: jobs.length }), key: 'image-build', allowInModal: true });
      setLoading(false);
      void load(false, true);
    } catch (cause) { setError(cause instanceof Error ? cause.message : t('ui.3c8a4983f3b6')); }
    finally { buildInFlight.current = false; setBuildSending(false); setBusy(false); }
  };
  const cancelBuild = async (job: BuildJob) => {
    const builderHostId = catalog?.builder?.id;
    const key = `${builderHostId}:${job.id}`;
    if (!builderHostId || busy || !CANCELLABLE.includes(job.state) || cancelInFlight.current.has(key)) return;
    cancelInFlight.current.add(key);
    setCancelSending(new Set(cancelInFlight.current));
    try {
      const { jobs } = await imagesApi.cancelBuild(job.id, builderHostId);
      const updated = jobs.find(item => item.id === job.id);
      if (!updated) throw new Error(t('ui.5d1c2fcc73d8'));
      // Update only this job: parallel cancellations can return snapshots in a different order.
      setCatalog(previous => previous?.builder?.id === builderHostId
        ? { ...previous, jobs: previous.jobs.map(item => item.id === job.id ? updated : item) } : previous);
      notify({ kind: updated.state === 'cancelled' ? 'success' : 'info',
        title: updated.state === 'cancelled' ? t('ui.0823a590adb7') : updated.state === 'cancelling' ? t('ui.1baaacca93fa') : t('ui.2d863a886dbd'),
        message: updated.state === 'cancelling' ? t('ui.cea38c50910b') : jobLabel(updated),
        key: `image-cancel:${key}`, allowInModal: true });
      void load(false, true);
    } catch (cause) { notifyError(t('ui.7b07a6c5a322'), cause); }
    finally {
      cancelInFlight.current.delete(key);
      setCancelSending(new Set(cancelInFlight.current));
    }
  };
  const copyPackage = async (image: CatalogImage) => {
    try {
      await navigator.clipboard.writeText(image.package);
      notify({ kind: 'success', title: t('ui.59f4bec35373'), key: 'image-package-copy', allowInModal: true });
    } catch { notify({ kind: 'error', title: t('ui.f400e0b540f3'), message: t('ui.9e1443f4cd7d'), key: 'image-package-copy', allowInModal: true }); }
  };
  const prewarm = async () => {
    setBusy(true);
    try {
      const result = await imagesApi.prewarm();
      notify({ kind: result.queued ? 'success' : 'info', title: result.queued ? t('ui.259dbd34685d') : t('ui.fca6f7cdb25f'),
        message: t('ui.beea065aa184', { p0: result.queued, p1: result.skipped }), key: 'image-prewarm', allowInModal: true });
      await load(false, true);
    } catch (cause) { notifyError(t('ui.1af056ffacba'), cause); }
    finally { setBusy(false); }
  };
  const apply = async (image: CatalogImage) => {
    setBusy(true); setError('');
    try { await imagesApi.apply(image.package); onChanged(); await load(false, true); }
    catch (cause) { setError(cause instanceof Error ? cause.message : t('ui.2622eab22d1f')); }
    finally { setBusy(false); }
  };
  const saveSettings = async (builderId: string | null) => {
    setBusy(true); setError('');
    try {
      if (builderId !== (catalog?.builder?.id ?? null)) {
        if (builderId) await imagesApi.setBuilder(builderId, true);
        else if (catalog?.builder) await imagesApi.setBuilder(catalog.builder.id, false);
      }
      if (Object.keys(draft).length) {
        const input = { ...draft };
        if (input.externalPassword === '') delete input.externalPassword;
        await imagesApi.saveRegistry(input);
        setDraft({});
      }
      setLoading(true);
      await load(false, true);
    } catch (cause) { setError(cause instanceof Error ? cause.message : t('ui.4ec119c197d7')); }
    finally { setBusy(false); }
  };

  const [builderChoice, setBuilderChoice] = useState<string | null>(null);
  const builderId = builderChoice ?? catalog?.builder?.id ?? '';
  const mode = draft.mode ?? registry?.mode ?? 'builtin';

  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <div className="modal emulator-catalog" ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="emulator-catalog-heading">
      <div className="modal-top"><div><h2 id="emulator-catalog-heading">{t('ui.fc2f4f308632')}</h2>
        <p className="modal-description">{t('ui.582601d6fa53')}</p></div>
        <button type="button" className="icon-button" aria-label={t('ui.a7a4033657e8')} onClick={onClose} disabled={busy}><Icon name="close" size={19}/></button></div>

      <div className="emulator-catalog-body">
        <details className="emulator-catalog-settings" open={settingsOpen} onToggle={event => setSettingsOpen((event.currentTarget as HTMLDetailsElement).open)}>
          <summary>
            <strong>{t('ui.8d88e2cb8ebe')}</strong>
            <span>{catalog?.builder ? catalog.builder.name : t('ui.3e1e0b99ea1f')} · {address || t('ui.cf144f4e209c')}</span>
            <Icon name="arrowDown" size={14}/>
          </summary>
          <div className="emulator-catalog-settings-content">
            <section className="emulator-catalog-settings-section" aria-labelledby="catalog-builder-heading">
              <h3 id="catalog-builder-heading">{t('ui.87fcd6a540f5')}</h3>
              <label className="emulator-catalog-field">
                <span className="emulator-catalog-visually-hidden">{t('ui.12811c165728')}</span>
                <select value={builderId} onChange={event => setBuilderChoice(event.target.value)} disabled={busy || !can('images.settings')} aria-describedby="catalog-builder-hint">
                  <option value="">{t('ui.556a85dee7b9')}</option>
                  {hosts.map(host => <option key={host.id} value={host.id}>{host.name}{host.status !== 'online' ? t('ui.3a15aca6d144') : ''}</option>)}
                </select>
                <small id="catalog-builder-hint">{t('ui.1ff49797047f')}</small>
              </label>
            </section>
            <section className="emulator-catalog-settings-section" aria-labelledby="catalog-storage-heading">
              <h3 id="catalog-storage-heading">{t('ui.f8f37144a47b')}</h3>
              <div className="emulator-catalog-storage-fields">
                <fieldset className="emulator-catalog-mode">
                  <legend className="emulator-catalog-visually-hidden">{t('ui.f6d186617f48')}</legend>
                  <label className="emulator-catalog-choice"><input type="radio" name="registry-mode" value="builtin" checked={mode === 'builtin'} onChange={() => setDraft(value => ({ ...value, mode: 'builtin' }))} disabled={busy || !can('images.settings')}/><span>{t('ui.95b3e0a7c357')}</span></label>
                  <label className="emulator-catalog-choice"><input type="radio" name="registry-mode" value="external" checked={mode === 'external'} onChange={() => setDraft(value => ({ ...value, mode: 'external' }))} disabled={busy || !can('images.settings')}/><span>{t('ui.f466c9b7dca2')}</span></label>
                </fieldset>
                {mode === 'builtin' ? <label className="emulator-catalog-field">
                  <span>{t('ui.9cab7b8c4206')}</span>
                  <input value={draft.builtinAddress ?? registry?.builtinAddress ?? ''} placeholder={t('ui.d3cd705fe5c6')} autoCapitalize="none" spellCheck={false} onChange={event => setDraft(value => ({ ...value, builtinAddress: event.target.value }))} disabled={busy || !can('images.settings')} aria-describedby="catalog-builtin-hint"/>
                  <small id="catalog-builtin-hint">{t('ui.534986179b18')}</small>
                </label> : <>
                  <label className="emulator-catalog-field">
                    <span>{t('ui.3abf567d3a4a')}</span>
                    <input value={draft.externalAddress ?? registry?.externalAddress ?? ''} placeholder={t('ui.8f31de0aed76')} autoCapitalize="none" spellCheck={false} onChange={event => setDraft(value => ({ ...value, externalAddress: event.target.value }))} disabled={busy || !can('images.settings')} aria-describedby="catalog-external-hint"/>
                    <small id="catalog-external-hint">{t('ui.fb7b5dc6124e')}{(draft.externalAddress ?? registry?.externalAddress) || 'registry.company.com/mobile'}{t('ui.85d5a46a915b')}</small>
                  </label>
                  <div className="emulator-catalog-credentials">
                    <label className="emulator-catalog-field"><span>{t('ui.5be12bfe49ea')}</span><input value={draft.externalUsername ?? registry?.externalUsername ?? ''} autoComplete="off" onChange={event => setDraft(value => ({ ...value, externalUsername: event.target.value }))} disabled={busy || !can('images.settings')}/></label>
                    <label className="emulator-catalog-field"><span>{t('ui.e0f39d86f1b0')}</span><input type="password" value={draft.externalPassword ?? ''} autoComplete="new-password" placeholder={registry?.externalPasswordSet ? t('ui.326bb897f09d') : ''} onChange={event => setDraft(value => ({ ...value, externalPassword: event.target.value }))} disabled={busy || !can('images.settings')}/></label>
                  </div>
                </>}
              </div>
            </section>
          </div>
          <div className="emulator-catalog-settings-actions">
            <button type="button" className="button primary small" disabled={busy || !can('images.settings')} onClick={() => void saveSettings(builderId || null)}>{t('ui.d3257f0c9ba3')}</button>
          </div>
        </details>

        <div className="emulator-catalog-prewarm-actions">
          <p id="catalog-prewarm-hint">{t('ui.714df6e7e0c3')}</p>
          <button type="button" className="button outline small" aria-describedby="catalog-prewarm-hint" disabled={!can('images.build') || busy || loading} onClick={() => void prewarm()}><Icon name="download" size={15}/>{t('ui.9a1208de8607')}</button>
        </div>
        {prewarmJobs.length > 0 && <details className="emulator-catalog-prewarm">
          <summary><strong>{t('ui.4d55137380f5')}</strong><span>{prewarmJobs.filter(job => job.state === 'queued' || job.state === 'pulling').length} {t('ui.99e615736d55')}{prewarmJobs.length} {t('ui.7df1979c2188')}</span><Icon name="arrowDown" size={14}/></summary>
          <ul aria-label={t('ui.9a534e232699')}>{prewarmJobs.map(job => <li key={job.hostId + ':' + job.image}>
            <strong>{hosts.find(host => host.id === job.hostId)?.name ?? job.hostId}</strong>
            <div className="emulator-catalog-prewarm-image"><code>{job.image}</code>{job.error && <p className="emulator-catalog-error">{t('ui.57a6688956cc')}</p>}</div>
            <span className="emulator-catalog-prewarm-state" data-state={job.state}>{PREWARM_LABELS[job.state]}</span>
          </li>)}</ul>
        </details>}

        <div className="emulator-catalog-filters">
          <label><span>{t('ui.7b1487ed07ac')}</span><select value={filters.android} onChange={event => setFilters(value => ({ ...value, android: event.target.value }))}><option value="">{t('ui.9796f335ca5b')}</option>{versions.map(version => <option key={version} value={version}>{t('ui.da01b8c0bb42')}{version}</option>)}</select></label>
          <label><span>{t('ui.47ea712ddb7d')}</span><select value={filters.device} onChange={event => setFilters(value => ({ ...value, device: event.target.value }))}><option value="">{t('ui.19161353d3bf')}</option>{Object.entries(DEVICES).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <label><span>{t('ui.c47552ab0170')}</span><select value={filters.flavor} onChange={event => setFilters(value => ({ ...value, flavor: event.target.value }))}><option value="">{t('ui.08865f4d341f')}</option>{Object.entries(FLAVORS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <label><span>{t('ui.ca285db3dd75')}</span><select value={filters.state} onChange={event => setFilters(value => ({ ...value, state: event.target.value }))}><option value="">{t('ui.215816bf4210')}</option><option value="active">{t('ui.59a28f1b11df')}</option><option value="failed">{t('ui.bb095483d8f2')}</option><option value="cancelled">{t('ui.ed3a2d2e787b')}</option><option value="built">{t('ui.26a902cfe456')}</option><option value="missing">{t('ui.56ccc969331d')}</option></select></label>
          <button type="button" className="button outline small" disabled={busy || loading || !catalog?.builder} onClick={() => { setLoading(true); void load(true); }}><Icon name="refresh" size={15}/>{t('ui.163a016f3df7')}</button>
        </div>

        {error && <div className="inline-error" role="alert">{localizeText(error)}</div>}
        {loading ? <div className="emulator-catalog-empty" role="status"><span className="loading-ring" aria-hidden="true"/>{t('ui.58cafd3693a5')}</div>
          : !catalog?.builder ? <div className="emulator-catalog-empty">{t('ui.4d25ee11800a')}</div>
          : !visible.length ? <div className="emulator-catalog-empty">{t('ui.1a1e4991c2e8')}</div>
          : <ul className="emulator-catalog-list" aria-label={t('ui.0627b8d2c490')}>{visible.map(image => {
            const job = jobsByPackage.get(image.package);
            const active = job && ACTIVE.includes(job.state);
            const cancelling = Boolean(job && cancelSending.has(`${catalog?.builder?.id}:${job.id}`));
            const stopping = job?.state === 'cancelling';
            const cancelled = job?.state === 'cancelled';
            return <li key={image.package} className="emulator-catalog-item" data-state={stopping || cancelling ? 'cancelling' : active ? 'building' : cancelled ? 'cancelled' : job?.state === 'failed' ? 'failed' : image.built || job?.state === 'done' ? 'built' : 'missing'}>
              <label className="emulator-catalog-check">
                <input type="checkbox" checked={selected.has(image.package)} disabled={!can('images.build') || busy || !ready || Boolean(active)} onChange={() => toggle(image.package)} aria-label={t('ui.266aa57e010c') + imageName(image)}/>
              </label>
              <div className="emulator-catalog-main">
                <strong>{imageName(image)}</strong>
                <div className="emulator-catalog-badges"><span>{t('ui.3a9af84a6fdf')}{image.api}{image.minor != null ? '.' + image.minor : ''}</span><span>{image.abi}</span><span>{DEVICES[image.device]}</span><span>{systemTag(image)}</span></div>
                <p className="emulator-catalog-variant">{isAtd(image) ? t('ui.806d2eeecbf9') : STANDARD_TAGS.has(systemTag(image)) ? t('ui.0d67bfafc1fe') : image.description || t('ui.3cfe1c13dab7')}</p>
                <div className="emulator-catalog-package"><code>{image.package}</code><button type="button" className="icon-button" aria-label={t('ui.6573fef18165') + image.package} onClick={() => void copyPackage(image)}><Icon name="copy" size={15}/></button></div>
                {active && !stopping && !cancelling && job.state !== 'queued' && job.state !== 'validating' && <div className="emulator-catalog-progress"><span style={{ width: (job.progress?.steps ? Math.round(job.progress.step / job.progress.steps * 100) : 5) + '%' }}/></div>}
                {job?.state === 'failed' && <p className="emulator-catalog-error">{buildError(job)}</p>}
              </div>
              <div className="emulator-catalog-status">
                <span className="emulator-catalog-state" role="status" aria-live="polite">{(cancelling || active && job?.state !== 'queued') && <ActivityIndicator />}{cancelling ? job?.state === 'queued' ? t('ui.4ba8a8d87b3e') : t('ui.4046ae274af7') : active || cancelled || job?.state === 'failed' || job?.state === 'done' ? (job?.state === 'done' && image.validated ? t('ui.08f7f604ed9d') : jobLabel(job!)) : image.built ? image.validated ? t('ui.08f7f604ed9d') : t('ui.aebfbdcacbcf') : t('ui.7a6e3892843b')}</span>
                {(cancelled || job?.state === 'failed') && image.built && <small>{t('ui.cb6685e38d42')}</small>}
                {can('images.build') && active && <button type="button" className="button outline small emulator-catalog-cancel" disabled={!can('images.build') || busy || cancelling || stopping || !catalog?.builder} aria-busy={cancelling || stopping} aria-label={(job.state === 'queued' ? t('ui.7c47f7292ba4') : t('ui.3396400da0c4')) + t('ui.13164b4068c7') + imageName(image)} onClick={() => void cancelBuild(job)}>
                  {cancelling || stopping ? <span className="mini-spinner" aria-hidden="true"/> : <Icon name={job.state === 'queued' ? 'close' : 'stop'} size={14}/>}
                  {stopping ? t('ui.5278f65bf45f') : job.state === 'queued' ? t('ui.7c47f7292ba4') : t('ui.3396400da0c4')}
                </button>}
                {image.updateAvailable && <button type="button" className="button outline small" disabled={busy || !can('images.build')} onClick={() => void apply(image)}>{t('ui.2a8ae5e346cb')}</button>}
                {image.built && <small>{image.sizeMb ? Math.round(image.sizeMb / 102.4) / 10 + t('ui.25d1d78d6921') : ''}{image.profiles.length ? t('ui.515685e5caa2') + image.profiles.length : t('ui.b7b19eedd07d')}</small>}
              </div>
            </li>;
          })}</ul>}
      </div>

      <div className="emulator-catalog-footer">
        <span role="status" aria-live="polite">{buildSending ? t('ui.c792aacee413') : selected.size ? t('ui.a767eb85b546') + selected.size : building ? t('ui.a559dbfa4ef0') : t('ui.25cb2b3deb7d')}</span>
        <div className="modal-actions">
          <button type="button" className="button outline" onClick={onClose} disabled={busy}>{t('ui.a7a4033657e8')}</button>
          <button type="button" className="button primary emulator-catalog-build" disabled={!can('images.build') || busy || !ready || !selected.size} aria-busy={buildSending} onClick={() => void build()}>{buildSending ? <><span className="mini-spinner" aria-hidden="true"/>{t('ui.b9516a6281a2')}</> : <>{t('ui.c26ebde0601b')}{selected.size ? ' (' + selected.size + ')' : ''}</>}</button>
        </div>
      </div>
    </div>
  </div>;
}
