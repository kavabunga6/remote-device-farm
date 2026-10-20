import { useEffect, useState } from 'react';
import type { Host } from './api';
import { t, getLocale, localizeText } from './i18n';
import { Icon } from './icons';
import { ActivityIndicator } from './ActivityIndicator';
import { EmulatorCatalogDialog } from './EmulatorCatalogDialog';
import { ImageInventorySummary } from './ImageInventorySummary';
import { ManagedImageDetails, ManagedImageUsage, imageDisplay, imageKey, imageReason } from './ManagedImageDetails';
import { useAccess } from './permissions';
import { useAdminDialog } from './useAdminDialog';
import { useNotifications } from './notifications';
import { imageManagementApi as api, type ManagedImage, type CleanupPolicy, type CleanupPlan, type CleanupJob } from './image-management-api';
import './ImageManagement.css';
const msg = (key: string) => t(key as Parameters<typeof t>[0]);
const bytes = (value: number) => new Intl.NumberFormat(getLocale(), { style: 'unit', unit: 'gigabyte', maximumFractionDigits: 1 }).format(value / 1024 ** 3);
const date = (value?: string | null) => value ? new Intl.DateTimeFormat(getLocale(), { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value)) : '—';
const reason = imageReason;
const policySignature = (value: CleanupPolicy | null) => JSON.stringify(value, ['registryEnabled', 'registryKeep', 'registryDays', 'cacheEnabled', 'cacheDays', 'cacheMaxGb', 'intervalHours']);
function ImageDate({ value }: { value?: string | null }) {
  if (!value) return <>—</>;
  const parsed = new Date(value);
  return <time dateTime={value} title={date(value)}>{new Intl.DateTimeFormat(getLocale(), { dateStyle: 'short' }).format(parsed)}<small>{new Intl.DateTimeFormat(getLocale(), { timeStyle: 'short' }).format(parsed)}</small></time>;
}
export function ImageManagement({ hosts, onChanged }: { hosts: Host[]; onChanged: () => void }) {
  const can = useAccess(), { notify } = useNotifications();
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [tab, setTab] = useState<'registry' | 'cache' | 'policy' | 'history'>('registry');
  const [registry, setRegistry] = useState<{ supported: boolean; repository: string | null; items: ManagedImage[]; maintenance: boolean } | null>(null);
  const [cache, setCache] = useState<ManagedImage[]>([]), [policy, setPolicy] = useState<CleanupPolicy | null>(null), [jobs, setJobs] = useState<CleanupJob[]>([]);
  const [hostId, setHostId] = useState(hosts[0]?.id ?? ''), [query, setQuery] = useState(''), [selected, setSelected] = useState<string[]>([]);
  const [usage, setUsage] = useState<'all' | 'unused' | 'protected'>('all');
  const [androidVersion, setAndroidVersion] = useState('all');
  const [savedPolicy, setSavedPolicy] = useState<CleanupPolicy | null>(null);
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [plans, setPlans] = useState<CleanupPlan[] | null>(null), [dialogError, setDialogError] = useState('');
  const close = () => { if (!busy) setPlans(null); }, dialog = useAdminDialog(Boolean(plans), busy, close);
  const active = jobs.some(job => ['queued', 'running'].includes(job.state)) || Boolean(registry?.maintenance);
  useEffect(() => { setHostId(current => hosts.some(host => host.id === current) ? current : hosts[0]?.id ?? ''); }, [hosts]);
  const reload = async (signal?: AbortSignal) => {
    setError('');
    const results = await Promise.allSettled([api.registry(signal), api.policy(signal), api.jobs(signal), tab === 'cache' && hostId ? api.cache(hostId, signal) : Promise.resolve(null)]);
    if (signal?.aborted) return;
    if (results[0].status === 'fulfilled') setRegistry(results[0].value);
    if (results[1].status === 'fulfilled') {
      const next = results[1].value.policy;
      setPolicy(current => !current || policySignature(current) === policySignature(savedPolicy) ? next : current); setSavedPolicy(next);
    }
    if (results[2].status === 'fulfilled') setJobs(results[2].value.items);
    if (results[3].status === 'fulfilled' && results[3].value) setCache(results[3].value.items);
    else if (tab === 'cache') setCache([]);
    const failed = results.find(result => result.status === 'rejected');
    if (failed?.status === 'rejected') setError(failed.reason instanceof Error ? failed.reason.message : t('images.error.unavailable'));
    setLoading(false);
  };
  useEffect(() => { const controller = new AbortController(); setLoading(true); setSelected([]); void reload(controller.signal); return () => controller.abort(); }, [tab, hostId]);
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController(); const timer = setTimeout(() => void reload(controller.signal), 2000);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [jobs, active, tab, hostId]);
  const preview = async (input: Record<string, unknown>, all = false) => {
    if (busy) return; setBusy(true); setError(''); setDialogError('');
    try {
      const next: CleanupPlan[] = [];
      if (all) { for (const host of hosts.filter(host => host.status === 'online')) next.push((await api.preview({ ...input, hostId: host.id })).plan); }
      else next.push((await api.preview(input)).plan);
      setPlans(next);
    } catch (cause) { setError(cause instanceof Error ? cause.message : t('images.error.unavailable')); }
    finally { setBusy(false); }
  };
  const toggleProfiles = async (value: boolean) => {
    if (!plans || busy) return; setPlans(plans.map(plan => ({ ...plan, removeProfiles: value }))); setBusy(true); setDialogError('');
    try { setPlans(await Promise.all(plans.map(async plan => (await api.preview({ ...plan, removeProfiles: value })).plan))); }
    catch (cause) { setDialogError(cause instanceof Error ? cause.message : t('images.error.unavailable')); }
    finally { setBusy(false); }
  };
  const apply = async () => {
    if (!plans || busy) return; setBusy(true); setDialogError('');
    const submitted: string[] = [];
    try {
      for (const plan of plans.filter(plan => !plan.blocked && (plan.action === 'gc' || plan.items.length))) submitted.push((await api.enqueue(plan)).id);
      notify({ kind: 'success', title: t('images.requested') }); setPlans(null); setSelected([]); await reload(); onChanged();
    } catch (cause) {
      setDialogError(cause instanceof Error ? cause.message : t('images.error.unavailable'));
      if (submitted.length) { setPlans(null); notify({ kind: 'error', title: t('images.partialSubmission') }); await reload(); }
    } finally { setBusy(false); }
  };
  const save = async (event: React.FormEvent) => {
    event.preventDefault(); if (!policy || busy) return; setBusy(true);
    try { const clean = { ...policy }; delete (clean as CleanupPolicy & { lastRunAt?: unknown }).lastRunAt; const result = await api.save(clean); setPolicy(result.policy); setSavedPolicy(result.policy); notify({ kind: 'success', title: t('images.policySaved') }); }
    catch (cause) { setError(cause instanceof Error ? cause.message : t('images.error.unavailable')); }
    finally { setBusy(false); }
  };
  const items = tab === 'cache' ? cache : registry?.items ?? [];
  useEffect(() => {
    const allowed = new Set(items.filter(item => !item.blockers.length).map(imageKey));
    setSelected(old => { const next = old.filter(id => allowed.has(id)); return next.length === old.length ? old : next; });
  }, [items]);
  const inventory = items.map(item => ({ item, display: imageDisplay(item) }));
  const versions = [...new Map(inventory.filter(({ display }) => display.versionKey).map(({ display }) => [display.versionKey!, display.android!])).entries()].sort(([a], [b]) => Number(b) - Number(a));
  const visible = inventory.filter(({ item, display }) => [display.name, display.metadata, item.package, ...item.tags, ...(item.digests ?? []), item.digest ?? item.id].join(' ').toLocaleLowerCase(getLocale()).includes(query.trim().toLocaleLowerCase(getLocale())))
    .filter(({ item, display }) => (androidVersion === 'all' || display.versionKey === androidVersion) && (usage === 'all' || (usage === 'protected' ? Boolean(item.blockers.length) : !item.uses.length && !item.blockers.length))).map(({ item }) => item);
  const selectedItems = items.filter(item => selected.includes(imageKey(item)));
  const selectedBytes = selectedItems.reduce((total, item) => total + item.sizeBytes, 0);
  const visibleIds = new Set(visible.map(imageKey));
  const hiddenSelection = selected.filter(id => !visibleIds.has(id)).length;
  const filtered = Boolean(query || usage !== 'all' || androidVersion !== 'all');
  const automaticCleanup = tab === 'cache' ? savedPolicy?.cacheEnabled : savedPolicy?.registryEnabled;
  const key = imageKey;
  const deletionAllowed = tab === 'registry' ? can('images.delete') : can('images.cleanup');
  const selectionLimit = tab === 'registry' ? 500 : 100;
  const selection = visible.filter(item => !item.blockers.length).slice(0, selectionLimit).map(key);
  const profiles = plans?.flatMap(plan => plan.items.flatMap(item => item.uses?.filter(use => use.kind === 'profile') ?? [])) ?? [];
  const hasWork = plans?.some(plan => !plan.blocked && (plan.action === 'gc' || plan.items.length));
  const dirty = Boolean(policy && savedPolicy && policySignature(policy) !== policySignature(savedPolicy));
  const field = (name: keyof CleanupPolicy, min: number, max: number, enabled = true) => <label className="image-policy-field">
    <span>{msg('images.field.' + name)}</span>
    <input type="number" min={min} max={max} required value={Number.isFinite(policy?.[name]) ? Number(policy?.[name]) : ''} disabled={busy || !can('images.settings') || !enabled}
      aria-describedby={'image-hint-' + name} onChange={event => setPolicy(old => old ? { ...old, [name]: event.target.value === '' ? NaN : Number(event.target.value) } : old)} />
    <small id={'image-hint-' + name}>{msg('images.hint.' + name)}</small>
  </label>;
  const copy = async (value: string, repository = false) => {
    try { await navigator.clipboard.writeText(value); notify({ kind: 'success', title: t(repository ? 'images.repositoryCopied' : 'images.identifierCopied') }); }
    catch { notify({ kind: 'error', title: t('images.copyFailed') }); }
  };
  const resetFilters = () => { setQuery(''); setUsage('all'); setAndroidVersion('all'); };
  const changeTab = (value: typeof tab) => { setTab(value); resetFilters(); };
  const empty = (title: string, description: string, history = false) => <div className="image-empty-state">
    <span className="image-empty-icon"><Icon name={history ? 'list' : query ? 'search' : 'server'} size={24} /></span>
    <div><h3>{title}</h3><p>{description}</p></div>
    {history && can('images.settings') && <button type="button" className="button outline" onClick={() => changeTab('policy')}>{t('images.configureCleanup')}</button>}
    {!history && filtered && <button type="button" className="button outline" onClick={resetFilters}>{t('images.resetFilters')}</button>}
  </div>;
  return <section className="image-management">
    <div className="image-toolbar">
      <nav className="image-tabs" aria-label={t('images.title')}>{(['registry', 'cache', 'policy', 'history'] as const).map(value => <button type="button" key={value} aria-current={tab === value ? 'page' : undefined}
        disabled={busy || value === 'cache' && !can('nodes.view')} onClick={() => changeTab(value)}>{msg('images.tab.' + value)}</button>)}</nav>
      <div className="image-toolbar-end">
        {can('images.view') && <button type="button" className="button outline small" disabled={busy} onClick={() => setCatalogOpen(true)}><Icon name="grid" size={16} />{t('ui.0f624ca5f08a')}</button>}
        {registry?.supported && registry.repository && <div className="image-repository"><Icon name="server" size={15} /><code title={registry.repository}>{registry.repository}</code><button type="button" className="icon-button" title={t('images.copyRepository')} aria-label={t('images.copyRepository')} onClick={() => void copy(registry.repository!, true)}><Icon name="copy" size={15} /></button></div>}
      <button type="button" className="icon-button image-refresh" aria-label={t('images.refresh')} title={t('images.refresh')} disabled={busy || loading} onClick={() => { setLoading(true); void reload(); }}><Icon name="refresh" size={18} /></button></div>
    </div>
    {(active || busy) && <div className="image-process" role="status"><ActivityIndicator />{busy ? t('images.working') : t('images.active')}</div>}
    {error && <div className="inline-error" role="alert">{localizeText(error)}</div>}
    {loading ? <div className="image-loading" role="status"><ActivityIndicator />{t('images.loading')}</div> : <>
      {(tab === 'registry' || tab === 'cache') && <div className="image-inventory">
        <div className="image-section-heading">
          <p className="image-inventory-description">{t(tab === 'registry' ? 'images.registryDescription' : 'images.cacheDescription')}</p>
          {(tab === 'cache' || registry?.supported) && can('images.cleanup') && <div className="image-control-actions">
            <button type="button" className="button outline" disabled={busy || active || tab === 'cache' && !hostId} onClick={() => void preview({ scope: tab, action: 'retention', ...(tab === 'cache' ? { hostId } : {}) })}><Icon name="list" size={16} />{t('images.previewCleanup')}</button>
            {tab === 'registry' ? <button className="button outline" type="button" disabled={busy || active} onClick={() => void preview({ scope: 'registry', action: 'gc' })}><Icon name="rotate" size={16} />{t('images.gc')}</button>
              : <button className="button outline" type="button" disabled={busy || active || !hosts.some(host => host.status === 'online')} onClick={() => void preview({ scope: 'cache', action: 'retention' }, true)}><Icon name="server" size={16} />{t('images.allNodes')}</button>}
          </div>}
        </div>
        {tab === 'registry' && !registry?.supported ? empty(t('images.registryMissing'), t('images.externalDescription')) : <>
          <ImageInventorySummary items={items} usage={usage} onFilter={setUsage} formatBytes={bytes} />
          <div className={'image-controls' + (tab === 'cache' ? ' has-node' : '')}>
            {tab === 'cache' && <label className="image-node-field"><span>{t('images.node')}</span><select value={hostId} disabled={busy || loading} onChange={event => setHostId(event.target.value)}>{hosts.map(host => <option key={host.id} value={host.id}>{host.name}{host.status === 'offline' ? ' · ' + t('images.offline') : ''}</option>)}</select></label>}
            <label className="image-search-field"><span>{t('images.search')}</span><div className="image-search-control"><Icon name="search" size={17} /><input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder={t('images.searchHint')} /></div></label>
            <label className="image-usage-field"><span>{t('images.state')}</span><select value={usage} onChange={event => setUsage(event.target.value as typeof usage)}>
              <option value="all">{t('images.filter.all')}</option><option value="unused">{t('images.filter.unused')}</option><option value="protected">{t('images.filter.protected')}</option>
            </select></label>
            <label className="image-version-field"><span>{t('images.androidFilter')}</span><select value={androidVersion} onChange={event => setAndroidVersion(event.target.value)}>
              <option value="all">{t('images.filter.allVersions')}</option>{versions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select></label>
          </div>
          <div className="image-inventory-list">
            {deletionAllowed && <div className={'image-selection' + (selected.length ? ' has-selection' : '')}>
              <label title={t('images.selectionLimit', { p0: selectionLimit })}><input type="checkbox" disabled={!selection.length || busy || active} checked={Boolean(selection.length && selection.every(id => selected.includes(id)))} ref={input => { if (input) input.indeterminate = selection.some(id => selected.includes(id)) && !selection.every(id => selected.includes(id)); }} onChange={event => setSelected(old => event.target.checked ? [...new Set([...old, ...selection])].slice(0, selectionLimit) : old.filter(id => !selection.includes(id)))} />{t('images.selectAvailable', { p0: selectionLimit })}</label>
              <div className="image-selection-actions">
                {selected.length > 0 && <><div className="image-selection-meta"><span className="image-selected-size" role="status">{t('images.selectedLayers', { p0: bytes(selectedBytes) })}</span>{hiddenSelection > 0 && <button type="button" className="image-hidden-selection" onClick={resetFilters} aria-label={t('images.showHiddenSelection', { p0: hiddenSelection })}>{t('images.hiddenSelection', { p0: hiddenSelection })}</button>}</div><button type="button" className="icon-button" title={t('images.clearSelection')} aria-label={t('images.clearSelection')} disabled={busy || active} onClick={() => setSelected([])}><Icon name="close" size={16} /></button></>}
              <button className={'button ' + (selected.length ? 'danger-outline' : 'outline')} type="button" disabled={!selected.length || busy || active} onClick={() => void preview({ scope: tab, action: 'delete', ...(tab === 'registry' ? { digests: selected } : { hostId, ids: selected }) })}><Icon name="trash" size={16} />{t('images.deleteSelected', { p0: selected.length })}</button></div>
            </div>}
            {visible.length ? <div className="image-table-wrap"><table className="image-table image-inventory-table"><colgroup>
              {deletionAllowed && <col className="image-select-column" />}<col className="image-name-column" /><col className="image-size-column" /><col className="image-date-column" /><col className="image-usage-column" />{deletionAllowed && <col className="image-action-column" />}
            </colgroup><thead><tr>{deletionAllowed && <th><span className="sr-only">{t('images.select')}</span></th>}<th>{t('images.image')}</th><th>{t('images.size')}</th><th>{tab === 'registry' ? t('images.created') : t('images.used')}</th><th>{t('images.references')}</th>{deletionAllowed && <th><span className="sr-only">{t('images.delete')}</span></th>}</tr></thead><tbody>{visible.map(item => <tr key={key(item)} className={selected.includes(key(item)) ? 'is-selected' : undefined}>
              {deletionAllowed && <td className="image-select-cell"><input type="checkbox" aria-label={t('images.selectImage', { p0: item.package ?? key(item) })} disabled={busy || active || Boolean(item.blockers.length) || selected.length >= selectionLimit && !selected.includes(key(item))} checked={selected.includes(key(item))} onChange={event => setSelected(old => event.target.checked ? [...old, key(item)] : old.filter(id => id !== key(item)))} /></td>}
              <td><ManagedImageDetails item={item} onCopy={value => void copy(value)} /></td>
              <td className="image-numeric">{bytes(item.sizeBytes)}</td>
              <td className="image-date">{tab === 'cache' && !item.lastUsedAt ? <><span>{t('images.lastUseUnknown')}</span><small>{t('images.discovered', { p0: date(item.firstSeenAt) })}</small></> : <ImageDate value={tab === 'registry' ? item.createdAt : item.lastUsedAt} />}</td>
              <td><ManagedImageUsage item={item} /></td>
              {deletionAllowed && <td className="image-action-cell"><button className="icon-button danger-icon" type="button" title={item.blockers.length ? item.blockers.map(reason).join(', ') : t('images.delete')} aria-label={t('images.deleteImage', { p0: item.package ?? key(item) })} disabled={busy || active || Boolean(item.blockers.length)} onClick={() => void preview({ scope: tab, action: 'delete', ...(tab === 'registry' ? { digests: [key(item)] } : { hostId, ids: [key(item)] }) })}><Icon name={item.blockers.length ? 'shield' : 'trash'} size={17} /></button></td>}
            </tr>)}</tbody></table></div> : empty(filtered ? t('images.noMatches') : t('images.empty'), filtered ? t('images.noMatchesHint') : t(tab === 'cache' ? 'images.emptyCacheHint' : 'images.emptyRegistryHint'))}
            <div className="image-inventory-footer"><span>{t('images.shown', { p0: visible.length, p1: items.length })}</span>{savedPolicy && <button type="button" className="image-policy-link" onClick={() => changeTab('policy')}><Icon name={automaticCleanup ? 'check' : 'pause'} size={14} />{t(automaticCleanup ? 'images.automaticEvery' : 'images.automaticOff', { p0: savedPolicy.intervalHours })}<Icon name="chevronDown" size={13} /></button>}</div>
          </div>
          <p className="image-note image-size-note"><Icon name="info" size={14} />{t('images.sizeNote')}</p>
        </>}
      </div>}
      {tab === 'policy' && policy && <form className="image-policies" onSubmit={save}>
        <div className="image-section-heading"><div><h2>{t('images.tab.policy')}</h2><p>{t('images.policyDescription')}</p></div></div>
        <div className="image-policy-sections">
          <section className="image-policy-card" aria-labelledby="registry-policy-title">
            <header><div><h3 id="registry-policy-title">{t('images.tab.registry')}</h3><span className={'image-status ' + (policy.registryEnabled ? 'is-current' : 'is-unused')}>{t(policy.registryEnabled ? 'images.enabled' : 'images.disabled')}</span></div>
              <input className="image-policy-toggle" type="checkbox" role="switch" aria-label={t('images.autoRegistry')} checked={policy.registryEnabled} disabled={busy || !can('images.settings') || !can('images.cleanup') || !registry?.supported} onChange={event => setPolicy({ ...policy, registryEnabled: event.target.checked })} />
            </header>
            <p className="image-policy-description">{t('images.autoRegistry')}</p>
            <div className="image-policy-grid">{field('registryKeep', 1, 100, policy.registryEnabled)}{field('registryDays', 1, 3650, policy.registryEnabled)}</div>
            <div className="image-policy-protection"><Icon name="shield" size={16} /><p>{t('images.registryProtection')}</p></div>
          </section>
          <section className="image-policy-card" aria-labelledby="cache-policy-title">
            <header><div><h3 id="cache-policy-title">{t('images.tab.cache')}</h3><span className={'image-status ' + (policy.cacheEnabled ? 'is-current' : 'is-unused')}>{t(policy.cacheEnabled ? 'images.enabled' : 'images.disabled')}</span></div>
              <input className="image-policy-toggle" type="checkbox" role="switch" aria-label={t('images.autoCache')} checked={policy.cacheEnabled} disabled={busy || !can('images.settings') || !can('images.cleanup')} onChange={event => setPolicy({ ...policy, cacheEnabled: event.target.checked })} />
            </header>
            <p className="image-policy-description">{t('images.autoCache')}</p>
            <div className="image-policy-grid">{field('cacheDays', 1, 3650, policy.cacheEnabled)}{field('cacheMaxGb', 0, 100000, policy.cacheEnabled)}</div>
            <div className="image-policy-protection"><Icon name="shield" size={16} /><p>{t('images.cacheProtection')}</p></div>
          </section>
        </div>
        <div className="image-policy-footer">
          <div className="image-policy-grid image-schedule">{field('intervalHours', 1, 720)}</div>
          <div className="image-policy-save"><span className="image-note" role="status">{dirty ? t('images.unsaved') : t('images.saved')}</span>{can('images.settings') && <button type="submit" className="button primary" disabled={busy || !dirty}>{busy ? <><ActivityIndicator />{t('images.saving')}</> : t('images.save')}</button>}</div>
        </div>
      </form>}
      {tab === 'history' && <div className="image-history">
        <div className="image-section-heading"><div><h2>{t('images.tab.history')}</h2><p>{t('images.historyDescription')}</p></div></div>
        {jobs.length ? <div className="image-table-wrap"><table className="image-table image-history-table"><thead><tr><th>{t('images.created')}</th><th>{t('images.target')}</th><th>{t('images.state')}</th><th>{t('images.result')}</th></tr></thead><tbody>{jobs.map(job => <tr key={job.id}>
          <td className="image-date">{date(job.createdAt)}<code title={job.id}>#{job.id.slice(0, 8)}</code></td>
          <td><strong>{job.scope === 'registry' ? t('images.tab.registry') : hosts.find(host => host.id === job.hostId)?.name ?? job.hostId}</strong><small>{job.automatic ? t('images.automatic') : t('images.manual')}</small></td>
          <td><span className={'image-status image-job-' + job.state}>{['queued', 'running'].includes(job.state) ? <ActivityIndicator /> : <Icon name={job.state === 'done' ? 'check' : 'alert'} size={13} />}{msg('images.job.' + job.state)}</span>{['queued', 'running'].includes(job.state) && <small>{msg('images.stage.' + (['draining', 'deleting', 'collecting'].includes(job.stage) ? job.stage : 'queued'))}</small>}</td>
          <td>{job.errorCode ? <><span>{t('images.jobError')}</span><small>{msg('images.error.' + (['changed', 'protected', 'offline', 'interrupted', 'partial'].includes(job.errorCode) ? job.errorCode : 'cleanup_failed'))}</small></> : ['queued', 'running'].includes(job.state) ? <span className="image-note">{t('images.resultPending')}</span> : t('images.removedCount', { p0: job.result?.removed?.length ?? job.result?.deleted?.length ?? 0 })}</td>
        </tr>)}</tbody></table></div> : empty(t('images.noJobs'), t('images.historyEmptyHint'), true)}
      </div>}
    </>}
    {plans && <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) close(); }}><section className="modal image-cleanup-dialog" ref={dialog} tabIndex={-1} role="alertdialog" aria-modal="true" aria-labelledby="image-cleanup-title"><header><h2 id="image-cleanup-title">{t('images.confirm')}</h2><button className="icon-button" type="button" disabled={busy} aria-label={t('images.close')} onClick={close}><Icon name="close" size={18} /></button></header><div className="image-dialog-body">
      <p>{plans[0]?.scope === 'registry' ? plans[0].action === 'gc' ? t('images.gcImpact') : t('images.registryImpact') : t('images.cacheImpact')}</p>
      <ul className="image-plan-list">{plans.map((plan, index) => <li key={index}><strong>{plan.scope === 'registry' ? t('images.tab.registry') : hosts.find(host => host.id === plan.hostId)?.name ?? plan.hostId}</strong><span>{t('images.planCount', { p0: plan.items.length })}</span>{plan.blocked && <p className="inline-error">{t('images.blocked')}</p>}{plan.items.map(item => <div key={key(item)}><strong>{imageDisplay(item).name}</strong><code>{key(item)}</code>{item.blockers.map(value => <small key={value}>{reason(value)}</small>)}</div>)}</li>)}</ul>
      {profiles.length > 0 && <div className="image-profile-impact"><h3>{t('images.linkedProfiles')}</h3><p>{t('images.profilesDisabled')}</p><ul>{[...new Map(profiles.map(profile => [profile.id, profile])).values()].map(profile => <li key={profile.id}>{profile.name}</li>)}</ul><label className="image-switch"><input type="checkbox" checked={plans[0].removeProfiles === true} disabled={busy} onChange={event => void toggleProfiles(event.target.checked)} />{t('images.removeProfiles')}</label></div>}
      {!hasWork && <p>{t('images.nothingToClean')}</p>}{dialogError && <p className="inline-error" role="alert">{localizeText(dialogError)}</p>}
    </div><footer><button className="button outline" type="button" disabled={busy} onClick={close}>{t('images.cancel')}</button><button className="button danger" type="button" disabled={busy || !hasWork || Boolean(dialogError)} onClick={() => void apply()}>{busy ? t('images.submitting') : t('images.confirmAction')}</button></footer></section></div>}
    {catalogOpen && <EmulatorCatalogDialog onClose={() => setCatalogOpen(false)} onChanged={() => { void reload(); onChanged(); }} />}
  </section>;
}
