import { getLocale, localizeText, t } from './i18n';
import { useEffect, useRef, useState } from 'react';
import type { DeviceSession, Host } from './api';
import { JournalEventDetails } from './JournalEventDetails';
import { actionDetail, logDetail, rentalDetail, type JournalDetail } from './journal-details';
import { settingsApi, type AuditRecord, type RentalRecord, type ServiceLogRecord, type JournalFilters } from './settings-api';
import { SessionDiagnosticLog } from './SessionDiagnosticLog';
import { ApplicationLogStream } from './ApplicationLogStream';
import { Icon } from './icons';
import './AdminJournal.css';

type HistoryTab = 'rentals' | 'actions' | 'logs';
type Tab = HistoryTab | 'application';

const actionLabels: Record<string, string> = {
  get 'account.profile_preset_saved'() { return t('ui.326b43cad165'); },
  get 'account.profile_preset_updated'() { return t('ui.dce8d8d4eb51'); },
  get 'account.profile_preset_deleted'() { return t('ui.a917068fd14d'); },
  get 'session.created'() { return t('ui.73d3528e1433'); },
  get 'session.admin_access'() { return t('ui.b38ea40261d2'); },
  get 'share.created'() { return t('ui.a9fc9a60945f'); },
  get 'share.redeemed'() { return t('ui.57a7fdd4d867'); },
  get 'share.revoked'() { return t('ui.20eb717c8ab6'); },
  get 'session.shared_access'() { return t('ui.5ee29a0fc2ce'); },
  get 'queue.joined'() { return t('ui.820d3a6ad73c'); },
  get 'queue.assigned'() { return t('ui.ac53cf019d6d'); },
  get 'device.quarantined'() { return t('ui.6541557e5501'); },
  get 'admin.device_sanitized'() { return t('ui.c3b1b7ba1903'); },
  get 'queue.cancelled'() { return t('ui.a84927083ab0'); },
  get 'webhook.created'() { return t('ui.6761355874d3'); },
  get 'webhook.deleted'() { return t('ui.f27dcc136c93'); },
  get 'session.running'() { return t('ui.60cd41a2b1b0'); },
  get 'session.stopping'() { return t('ui.63e7a52b7d37'); },
  get 'session.failed'() { return t('ui.5027846285bf'); },
  get 'session.released'() { return t('ui.81c7e64d3d07'); },
  get 'session.release_requested'() { return t('ui.01b8333d62e1'); },
  get 'session.force_release_requested'() { return t('ui.9e955fd524d5'); },
  get 'session.audio_changed'() { return t('ui.a991783e19de'); },
  get 'session.network_changed'() { return t('ui.5a1c80a2acce'); },
  get 'session.env_changed'() { return t('ui.f260e262aa57'); },
  get 'session.orientation_changed'() { return t('ui.f421726688e2'); },
  get 'session.file_uploaded'() { return t('ui.e7eff57244f6'); },
  get 'app.uploaded'() { return t('ui.268f79f3c348'); },
  get 'app.deleted'() { return t('ui.658656f0b558'); },
  get 'session.app_installed'() { return t('ui.014571e5fcf7'); },
  get 'session.adb_command'() { return t('ui.e9f5f65a3aef'); },
  get 'session.adb_port_opened'() { return t('ui.d94f4b9d5f11'); },
  get 'session.adb_port_revoked'() { return t('ui.0eccdf74742b'); },
  get 'account.profile_updated'() { return t('ui.1d073dde43dd'); },
  get 'account.preferences_updated'() { return t('ui.b8a43038f321'); },
  get 'account.password_changed'() { return t('ui.bdd881c6253e'); },
  get 'account.adb_key_created'() { return t('ui.9ec74419e686'); },
  get 'account.adb_key_rotated'() { return t('ui.10595d881fd3'); },
  get 'account.adb_public_key_added'() { return t('ui.650e6ff2a728'); },
  get 'account.adb_public_key_renamed'() { return t('audit.adbKeyRenamed'); },
  get 'account.adb_public_key_deleted'() { return t('ui.5b23d58d209f'); },
  get 'account.token_created'() { return t('ui.2bb69c9aa5a4'); },
  get 'account.token_revoked'() { return t('ui.c0f182bce2cc'); },
  get 'admin.launch_settings_updated'() { return t('ui.b8a01c3d56ad'); },
  get 'admin.host_settings_updated'() { return t('ui.1cc683ed2c05'); },
  get 'admin.node_removed'() { return t('ui.fd72544edd6a'); },
  get 'admin.profile_created'() { return t('ui.6407db678754'); },
  get 'admin.profile_updated'() { return t('ui.483c6454f0ed'); },
  get 'admin.profile_disabled'() { return t('ui.9772de32a091'); },
  get 'admin.profile_deleted'() { return t('ui.65ac750904cd'); },
  get 'role.created'() { return t('audit.roleCreated'); },
  get 'role.updated'() { return t('audit.roleUpdated'); },
  get 'role.deleted'() { return t('audit.roleDeleted'); },
  get 'user.role_changed'() { return t('audit.roleAssigned'); },
  get 'images.cleanup_requested'() { return t('audit.imageCleanupRequested'); },
  get 'images.cleanup_done'() { return t('audit.imageCleanupDone'); },
  get 'images.cleanup_failed'() { return t('audit.imageCleanupFailed'); },
  get 'images.policy_updated'() { return t('audit.imagePolicyUpdated'); },
  get 'admin.user_created'() { return t('ui.57225885a460'); },
  get 'admin.user_removed'() { return t('ui.4bf44dca589b'); },
  get 'admin.user_password_reset'() { return t('ui.8d46d8e4a7d0'); },
  get 'admin.team_created'() { return t('ui.aa4e08ef0a59'); },
  get 'admin.team_updated'() { return t('ui.586fd374f5c4'); },
  get 'admin.team_deleted'() { return t('ui.34b29b72b4fa'); },
  get 'admin.team_members_updated'() { return t('ui.04ea8688e02b'); },
  get 'admin.team_profiles_updated'() { return t('ui.e51816c9e53b'); },
  get 'admin.system_token_created'() { return t('ui.1e9794e3f5d5'); },
  get 'admin.system_token_revoked'() { return t('ui.b595378e3e0d'); },
  get 'admin.agent_credential_created'() { return t('ui.a0270a23bc3e'); },
  get 'admin.agent_credential_revoked'() { return t('ui.7cc66f898fd2'); },
  get 'auth.login'() { return t('ui.63f5c2c2f95a'); },
  get 'auth.logout'() { return t('ui.75cd24c315d4'); },
};

const logLabels: Record<string, string> = {
  get 'agent.online'() { return t('ui.bdf79b7bf155'); },
  get 'agent.offline'() { return t('ui.f17fdb517852'); },
  get 'emulator.failed'() { return t('ui.d833a48d83f0'); },
  get 'emulator.released'() { return t('ui.0a07028eb857'); },
  get 'emulator.start_ended'() { return t('ui.9a20865467a1'); },
  get 'api.internal_error'() { return t('ui.541dac4dbfa3'); },
  get 'websocket.upgrade_error'() { return t('ui.4540bc20b1f9'); },
  get 'adb.listener_error'() { return t('ui.44beb240cd76'); },
};

function dateLabel(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' :
    new Intl.DateTimeFormat(getLocale(), { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : t('ui.311244b40431');
}

function journalLocation(): { tab: Tab; host: string; session: string } {
  const query = new URLSearchParams(window.location.hash.split('?')[1] || '');
  const tab = query.get('tab');
  return { tab: tab === 'logs' || tab === 'actions' || tab === 'application' ? tab : 'rentals', host: query.get('host') || '', session: query.get('session') || '' };
}

export function AdminJournal({ hosts, sessions }: { hosts: Host[]; sessions: DeviceSession[] }) {
  const [location, setLocation] = useState(journalLocation);
  const [tab, setTab] = useState<Tab>(location.tab);
  const [detail, setDetail] = useState<JournalDetail | null>(null);
  const requestVersion = useRef<Record<HistoryTab, number>>({ rentals: 0, actions: 0, logs: 0 });
  const selectedTab = useRef(tab);
  selectedTab.current = tab;
  const hostName = (id: string | null) => hosts.find(host => host.id === id)?.name || id || '—';
  const hostLabel = (host: Host) => host.name + (host.hostIp ? ' · ' + host.hostIp : '');
  const initialFilters = (): Record<HistoryTab, JournalFilters> => ({ rentals: location.tab === 'rentals' && location.host ? { host: location.host } : {}, actions: {}, logs: location.tab === 'logs' ? { ...(location.host ? { host: location.host } : {}), ...(location.session ? { session: location.session } : {}) } : {} });
  const [rentals, setRentals] = useState<RentalRecord[]>([]);
  const [actions, setActions] = useState<AuditRecord[]>([]);
  const [logs, setLogs] = useState<ServiceLogRecord[]>([]);
  const [cursors, setCursors] = useState<Record<HistoryTab, string | null>>({ rentals: null, actions: null, logs: null });
  const [loaded, setLoaded] = useState<Record<HistoryTab, boolean>>({ rentals: false, actions: false, logs: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [drafts, setDrafts] = useState<Record<HistoryTab, JournalFilters>>(initialFilters);
  const [applied, setApplied] = useState<Record<HistoryTab, JournalFilters>>(initialFilters);

  const load = async (section: HistoryTab, before: string | null = null, filters: JournalFilters = applied[section]) => {
    const version = ++requestVersion.current[section];
    setBusy(true); setError('');
    try {
      if (section === 'rentals') {
        const page = await settingsApi.allRentals(before, 25, filters);
        if (requestVersion.current[section] !== version) return;
        setRentals(previous => before ? [...previous, ...page.rentals] : page.rentals);
        setCursors(previous => ({ ...previous, rentals: page.nextCursor }));
      } else if (section === 'actions') {
        const page = await settingsApi.audit(before, 25, filters);
        if (requestVersion.current[section] !== version) return;
        setActions(previous => before ? [...previous, ...page.events] : page.events);
        setCursors(previous => ({ ...previous, actions: page.nextCursor }));
      } else {
        const page = await settingsApi.logs(before, filters.session ? 100 : 25, filters);
        if (requestVersion.current[section] !== version) return;
        setLogs(previous => before ? [...previous, ...page.events] : page.events);
        setCursors(previous => ({ ...previous, logs: page.nextCursor }));
      }
      setLoaded(previous => ({ ...previous, [section]: true }));
    } catch (cause) { if (selectedTab.current === section && requestVersion.current[section] === version) setError(errorText(cause)); }
    finally { if (selectedTab.current === section && requestVersion.current[section] === version) setBusy(false); }
  };

  const updateDraft = (name: keyof JournalFilters, value: string) => {
    if (tab === 'application') return;
    setDrafts(previous => ({ ...previous, [tab]: { ...previous[tab], [name]: value } }));
  };

  const applyFilters = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (tab === 'application') return;
    setApplied(previous => ({ ...previous, [tab]: drafts[tab] }));
    if (tab !== 'logs' || !drafts.logs.session) void load(tab, null, drafts[tab]);
  };

  const clearFilters = () => {
    if (tab === 'application') return;
    setDrafts(previous => ({ ...previous, [tab]: {} }));
    setApplied(previous => ({ ...previous, [tab]: {} }));
    void load(tab, null, {});
  };

  useEffect(() => {
    const sync = () => {
      const next = journalLocation();
      setLocation(next); setTab(next.tab); setDetail(null);
      if (next.tab === 'application') return;
      const filters = { ...(next.host && next.tab !== 'actions' ? { host: next.host } : {}), ...(next.session && next.tab === 'logs' ? { session: next.session } : {}) };
      setDrafts(previous => ({ ...previous, [next.tab]: filters }));
      setApplied(previous => ({ ...previous, [next.tab]: filters }));
      setLoaded(previous => ({ ...previous, [next.tab]: false }));
    };
    window.addEventListener('hashchange', sync);
    return () => window.removeEventListener('hashchange', sync);
  }, []);

  useEffect(() => {
    setBusy(false); setError('');
    if (tab !== 'application' && !loaded[tab] && !(tab === 'logs' && applied.logs.session)) void load(tab);
    // The active tab is the only view that needs a request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, location]);

  return <section id="adm-journal" className="admin-journal" aria-labelledby="admin-journal-heading">
    <div className="section-heading">
      <div><h2 id="admin-journal-heading">{t('ui.609127f541c9')}</h2><p>{t('ui.ace7b869cf5a')}</p></div>
    </div>
    <div className="admin-journal-tabs" role="tablist" aria-label={t('ui.53b7b013efa1')}>
      <button type="button" role="tab" aria-selected={tab === 'rentals'} className={tab === 'rentals' ? 'selected' : ''} onClick={() => setTab('rentals')}>{t('ui.e1b63386a6f0')}</button>
      <button type="button" role="tab" aria-selected={tab === 'actions'} className={tab === 'actions' ? 'selected' : ''} onClick={() => setTab('actions')}>{t('ui.cad123465b9e')}</button>
      <button type="button" role="tab" aria-selected={tab === 'logs'} className={tab === 'logs' ? 'selected' : ''} onClick={() => setTab('logs')}>{t('ui.081d8823d903')}</button>
      <button type="button" role="tab" aria-selected={tab === 'application'} className={tab === 'application' ? 'selected' : ''} onClick={() => setTab('application')}>{t('ui.400d4bb34893')}</button>
    </div>
    {tab === 'application' ? <ApplicationLogStream /> : <>
    <details className="journal-filter-disclosure" key={tab + location.host + location.session}><summary>{t('ui.a69757b1dbe1')}{Object.values(applied[tab]).some(Boolean) && <span className="count-pill">{Object.values(applied[tab]).filter(Boolean).length}</span>}{applied[tab].host && <span className="journal-filter-host">{hostName(applied[tab].host!)}</span>}</summary>
    <form className="admin-journal-filters" onSubmit={applyFilters} aria-label={t('ui.61af88353976')}>
      {tab === 'rentals' && <>
        <label>{t('ui.2a5c42af7c00')}<input value={drafts.rentals.owner || ''} onChange={event => updateDraft('owner', event.target.value)} placeholder={t('ui.5be12bfe49ea')} maxLength={100} /></label>
        <label>{t('ui.e77a383ee52d')}<select value={drafts[tab].host || ''} onChange={event => updateDraft('host', event.target.value)}><option value="">{t('ui.41dcab5fee02')}</option>{hosts.map(host => <option key={host.id} value={host.id}>{hostLabel(host)}</option>)}{drafts[tab].host && !hosts.some(host => host.id === drafts[tab].host) && <option value={drafts[tab].host}>{drafts[tab].host} {t('ui.da72e467c1ff')}</option>}</select></label>
      </>}
      {tab === 'actions' && <>
        <label>{t('ui.6665414a26a7')}<input value={drafts.actions.actor || ''} onChange={event => updateDraft('actor', event.target.value)} placeholder={t('ui.5be12bfe49ea')} maxLength={100} /></label>
        <label>{t('ui.6b53aafe28bd')}<select value={drafts.actions.action || ''} onChange={event => updateDraft('action', event.target.value)}>
          <option value="">{t('ui.ca80a4dbcec6')}</option>{Object.entries(actionLabels).map(([code, label]) => <option key={code} value={code}>{label}</option>)}
        </select></label>
      </>}
      {tab === 'logs' && <>
        <label>{t('ui.f7aa03484689')}<input value={drafts.logs.session || ''} onChange={event => updateDraft('session', event.target.value)} placeholder={t('ui.3c75a7106aae')} maxLength={36} pattern="[a-fA-F0-9]{8}(-[a-fA-F0-9-]{1,27})?" /></label>
        <label>{t('ui.e77a383ee52d')}<select value={drafts[tab].host || ''} onChange={event => updateDraft('host', event.target.value)}><option value="">{t('ui.41dcab5fee02')}</option>{hosts.map(host => <option key={host.id} value={host.id}>{hostLabel(host)}</option>)}{drafts[tab].host && !hosts.some(host => host.id === drafts[tab].host) && <option value={drafts[tab].host}>{drafts[tab].host} {t('ui.da72e467c1ff')}</option>}</select></label>
        <label>{t('ui.7f67af3d6cd9')}<select value={drafts.logs.severity || ''} onChange={event => updateDraft('severity', event.target.value)}>
          <option value="">{t('ui.56894a445022')}</option><option value="info">{t('ui.3319b9b01f2a')}</option><option value="warning">{t('ui.233a8e993aeb')}</option><option value="error">{t('ui.bf22dfeeba8b')}</option>
        </select></label>
        <label>{t('ui.095f8a67b557')}<select value={drafts.logs.service || ''} onChange={event => updateDraft('service', event.target.value)}>
          <option value="">{t('ui.f722105234c0')}</option><option value="server">{t('ui.5a03382f1926')}</option><option value="agent">{t('ui.d5fd08be28ee')}</option><option value="emulator">{t('ui.dba20ab53801')}</option>
        </select></label>
      </>}
      <label>{t('ui.07b8c0e68d5c')}<input type="date" value={drafts[tab].from || ''} onChange={event => updateDraft('from', event.target.value)} /></label>
      <label>{t('ui.b60ab9b42e52')}<input type="date" value={drafts[tab].to || ''} onChange={event => updateDraft('to', event.target.value)} /></label>
      <div className="admin-journal-filter-actions">
        <button className="button primary" type="submit" disabled={busy}>{t('ui.1e5bec3aab1c')}</button>
        <button className="text-button" type="button" onClick={clearFilters} disabled={busy}>{t('ui.407f871778d3')}</button>
      </div>
    </form></details>
    {error && <div className="inline-error admin-journal-error" role="alert">{localizeText(error)}<button type="button" className="text-button" onClick={() => void load(tab)}>{t('ui.5189135a6110')}</button></div>}
    {tab === 'logs' && applied.logs.session && <SessionDiagnosticLog filters={applied.logs} />}
    <div className="admin-journal-table-wrap">
      {tab === 'rentals' && (rentals.length ? <table className="admin-journal-table">
        <thead><tr><th>{t('ui.dba20ab53801')}</th><th>{t('ui.2a5c42af7c00')}</th><th>{t('ui.e77a383ee52d')}</th><th>{t('ui.4af5d2efadd7')}</th><th>{t('ui.37bd46eff01f')}</th></tr></thead>
        <tbody>{rentals.map(item => <tr className="interactive-card" key={item.id}>
          <td data-label={t('ui.dba20ab53801')}><div><button type="button" className="journal-detail-link card-primary-action" onClick={() => setDetail(rentalDetail(item, sessions.find(session => session.id === item.sessionId)))}>{item.profileName}</button><small>#{item.sessionId.slice(0, 8)}</small></div></td>
          <td data-label={t('ui.2a5c42af7c00')}>{item.ownerUsername}</td>
          <td data-label={t('ui.e77a383ee52d')}>{hosts.some(host => host.id === item.hostId) ? <a className="card-secondary-action" href={'#/admin/nodes?host=' + encodeURIComponent(item.hostId)}>{item.hostName}</a> : item.hostName}</td>
          <td data-label={t('ui.4af5d2efadd7')}>{dateLabel(item.createdAt)}</td>
          <td data-label={t('ui.37bd46eff01f')}>{item.endedAt ? dateLabel(item.endedAt) : <span className="admin-journal-state">{t('ui.983ec1306814')}</span>}</td>
        </tr>)}</tbody>
      </table> : <div className="admin-journal-empty">{busy ? t('ui.36c2b4c30e68') : t('ui.79cf1ab212f3')}</div>)}
      {tab === 'actions' && (actions.length ? <table className="admin-journal-table">
        <thead><tr><th>{t('ui.6711f073ab8b')}</th><th>{t('ui.6b53aafe28bd')}</th><th>{t('ui.6665414a26a7')}</th><th>{t('ui.4997a5143d9f')}</th><th>{t('ui.cedecb919c3a')}</th></tr></thead>
        <tbody>{actions.map(item => <tr className="interactive-card" key={item.id}>
          <td data-label={t('ui.6711f073ab8b')}>{dateLabel(item.occurredAt)}</td>
          <td data-label={t('ui.6b53aafe28bd')}><button type="button" className="journal-detail-link card-primary-action" onClick={() => setDetail(actionDetail(item, actionLabels[item.action] || item.action))}>{actionLabels[item.action] || item.action}</button></td>
          <td data-label={t('ui.6665414a26a7')}>{item.actorUsername || t('ui.6da215b1bdac')}</td>
          <td data-label={t('ui.4997a5143d9f')}><span className={'admin-journal-outcome ' + item.outcome}>{item.outcome === 'success' ? t('ui.4ad64e13c9a3') : item.outcome === 'denied' ? t('ui.a67b41793133') : t('ui.bf22dfeeba8b')}</span></td>
          <td data-label={t('ui.cedecb919c3a')}>{item.targetType ? item.targetType + ' · ' : ''}{item.targetId ? item.targetId.slice(0, 12) : '—'}</td>
        </tr>)}</tbody>
      </table> : <div className="admin-journal-empty">{busy ? t('ui.f8150443ae50') : t('ui.5e1e0ac2d35b')}</div>)}
      {tab === 'logs' && !applied.logs.session && (logs.length ? <table className="admin-journal-table">
        <thead><tr><th>{t('ui.6711f073ab8b')}</th><th>{t('ui.4212693d845d')}</th><th>{t('ui.095f8a67b557')}</th><th>{t('ui.7f67af3d6cd9')}</th><th>{t('ui.b24720e26cd3')}</th></tr></thead>
        <tbody>{logs.map(item => <tr className="interactive-card" key={item.id}>
          <td data-label={t('ui.6711f073ab8b')}>{dateLabel(item.occurredAt)}</td>
          <td data-label={t('ui.4212693d845d')}><div><button type="button" className="journal-detail-link card-primary-action" onClick={() => setDetail(logDetail(item, logLabels[item.code] || item.code, hostName(item.hostId)))}>{logLabels[item.code] || item.code}</button>{logLabels[item.code] && <small>{item.code}</small>}{item.message && <small className="journal-message">{item.message}</small>}</div></td>
          <td data-label={t('ui.095f8a67b557')}>{item.service}</td>
          <td data-label={t('ui.7f67af3d6cd9')}><span className={'admin-journal-outcome ' + item.severity}>{item.severity === 'info' ? t('ui.3319b9b01f2a') : item.severity === 'warning' ? t('ui.233a8e993aeb') : t('ui.bf22dfeeba8b')}</span></td>
          <td data-label={t('ui.b24720e26cd3')}><div className="journal-references">
            {item.hostId && (hosts.some(host => host.id === item.hostId)
              ? <a className="journal-reference-badge" href={'#/admin/nodes?host=' + encodeURIComponent(item.hostId)} title={hostName(item.hostId)}><Icon name="server" size={14}/><span>{hostName(item.hostId)}</span></a>
              : <span className="journal-reference-badge" title={hostName(item.hostId)}><Icon name="server" size={14}/><span>{hostName(item.hostId)}</span></span>)}
            {item.sessionId && <a className="journal-reference-badge" href={'#/admin/journal?tab=logs&session=' + encodeURIComponent(item.sessionId)} title={t('ui.6544c26e545f') + item.sessionId}><Icon name="list" size={14}/><span>{t('ui.6544c26e545f')}{item.sessionId.slice(0, 8)}</span></a>}
            {!item.hostId && !item.sessionId && '—'}
          </div></td>
        </tr>)}</tbody>
      </table> : <div className="admin-journal-empty">{busy ? t('ui.ee945d237207') : t('ui.678ffd4b9471')}</div>)}
    </div>
    {cursors[tab] && !(tab === 'logs' && applied.logs.session) && <button className="button outline admin-journal-more" type="button" onClick={() => void load(tab, cursors[tab])} disabled={busy}>{busy ? t('ui.22a5d9112486') : t('ui.c6826c783794')}</button>}
    </>}
    {detail && <JournalEventDetails detail={detail} hosts={hosts} sessions={sessions} onClose={() => setDetail(null)} />}
  </section>;
}
