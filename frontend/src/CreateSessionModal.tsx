import { TranslatedText } from './TranslatedText';
import { localizeText, getLanguage, t } from './i18n';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api, KNOWN_ERRORS, type AdbPublicKey, type Host, type Profile, type SessionLaunchOptions } from './api';
import { notifyQueueChanged, queueApi } from './queue-api';
import { Icon } from './icons';
import { settingsApi } from './settings-api';
import { availableSlots } from './host-availability';
import { LaunchReadiness } from './LaunchReadiness';
import { hostGpuBackend, launchReadiness } from './launch-readiness';
import { memoryLabel, profileEnvironment } from './profile-metadata';
import { preserveProfileSelection, type CatalogProfile } from './profile-catalog';
import { ProfilePicker } from './ProfilePicker';
import { useAccess } from './permissions';

import { effectiveLaunchProfile, hasLaunchDraftChanges, launchResourceError, parseLaunchDraft, type LaunchDraft } from './launch-options';
import './CreateSessionModal.css';

type GpuMode = 'software' | 'nvidia';
// Facts the profile does not define are left out here; they are listed (as missing) in the admin catalogue.
const isUnset = (value: string) => [t('ui.c5ae8cdbe7dd'), t('ui.e895fb5ecd06'), t('ui.011e1ca54824')].includes(value);
function profileFacts(environment: ReturnType<typeof profileEnvironment>): Array<[string, string]> {
  const facts: Array<[string, string]> = [[t('ui.f3bdf7cce355'), environment.model], [t('ui.c062341615dc'), environment.resolution]];
  return facts.filter(([, value]) => !isUnset(value));
}

const LAST_LAUNCH_KEY = 'rdf.lastLaunch';
export function rememberLaunch(profileId: string, gpuMode: GpuMode) {
  try { localStorage.setItem(LAST_LAUNCH_KEY, JSON.stringify({ profileId, gpuMode })); } catch { /* storage may be unavailable */ }
}
export function lastLaunch(): { profileId?: string; gpuMode?: GpuMode } {
  try { const value = JSON.parse(localStorage.getItem(LAST_LAUNCH_KEY) || '{}'); return value && typeof value === 'object' ? value : {}; } catch { return {}; }
}

export function CreateSessionModal({ hosts, profiles: allProfiles, allowedProfileIds = null, onClose, onCreate, onQueued, canConfigureContainer = false }: {
  canConfigureContainer?: boolean; hosts: Host[]; profiles: Profile[]; allowedProfileIds?: string[] | null;
  onClose: () => void; onCreate: (hostId: string, profileId: string, adbKeyId: string | null, gpuMode: GpuMode, storage?: { diskGb?: number; sdcardGb?: number }, launchOptions?: SessionLaunchOptions, count?: number) => Promise<void>; onQueued?: () => void;
}) {
  const can = useAccess(), canUseAdb = can('sessions.adb');
  const profiles = useMemo(() => allowedProfileIds === null ? allProfiles : allProfiles.filter(profile => allowedProfileIds.includes(profile.id)), [allProfiles, allowedProfileIds, getLanguage()]);
  const [hostId, setHostId] = useState('');
  const [draft, setDraft] = useState<LaunchDraft>({});
  const parsedDraft = parseLaunchDraft(draft);
  const setLaunchField = (field: keyof LaunchDraft, value: string | null) => { setDraft(current => ({ ...current, [field]: value })); setError(''); };
  // Start on the first profile some online node can actually run; fall back to the first enabled one.
  const fits = (profile: CatalogProfile) => launchReadiness(profile, hosts, 'software').state === 'ready';
  const firstFitting = () => {
    const last = profiles.find(profile => profile.id === lastLaunch().profileId);
    return (last && fits(last) ? last : profiles.find(fits))?.id || preserveProfileSelection('', profiles);
  };
  const [profileId, setProfileId] = useState(firstFitting);
  const [gpuMode, setGpuMode] = useState<GpuMode>(() => { const saved = lastLaunch(); return saved.profileId === profileId && saved.gpuMode === 'nvidia' ? 'nvidia' : 'software'; });
  const [adbKeyId, setAdbKeyId] = useState('');
  const [storageChoice, setStorageChoice] = useState<{ profileId: string; diskGb: number; sdcardGb: number } | null>(null);
  const [keys, setKeys] = useState<AdbPublicKey[]>([]);
  const [farmKeyExists, setFarmKeyExists] = useState<boolean | null>(null);
  const [keyLoading, setKeyLoading] = useState(true);
  const [keyError, setKeyError] = useState('');
  const [keyLoadAttempt, setKeyLoadAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const dialogRef = useRef<HTMLDivElement>(null);
  const revealReadiness = useRef(false);
  const selectedProfile = profiles.find(profile => profile.id === profileId);
  const canEditLaunch = canConfigureContainer || selectedProfile?.launchOverridesAllowed === true;
  const extraOptions = canEditLaunch ? parsedDraft.options : {};
  const draftError = canEditLaunch ? parsedDraft.error : '';
  const effectiveProfile = selectedProfile ? effectiveLaunchProfile(selectedProfile, extraOptions) : undefined;
  const environment = effectiveProfile ? profileEnvironment(effectiveProfile) : null;
  const launchError = draftError || launchResourceError(selectedProfile, extraOptions, canConfigureContainer) || (extraOptions.privileged && !canConfigureContainer ? t('ui.ab4d9e952621') : '');
  const manualHost = hosts.find(host => host.id === hostId);
  const readiness = launchReadiness(selectedProfile, hosts, gpuMode, hostId, extraOptions.privileged, extraOptions);
  const selectedHost = readiness.state === 'ready' ? readiness.host : undefined;
  const profileFitsHost = readiness.state === 'ready';
  const gpuReadiness = launchReadiness(selectedProfile, hosts, 'nvidia', hostId, extraOptions.privileged, extraOptions);
  const autoReadiness = hostId ? launchReadiness(selectedProfile, hosts, gpuMode, '', extraOptions.privileged, extraOptions) : readiness;
  const hasAlternativeHost = Boolean(hostId && readiness.state === 'blocked' && autoReadiness.state !== 'blocked');
  const gpuBackend = gpuReadiness.host ? hostGpuBackend(gpuReadiness.host) : null;
  const gpuHint = !selectedProfile ? t('ui.8dbe6ca9590c')
    : gpuReadiness.state === 'blocked' ? gpuReadiness.issues[0]?.message ?? t('ui.713b6272c135')
    : gpuReadiness.state === 'busy' ? t('ui.87142ea4a68e')
    : gpuMode === 'nvidia' ? (gpuBackend === 'gpu' ? t('ui.95a47a2e8021') : t('ui.dcc000ca42a8'))
    : t('images.disabled');
  const gpuSwitchDisabled = busy || !selectedProfile || (gpuMode !== 'nvidia' && gpuReadiness.state === 'blocked');
  const chooseProfile = (id: string) => {
    const profile = profiles.find(candidate => candidate.id === id);
    if (!profile || profile.enabled === false) { setError(t('ui.95e22e57e9c0')); return; }
    setDraft({}); setStorageChoice(null);
    setProfileId(id); setError('');
  };

  useEffect(() => { if (!canEditLaunch) { setDraft({}); setStorageChoice(null); } }, [canEditLaunch]);

  useEffect(() => {
    if (!profileId && profiles.length) {
      const id = preserveProfileSelection('', profiles); setProfileId(id); setGpuMode('software');
    }
  }, [profiles, profileId]);
  useEffect(() => {
    if (!revealReadiness.current) return;
    revealReadiness.current = false;
    dialogRef.current?.querySelector('.launch-readiness')?.scrollIntoView({ block: 'nearest' });
  }, [gpuMode, profileId, extraOptions.privileged]);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null; dialogRef.current?.focus(); return () => previous?.focus();
  }, []);
  useEffect(() => {
    if (!canUseAdb) { setKeyLoading(false); setKeys([]); setAdbKeyId(''); setKeyError(''); return; }
    let active = true; setKeyLoading(true); setKeyError('');
    void Promise.allSettled([api.listAdbPublicKeys(), api.adbUserKey(), settingsApi.preferences()]).then(([uploaded, farm, preferences]) => {
      if (!active) return;
      if (uploaded.status === 'fulfilled') {
        setKeys(uploaded.value); const defaultKeyId = preferences.status === 'fulfilled' ? preferences.value.defaultAdbKeyId : null;
        setAdbKeyId(current => current && uploaded.value.some(key => key.id === current) ? current : defaultKeyId && uploaded.value.some(key => key.id === defaultKeyId) ? defaultKeyId : '');
      } else { setKeys([]); setAdbKeyId(''); }
      setFarmKeyExists(farm.status === 'fulfilled' ? Boolean(farm.value.key) : null);
      if (uploaded.status === 'rejected' || farm.status === 'rejected' || preferences.status === 'rejected') setKeyError(t('ui.88af43035260'));
    }).finally(() => { if (active) setKeyLoading(false); });
    return () => { active = false; };
  }, [keyLoadAttempt, canUseAdb]);
  const queueCompatible = readiness.state === 'busy';
  const noSlots = queueCompatible || (readiness.state === 'ready' && error === KNOWN_ERRORS.no_free_slots);
  const diskDefault = selectedProfile?.diskGb ?? 0;
  const diskMax = Math.max(diskDefault, selectedProfile?.diskMaxGb ?? diskDefault);
  const sdcardDefault = selectedProfile?.sdcardGb ?? 0;
  const sdcardMax = Math.max(sdcardDefault, selectedProfile?.sdcardMaxGb ?? sdcardDefault);
  const ownChoice = canEditLaunch && storageChoice?.profileId === profileId ? storageChoice : null;
  const diskGb = ownChoice?.diskGb ?? diskDefault;
  const sdcardGb = ownChoice?.sdcardGb ?? sdcardDefault;
  const showStorage = Boolean(selectedProfile) && (diskMax > diskDefault || sdcardMax > 0);
  const storageValid = !showStorage || (Number.isInteger(diskGb) && diskGb >= Math.min(2, diskDefault) && diskGb <= diskMax && Number.isInteger(sdcardGb * 1024) && (sdcardGb === 0 || sdcardGb >= 0.125) && sdcardGb <= sdcardMax);
  const launchOptions: SessionLaunchOptions = { ...extraOptions, ...(canEditLaunch && ownChoice ? { diskGb, sdCardMb: sdcardGb * 1024 } : {}) };
  const launchSettingsChanged = canEditLaunch && (hasLaunchDraftChanges(selectedProfile, draft) || diskGb !== diskDefault || sdcardGb !== sdcardDefault);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [connectionOpen, setConnectionOpen] = useState(!canEditLaunch);
  const [count, setCount] = useState(1);
  const joinQueue = async () => {
    if (busy || keyLoading || launchError || !(queueCompatible || noSlots) || !storageValid || !selectedProfile || selectedProfile.enabled === false) return;
    setBusy(true); setError('');
    try { await queueApi.join({ profileId, hostId: hostId || null, gpuMode, adbKeyId: adbKeyId || null, launchOptions }); notifyQueueChanged(); onQueued?.(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : t('ui.e19c87d5666e')); setBusy(false); }
  };
  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault(); if (busy || keyLoading || Boolean(launchError) || !selectedHost || !profileFitsHost || !storageValid) return; setBusy(true); setError('');
    try { rememberLaunch(profileId, gpuMode); await onCreate(selectedHost.id, profileId, adbKeyId || null, gpuMode, undefined, launchOptions, count); }
    catch (cause) { setError(cause instanceof Error ? cause.message : t('ui.16bb1217be82')); setBusy(false); }
  };
  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <div ref={dialogRef} tabIndex={-1} className="modal create-session-modal" role="dialog" aria-modal="true" aria-labelledby="create-heading" aria-describedby="create-description" onKeyDown={event => {
      if (event.key === 'Escape' && !busy) onClose();
      if (event.key === 'Tab') {
        const elements = [...(dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled):not([tabindex="-1"]), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], summary') || [])].filter(element => element.getClientRects().length > 0);
        const first = elements[0], last = elements.at(-1);
        if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    }}>
      <div className="modal-top"><div><h2 id="create-heading">{t('ui.f7556fd66224')}</h2><p id="create-description" className="modal-description sr-only">{t('ui.91fdf8e1a129')}</p></div><button type="button" className="icon-button" aria-label={t('ui.a7a4033657e8')} onClick={onClose} disabled={busy}><Icon name="close" size={19}/></button></div>
      <form onSubmit={event => void submit(event)}>
        <div className="create-session-body">
          <ProfilePicker profiles={profiles} selectedId={profileId} onSelect={chooseProfile} disabled={busy}/>
          <aside className="create-launch-panel" aria-label={t('ui.4e701eb36c6c')}>
            <div className="create-selected-profile">
              {environment && <>
                <dl className="create-summary-resources" hidden={settingsOpen || Boolean(keyError)}>
                  <div><dt><Icon name="phone" size={18}/>{t('ui.6ee4b2429634')}</dt><dd>{[isUnset(environment.cores) ? '' : t('copy.CreateSessionModal.c301bee9', { p0: environment.cores }), isUnset(environment.memory) ? '' : environment.memory].filter(Boolean).map((value, index) => <span key={index}>{index > 0 && ' · '}<bdi>{value}</bdi></span>)}{isUnset(environment.cores) && isUnset(environment.memory) && t('ui.95807be9fda9')}</dd></div>
                  <div><dt><Icon name="server" size={18}/>{t('ui.d7638391d8f0')}</dt><dd><bdi dir="ltr"><TranslatedText message="copy.CreateSessionModal.c640bd31" values={{ p0: effectiveProfile?.cpu ?? '—', p1: <bdi>{memoryLabel(effectiveProfile?.memoryMb)}</bdi> }} /></bdi></dd></div>
                </dl>
              </>}
            </div>
            {!canEditLaunch && <p className="create-field-hint create-launch-policy">{t('ui.31b16dcfbeeb')}</p>}
            <div className="create-launch-scroll">
              <div className="create-gpu-setting create-gpu-launch-setting" data-enabled={gpuMode === 'nvidia'}><label className="create-gpu-switch"><input type="checkbox" role="switch" aria-label={t('ui.e63574b998c7')} aria-describedby="create-gpu-help" checked={gpuMode === 'nvidia'} disabled={gpuSwitchDisabled} onChange={event => { revealReadiness.current = true; setGpuMode(event.target.checked ? 'nvidia' : 'software'); setError(''); }}/><span><strong>{t('ui.e63574b998c7')}</strong><small id="create-gpu-help">{gpuHint}</small></span></label></div>
              <LaunchReadiness readiness={readiness} admin={canConfigureContainer} alternative={hasAlternativeHost} onAutoHost={() => { setHostId(''); setError(''); }}/>
            </div>
          </aside>
          <details className="create-settings" open={settingsOpen || Boolean(keyError)} onToggle={event => setSettingsOpen((event.currentTarget as HTMLDetailsElement).open)}><summary>{canEditLaunch ? t('ui.b21e29568c60') : t('ui.4fc4baff4497')}<Icon name="arrowDown" size={16}/></summary>
          <div className="create-launch-settings">
            {canEditLaunch && <section className="create-settings-section" aria-labelledby="create-resources-title">
              <h4 id="create-resources-title">{t('ui.eba267d9f828')}</h4>
              <p className="create-field-hint" id="create-resources-hint">{t('ui.b549c7b74964')}</p>
              <div className="create-resource-fields">
                <h5>{t('ui.6ee4b2429634')}</h5><h5>{t('ui.04fba521d85b')}</h5>
                <label className="create-field"><span>{t('ui.6987f2403413')}</span><input type="number" aria-label={t('ui.849635da03ef')} aria-describedby="create-resources-hint" min={1} max={Math.min(16, effectiveProfile?.cpu ?? 16)} value={draft.guestCores === null ? '' : draft.guestCores ?? selectedProfile?.guestCores ?? ''} placeholder={t('ui.8dca2f783130')} disabled={busy || !selectedProfile} onChange={event => setLaunchField('guestCores', event.target.value || null)}/></label>
                <label className="create-field"><span>{t('ui.db9a4c7d4c19')}</span><input type="number" aria-label={t('ui.e62f9de2a503')} min={1} max={canConfigureContainer ? 16 : selectedProfile?.cpu ?? 16} value={draft.cpu ?? selectedProfile?.cpu ?? ''} disabled={busy || !selectedProfile} onChange={event => setLaunchField('cpu', event.target.value)}/></label>
                <label className="create-field"><span>{t('ui.e5011b9e7ecd')}</span><input type="number" aria-label={t('ui.43ec81e4a9a8')} aria-describedby="create-resources-hint" min={1024} max={Math.min(64512, (effectiveProfile?.memoryMb ?? 65536) - 1024)} step={1} value={draft.guestMemoryMb === null ? '' : draft.guestMemoryMb ?? selectedProfile?.guestMemoryMb ?? ''} placeholder={t('ui.8dca2f783130')} disabled={busy || !selectedProfile} onChange={event => setLaunchField('guestMemoryMb', event.target.value || null)}/></label>
                <label className="create-field"><span>{t('ui.e5011b9e7ecd')}</span><input type="number" aria-label={t('ui.27ed0bc1e3f8')} min={1024} max={canConfigureContainer ? 65536 : selectedProfile?.memoryMb ?? 65536} step={1} value={draft.memoryMb ?? selectedProfile?.memoryMb ?? ''} disabled={busy || !selectedProfile} onChange={event => setLaunchField('memoryMb', event.target.value)}/></label>
              </div>
              <p className="create-field-hint">{t('ui.e902c734b6f5')}{!canConfigureContainer && t('ui.9bdf2827ed33')}</p>
            </section>}
            {canEditLaunch && showStorage && <details className="create-setting-group create-storage-section"><summary><span id="create-storage-title">{t('ui.f8f37144a47b')}</span><Icon name="arrowDown" size={16}/></summary><div className="create-settings-section"><div className="create-storage-fields">
              <label className="create-field"><span>{t('ui.d4e8e3a8c9c0')}</span><input type="number" aria-label={t('ui.d4e8e3a8c9c0')} min={Math.min(2, diskDefault)} max={diskMax} value={diskGb} disabled={busy || diskMax <= diskDefault} onChange={event => setStorageChoice({ profileId, diskGb: Number(event.target.value), sdcardGb })}/><small className="create-field-hint"><TranslatedText message="copy.CreateSessionModal.2ab9468e" values={{ p0: diskMax }} /></small></label>
              {sdcardMax > 0 && <label className="create-field"><span>{t('ui.bc1e3fa107d5')}</span><input type="number" aria-label={t('ui.bc1e3fa107d5')} min={0} max={sdcardMax} step="any" value={sdcardGb} disabled={busy} onChange={event => setStorageChoice({ profileId, diskGb, sdcardGb: Number(event.target.value) })}/><small className="create-field-hint"><TranslatedText message="copy.CreateSessionModal.57a5b291" values={{ p0: sdcardMax }} /></small></label>}
            </div></div></details>}
            <details className="create-setting-group create-connection-section" open={connectionOpen || Boolean(keyError)} onToggle={event => setConnectionOpen(event.currentTarget.open)}>
              <summary><span id="create-session-options-title">{t('ui.c02a7c1a6d73')}</span><Icon name="arrowDown" size={16}/></summary>
              <div className="create-settings-section">
              <label className="create-count"><span>{t('ui.10f15cddae4d')}</span><div className="create-count-control"><input type="number" aria-label={t('ui.10f15cddae4d')} aria-describedby="create-count-hint" min={1} max={10} value={count} disabled={busy} onChange={event => setCount(Math.min(10, Math.max(1, Math.floor(Number(event.target.value)) || 1)))}/><small id="create-count-hint" className="create-field-hint">{t('ui.6286f7d505bc')}</small></div></label>
              <div className="create-connection-fields" data-with-host={canConfigureContainer || undefined}>
                {canConfigureContainer && <label className="create-host-select create-field"><span>{t('ui.30cc9dda72b1')}</span><select aria-label={t('ui.30cc9dda72b1')} value={hostId} onChange={event => { setHostId(event.target.value); setError(''); }} disabled={busy}><option value="">{t('ui.353cf589e95b')}</option>{hosts.map(host => <option key={host.id} value={host.id}>{host.name} · {availableSlots(host) > 0 ? t('copy.CreateSessionModal.c93d1f97', { p0: availableSlots(host) }) : host.disabled ? t('ui.f2d86ccb744a') : host.status !== 'online' ? t('ui.befa3ab80724') : t('ui.5adce7cf059b')}</option>)}{hostId && !manualHost && <option value={hostId}>{t('ui.1e1b042b1d46')}</option>}</select><span className="create-field-hint">{selectedHost ? t('copy.CreateSessionModal.cd0ae943', { p0: (hostId ? t('ui.0c52c0b5b345') : t('ui.f15af9ffe6c6')), p1: selectedHost.name, p2: availableSlots(selectedHost) }) : t('ui.31dec4fdf962')}</span></label>}
                {canUseAdb && <label className="create-adb-select create-field"><span>{t('ui.717f84f96767')}</span><select aria-label={t('ui.717f84f96767')} title={keys.find(key => key.id === adbKeyId)?.name || (farmKeyExists ? t('ui.5ddca3970fa0') : t('ui.90744120af43'))} value={adbKeyId} onChange={event => setAdbKeyId(event.target.value)} disabled={keyLoading || busy}><option value="">{farmKeyExists === true ? t('ui.56ec31742870') : farmKeyExists === false ? t('ui.90744120af43') : t('ui.56ec31742870')}</option>{keys.map(key => <option key={key.id} value={key.id}>{key.name}</option>)}</select><span className="create-field-hint" title={t('ui.97c49bd40fd5')}><a href="#/account/keys" onClick={onClose}>{farmKeyExists === false && !adbKeyId ? t('ui.ab5ad3353e3c') : t('ui.29ac90ff63c7')}</a></span></label>}
              </div>
              {keyLoading && <div className="create-key-status" role="status">{t('ui.6dfac7686952')}</div>}
              {keyError && <div className="inline-warning" role="alert">{localizeText(keyError)}<button type="button" className="text-button" onClick={() => setKeyLoadAttempt(value => value + 1)}>{t('ui.5189135a6110')}</button></div>}
              </div>
            </details>
            {selectedProfile && environment && <details className="create-container-details"><summary>{t('ui.d726d18c5ba9')}<Icon name="arrowDown" size={16}/></summary><div className="create-profile-meta">{profileFacts(environment).map(([label, value]) => <span key={label} title={label}><bdi dir={label === t('ui.c062341615dc') ? 'ltr' : 'auto'}>{value}</bdi></span>)}</div><dl className="create-image-facts"><div><dt>{t('ui.157705d4fc52')}</dt><dd><code dir="ltr">{selectedProfile.image || t('ui.0d836c1579f1')}</code></dd></div><div><dt>{t('ui.948a734972a9')}</dt><dd><code dir="ltr">{selectedProfile.emulatorParams?.trim() || t('ui.465370e8594b')}</code></dd></div></dl></details>}
            {canEditLaunch && <details className="create-advanced-settings">
              <summary>{t('ui.0b6042b8b114')}<Icon name="arrowDown" size={16}/></summary>
              <div className="create-advanced-body">
                <div className="create-settings-section">
                  <label htmlFor="launch-params" className="create-params-field create-field"><span>{t('ui.6945fd170daa')}</span><textarea id="launch-params" aria-label={t('ui.6945fd170daa')} rows={3} maxLength={500} value={draft.emulatorParams ?? selectedProfile?.emulatorParams ?? ''} placeholder={t('ui.1504db0723a1')} disabled={busy || !selectedProfile} onChange={event => setLaunchField('emulatorParams', event.target.value)} aria-describedby="launch-params-hint"/><small id="launch-params-hint" className="create-field-hint">{t('ui.3f5799d1dc38')}</small></label>
                  <details className="create-argument-help"><summary>{t('ui.f0bc889de07c')}<Icon name="arrowDown" size={16}/></summary><ul>
                    <li><TranslatedText message="copy.CreateSessionModal.dfe339a9" values={{ p0: <code>{t('ui.317224f219c8')}</code>, p1: <code>{t('ui.9ff835086160')}</code>, p2: <code>{t('ui.cef9a4c31524')}</code>, p3: <code>{t('ui.5d15206a3c5f')}</code>, p4: <code>{t('ui.c39c54f4d476')}</code> }} /></li>
                    <li><TranslatedText message="copy.CreateSessionModal.fcd5d8bb" values={{ p0: <code>{t('ui.6659290e34e8')}</code>, p1: <code>{t('ui.cf18e3c28158')}</code>, p2: <code>{t('ui.8528ddedb2c4')}</code>, p3: <code>{t('ui.327bd37cfb2c')}</code>, p4: <code>{t('ui.d2e9c2f9b08f')}</code> }} /></li>
                    <li><TranslatedText message="copy.CreateSessionModal.ccb388e1" values={{ p0: <code>{t('ui.589f50aa053f')}</code>, p1: <code>{t('ui.f7ba33858706')}</code> }} /></li>
                    <li><TranslatedText message="copy.CreateSessionModal.b9257f27" values={{ p0: <code>{t('ui.bc568c0b9c57')}</code>, p1: <code>{t('ui.a1c45afd0759')}</code>, p2: <code>{t('ui.b5e27df7955c')}</code> }} /></li>
                    <li><TranslatedText message="copy.CreateSessionModal.2a446b24" values={{ p0: <code>{t('ui.5614f179026b')}</code> }} /></li>
                  </ul></details>
                </div>
                <section className="create-settings-section" aria-labelledby="create-access-title">
                  <h4 id="create-access-title">{t('ui.a17a08ac1c86')}</h4>
                  <dl className="create-container-access"><div><dt>{t('ui.5cb3715e29e0')}</dt><dd>{t('ui.1f9bedeb6728')}</dd></div><div><dt>{t('ui.e63574b998c7')}</dt><dd>{gpuMode === 'nvidia' ? (gpuBackend === 'gpu' ? t('ui.95a47a2e8021') : t('ui.dcc000ca42a8')) : t('ui.20494f41aba3')}</dd></div></dl>
                  {canConfigureContainer && <div className="create-gpu-setting"><label className="create-gpu-switch"><span><strong>{t('ui.9a1ce9bbfff6')}</strong><small>{t('ui.805f8cecc58e')}</small></span><input type="checkbox" role="switch" aria-label={t('ui.9a1ce9bbfff6')} checked={launchOptions.privileged === true} disabled={busy || !selectedProfile} onChange={event => { revealReadiness.current = true; setDraft(current => ({ ...current, privileged: event.target.checked })); setError(''); }}/></label></div>}
                  <p className="create-field-hint">{t('ui.df250ffc8e87')}</p>
                </section>
              </div>
            </details>}
            {canEditLaunch && <div className="create-settings-actions"><button type="button" className="button outline create-reset" title={t('ui.8c1ad85ab600')} disabled={busy || !launchSettingsChanged} onClick={() => { setDraft({}); setStorageChoice(null); setError(''); }}>{t('ui.407f871778d3')}</button></div>}
            </div>
          </details>
        </div>
        <div className="create-session-footer"><div className="create-launch-status" data-state={error || launchError ? 'error' : keyLoading ? 'loading' : readiness.state} aria-live="polite">{error || launchError ? <span className="create-error" role="alert">{error || launchError}</span> : readiness.state !== 'ready' ? <span>{readiness.state === 'busy' ? t('ui.e893e50ad3d3') : t('ui.bb03b92faded')}</span> : keyLoading ? <span>{t('ui.8f22f5917af0')}</span> : selectedProfile ? <span><Icon name="check" size={15}/>{t('ui.023f3b8f41eb')}{gpuMode === 'nvidia' ? t('ui.bbc2d74cef73') : t('ui.da6ace803ef6')}</span> : <span>{t('ui.62975899f715')}</span>}</div><div className="modal-actions"><button type="button" className="button outline" onClick={onClose} disabled={busy}>{t('ui.8fbe9b75cbdf')}</button>{noSlots && profiles.length > 0 ? <button type="button" className="button primary" onClick={() => void joinQueue()} disabled={busy || keyLoading || Boolean(launchError) || !(queueCompatible || noSlots) || !storageValid || !selectedProfile || selectedProfile.enabled === false}>{t('ui.41c64fd5c674')}</button> : <button className="button primary" type="submit" disabled={busy || keyLoading || Boolean(launchError) || !selectedHost || !profileFitsHost || !storageValid}>{busy ? t('ui.2f6c41f7dfb1') : count > 1 ? t('ui.6a5418bb1355') + count : t('ui.c9d2fdd1623c')}<Icon name="arrowRight" size={17}/></button>}</div></div>
      </form>
    </div>
  </div>;
}
