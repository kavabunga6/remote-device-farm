import { useNotifications } from './notifications';
import { ActivityIndicator } from './ActivityIndicator';
import { useAccess } from './permissions';
import { getLanguage, getLocale, t } from './i18n';
import { LaunchSettings } from './LaunchSettings';
import { HeadingSlot } from './HeadingSlot';
import { ProfileImportDialog } from './ProfileImportDialog';
import { EmulatorCatalogDialog } from './EmulatorCatalogDialog';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api, type Profile } from './api';
import { Icon } from './icons';
import { ProfileCard } from './ProfileCard';
import { profileFacetLabel, profileFacetValue, UNKNOWN_FACET, type ProfileFacet } from './profile-catalog';
import { PROFILE_STATUS_LABELS, profileStatus, type ProfileStatus } from './profile-status';
import './AdminProfiles.css';

const PAGE_SIZE = 18;
const FILTERS: Array<{ key: ProfileFacet; label: string; all: string }> = [
  { key: 'androidVersion', get label() { return t('ui.7b1487ed07ac'); }, get all() { return t('ui.9796f335ca5b'); } },
  { key: 'deviceType', get label() { return t('ui.47ea712ddb7d'); }, get all() { return t('ui.bd1d32cc6009'); } },
  { key: 'imageFlavor', get label() { return t('ui.7bc751ed6d6e'); }, get all() { return t('ui.8da6929959c3'); } },
  { key: 'abi', get label() { return t('ui.58ca61f26eeb'); }, get all() { return t('ui.3bffacf426a1'); } },
];
const EMPTY_FILTERS: Record<ProfileFacet, string> = { androidVersion: '', deviceType: '', imageFlavor: '', abi: '' };
const STATUSES: ProfileStatus[] = ['ready', 'disabled'];
const normalize = (value: string) => value.normalize('NFKC').toLocaleLowerCase(getLocale());

/** Admin facets are independent: all values remain available after any selection. */
function facetOptions(profiles: Profile[], facet: ProfileFacet) {
  return [...new Set(profiles.map(profile => profileFacetValue(profile, facet)))]
    .sort((left, right) => left === UNKNOWN_FACET ? 1 : right === UNKNOWN_FACET ? -1 : facet === 'androidVersion'
      ? right.localeCompare(left, getLocale(), { numeric: true })
      : profileFacetLabel(facet, left).localeCompare(profileFacetLabel(facet, right), getLocale()))
    .map(value => ({ value, label: profileFacetLabel(facet, value) }));
}
function searchText(profile: Profile) {
  return normalize([
    profile.name, profile.id, profile.image, profile.androidVersion,
    profile.apiLevel == null ? '' : `API ${profile.apiLevel} API${profile.apiLevel}`,
    profile.deviceType, profile.imageFlavor, profile.imageTag, profile.abi, profile.deviceModel,
    profile.resolution, profile.emulatorParams, ...FILTERS.map(filter => profileFacetLabel(filter.key, profileFacetValue(profile, filter.key))),
  ].filter(Boolean).join(' '));
}

export function AdminProfiles({ profiles, onCreate, onEdit, onToggle, onDelete, onImported }: {
  profiles: Profile[];
  onCreate: () => void;
  onImported: () => void;
  onEdit: (profile: Profile) => void;
  onToggle: (profile: Profile) => void;
  onDelete: (profile: Profile) => void;
}) {
  const can = useAccess();
  const [query, setQuery] = useState('');
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [status, setStatus] = useState<ProfileStatus | ''>('');
  const [page, setPage] = useState(0);
  const resultsHeading = useRef<HTMLParagraphElement>(null);
  const options = useMemo(() => Object.fromEntries(FILTERS.map(filter => [filter.key, facetOptions(profiles, filter.key)])) as Record<ProfileFacet, Array<{ value: string; label: string }>>, [profiles, getLanguage()]);
  const filtered = useMemo(() => {
    const terms = normalize(query).trim().split(/\s+/).filter(Boolean);
    return profiles.filter(profile =>
      (!status || profileStatus(profile) === status) &&
      FILTERS.every(filter => !filters[filter.key] || profileFacetValue(profile, filter.key) === filters[filter.key]) &&
      (!terms.length || terms.every(term => searchText(profile).includes(term))))
      .sort((left, right) => Number(right.apiLevel ?? -1) - Number(left.apiLevel ?? -1) || left.name.localeCompare(right.name, getLocale(), { numeric: true }) || left.id.localeCompare(right.id));
  }, [profiles, query, filters, status, getLanguage()]);
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount - 1);
  useEffect(() => { setPage(previous => Math.min(previous, pageCount - 1)); }, [pageCount]);
  const visible = filtered.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);
  const hasFilters = Boolean(query || status || Object.values(filters).some(Boolean));
  const clear = () => { setQuery(''); setFilters(EMPTY_FILTERS); setStatus(''); setPage(0); };
  const changePage = (next: number, fromBottom = false) => {
    setPage(next);
    if (fromBottom) { resultsHeading.current?.focus({ preventScroll: true }); resultsHeading.current?.scrollIntoView({ block: 'start', behavior: 'auto' }); }
  };
  const pagination = (bottom = false) => <nav className="admin-profiles-pagination" aria-label={bottom ? t('ui.48ee83c26ea3') : t('ui.804cd3a271af')}>
    <button type="button" className="icon-button" aria-label={t('ui.e7fd1db17999')} disabled={currentPage === 0} onClick={() => changePage(currentPage - 1, bottom)}><Icon name="chevronLeft" size={17}/></button>
    <span>{t('ui.225e004e10d0')}<strong>{currentPage + 1}</strong> {t('ui.e029cc4b39ce')}{pageCount}</span>
    <button type="button" className="icon-button" aria-label={t('ui.b46cfbcfefa7')} disabled={currentPage === pageCount - 1} onClick={() => changePage(currentPage + 1, bottom)}><Icon name="arrowRight" size={17}/></button>
  </nav>;

  const [importing, setImporting] = useState(false);
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const exportPending = useRef(false);
  const { notifyError } = useNotifications();
  const exportManifest = async () => {
    if (exportPending.current) return;
    exportPending.current = true; setExporting(true);
    try {
      const manifest = await api.exportProfiles();
      const link = document.createElement('a');
      link.href = URL.createObjectURL(new Blob([JSON.stringify(manifest, null, 2)], { type: 'application/json' }));
      link.download = 'device-farm-profiles.json';
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(link.href), 10_000);
    } catch (cause) { notifyError(t('profiles.exportFailed'), cause); }
    finally { exportPending.current = false; setExporting(false); }
  };
  return <section id="adm-profiles" className="content-section admin-tools admin-profile-catalog" aria-labelledby="admin-profiles-heading">
    <div className="section-heading"><div><h2 id="admin-profiles-heading">{t('ui.4d8dc88b1785')}</h2><p>{t('ui.d67382f6428f')}</p></div><HeadingSlot slot="actions"><div className="admin-heading-actions">{can('images.view') && <button type="button" className="button outline small" onClick={() => setCatalogOpen(true)}><Icon name="grid" size={16}/>{t('ui.0f624ca5f08a')}</button>}{can('profiles.manage') && <button type="button" className="button outline small" onClick={() => setImporting(true)}><Icon name="upload" size={16}/>{t('ui.011008fbaa2d')}</button>}<button type="button" className="button outline small" onClick={() => void exportManifest()} disabled={exporting} aria-busy={exporting}>{exporting ? <ActivityIndicator /> : <Icon name="download" size={16}/>} {t(exporting ? 'profiles.exporting' : 'ui.d2ab5a1bb639')}</button>{can('profiles.manage') && <button type="button" className="button primary small" onClick={onCreate}><Icon name="plus" size={16}/>{t('ui.359497aff53e')}</button>}</div></HeadingSlot></div>
    {can('profiles.manage') && <LaunchSettings onChanged={onImported}/>}
    <div className="admin-profiles-controls">
      <div className="admin-profiles-search-row"><label className="admin-profiles-search"><Icon name="search" size={18}/><input type="search" aria-label={t('ui.799525e87625')} placeholder={t('ui.3fe77c2e6713')} value={query} onChange={event => { setQuery(event.target.value); setPage(0); }}/></label><button type="button" className="button outline small" disabled={!hasFilters} onClick={clear}>{t('ui.cd45ec7836b5')}</button></div>
      <div className="admin-profiles-filters">{FILTERS.map(filter => <label key={filter.key}><span>{filter.label}</span><select aria-label={filter.label} value={filters[filter.key]} onChange={event => { setFilters(previous => ({ ...previous, [filter.key]: event.target.value })); setPage(0); }}><option value="">{filter.all}</option>{filters[filter.key] && !options[filter.key].some(option => option.value === filters[filter.key]) && <option value={filters[filter.key]}>{profileFacetLabel(filter.key, filters[filter.key])} {t('ui.accc31a4bbfd')}</option>}{options[filter.key].map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>)}
        <label><span>{t('ui.f5ebb4335b88')}</span><select aria-label={t('ui.f5ebb4335b88')} value={status} onChange={event => { setStatus(event.target.value as ProfileStatus | ''); setPage(0); }}><option value="">{t('ui.2a013601f9a8')}</option>{STATUSES.map(value => <option key={value} value={value}>{PROFILE_STATUS_LABELS[value]}</option>)}</select></label>
      </div>
    </div>
    <div className="admin-profiles-results-bar"><p ref={resultsHeading} tabIndex={-1} role="status" aria-live="polite">{filtered.length ? t('ui.867ed0ef8f5b', { p0: currentPage * PAGE_SIZE + 1, p1: currentPage * PAGE_SIZE + visible.length, p2: filtered.length }) : t('ui.80c36ca12e45')}</p>{pageCount > 1 && pagination()}</div>
    {visible.length ? <><div className="profile-grid">{visible.map(profile => <ProfileCard key={profile.id} profile={profile} onEdit={() => onEdit(profile)} onToggle={() => onToggle(profile)} onDelete={() => onDelete(profile)}/>)}</div>{pageCount > 1 && <div className="admin-profiles-bottom">{pagination(true)}</div>}</> : <div className="empty-state admin-profiles-empty"><div className="empty-icon"><Icon name={profiles.length ? 'search' : 'phone'} size={27}/></div><h3>{profiles.length ? t('ui.df84a152e415') : t('ui.5a4172642e88')}</h3><p>{profiles.length ? t('ui.7e2976c6d75f') : t('ui.890189b3bc75')}</p></div>}
  {importing && <ProfileImportDialog onClose={() => setImporting(false)} onApplied={onImported} />}
  {catalogOpen && <EmulatorCatalogDialog onClose={() => setCatalogOpen(false)} onChanged={onImported} />}</section>;
}
