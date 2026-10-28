import { FormSaveDock } from './FormSaveActions';
import { TranslatedText } from './TranslatedText';
import { Brand } from './Brand';
import { Login } from './Login';
import { LogoutDialog } from './LogoutDialog';
import { getLanguage, getLocale, localizeText, t } from './i18n';
import { useInterfaceLanguage } from './LanguageControl';
import type { SessionLaunchOptions } from './api';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AccessProvider, useAccess, can, roleLabel } from './permissions';
import { sectionPermission } from './admin-navigation';
import { api, ApiError, type AppConfig, type DeviceSession, type Host, type Profile, type User, type NavigationCounts } from './api';
import { Icon } from './icons';
import { SessionStartupProgress } from './SessionStartupProgress';
import { SessionStatusBadge } from './SessionStatusBadge';
import { SessionView } from './SessionView';
import { AdminWorkspace } from './AdminWorkspace';
import { SidebarNavigation } from './SidebarNavigation';
import { adminSectionFromHash, adminSectionInfo, type AdminSection } from './admin-navigation';
import { TokenManager } from './TokenManager';
import { UserSettingsPage } from './UserSettingsPage';
import { QueueWidget } from './QueueWidget';
import { SharedWithMe } from './SharedWithMe';
import { teamsApi, type MyLimits } from './teams-api';
import { SharedRedeemPage } from './ShareControl';
import { useNotificationPoller } from './NotificationSettings';
import { queueApi, type AppNotification as BackgroundNotification } from './queue-api';
import { settingsApi } from './settings-api';
import { applyUserPreferences, restoreUserPreferences } from './user-preferences';
import { CreateSessionModal, rememberLaunch } from './CreateSessionModal';
import { availableSlots } from './host-availability';
import { HostCard } from './HostCard';
import { RentDeviceModal } from './RentDeviceModal';
import { rentableDevices } from './devices';
import './Devices.css';
import { useNotifications } from './notifications';
import { useAdminDialog } from './useAdminDialog';

type Page = 'overview' | 'hosts' | 'admin' | 'tokens' | 'account';
type Route = { page: Exclude<Page, 'admin'> } | { page: 'admin'; section: AdminSection } | { page: 'session'; id: string } | { page: 'shared'; token: string };

function routeFromHash(): Route {
  const hash = window.location.hash.replace(/^#\/?/, '');
  if (hash.startsWith('session/')) {
    try {
      const id = decodeURIComponent(hash.slice(8));
      if (id) return { page: 'session', id };
    } catch { /* Invalid links return to the overview. */ }
  }
  if (hash.startsWith('shared/')) {
    const token = hash.slice(7);
    if (/^[A-Za-z0-9_-]{20,120}$/.test(token)) return { page: 'shared', token };
  }
  if (hash === 'admin' || hash.startsWith('admin/')) return { page: 'admin', section: adminSectionFromHash(window.location.hash) };
  if (hash.startsWith('account/')) return { page: 'account' };
  if (hash === 'hosts' || hash === 'tokens' || hash === 'account') return { page: hash };
  return { page: 'overview' };
}

function navigate(route: Route) {
  window.location.hash = route.page === 'shared' ? '/overview' : route.page === 'session' ? `/session/${encodeURIComponent(route.id)}` : route.page === 'admin' ? `/admin/${route.section}` : `/${route.page}`;
}

function displayError(error: unknown): string {
  return error instanceof Error ? error.message : t('ui.8f9c4884b8f9');
}

function formatDate(value: string | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : new Intl.DateTimeFormat(getLocale(), { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}



function EmptyState({ icon, title, detail }: { icon: 'phone' | 'server'; title: string; detail: string }) {
  return <div className="empty-state"><div className="empty-icon"><Icon name={icon} size={27} /></div><h3>{title}</h3><p>{detail}</p></div>;
}

function SessionCard({ session, host, profile, onRelease, onRepeat, busy, canManage }: {
  session: DeviceSession; host?: Host; profile?: Profile; canManage?: boolean; onRelease: () => void; onRepeat?: () => void; busy: boolean;
}) {
  const allowed = useAccess();
  const canOpen = session.status !== 'stopped' && session.status !== 'stopping';
  const name = session.label || session.profileName || profile?.name || t('ui.85e2179937ff');
  const canRepeat = onRepeat && profile && (!session.deviceKind || session.deviceKind === 'emulator');
  return <article className={'session-card' + (canOpen ? ' interactive-card' : '')}>
    <div className="session-card-top">
      <div className="session-card-state"><div className="session-card-icon"><Icon name="phone" size={22} /></div><SessionStatusBadge status={session.status} /></div>
      {allowed('sessions.stop') && <button type="button" className="icon-button danger-icon card-secondary-action session-card-release" title={t('ui.d5682c76be4c')} aria-label={t('ui.d5682c76be4c')} onClick={onRelease} disabled={busy || !canOpen}><Icon name="power" size={18} /></button>}
    </div>
    <h3 title={session.label ? (session.profileName || profile?.name || '') : undefined}>{canOpen ? <a className="card-primary-action" href={'#/session/' + encodeURIComponent(session.id)} aria-label={t('copy.App.e973c6b1', { p0: name })}><span className="session-card-name">{name}</span><Icon name="arrowRight" size={18} /></a> : name}</h3>
    <p className="session-meta">{session.label && (session.profileName || profile?.name) ? <>{session.profileName || profile?.name}<span className="middle-dot">·</span></> : null}{profile?.androidVersion ? `${t('ui.6d612a86bee4')} ${profile.androidVersion}` : t('ui.6d612a86bee4')} <span className="middle-dot">·</span> {session.hostName || host?.name || t('ui.e77a383ee52d')}</p>
    <div className="session-id">#{session.id.slice(0, 8)} <span>·</span> {formatDate(session.createdAt)}</div>
    <div className="session-card-footer">
      {session.status === 'starting' && <SessionStartupProgress progress={session.startupProgress} compact/>}
      {(canRepeat || (session.status === 'error' && canManage)) && <div className="session-card-actions">
        {canRepeat && <button type="button" className="button outline small card-secondary-action" onClick={onRepeat}><Icon name="plus" size={14}/>{t('ui.199b7ab0c3dc')}</button>}
        {session.status === 'error' && canManage && <a className="text-button card-secondary-action" href={'#/admin/journal?tab=logs&session=' + encodeURIComponent(session.id)}>{t('ui.102c44d966fa')}</a>}
      </div>}
    </div>
  </article>;
}

function ConfirmModal({ title, detail, action, danger, busy, context, error, onClose, onConfirm }: { title: string; detail: string; action: string; danger?: boolean; busy: boolean; context: { id: string; profile: string; owner?: string; host?: string }; error: string; onClose: () => void; onConfirm: () => void }) {
  const dialogRef = useAdminDialog(true, busy, onClose);
  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <div ref={dialogRef} tabIndex={-1} className="modal confirm-modal session-confirm-modal" role="alertdialog" aria-modal="true" aria-labelledby="session-confirm-heading" aria-describedby="session-confirm-detail">
      <div className="confirm-heading">
        <div className={`confirm-icon ${danger ? 'danger' : ''}`} aria-hidden="true"><Icon name="alert" size={22} /></div>
        <h2 id="session-confirm-heading">{title}</h2>
      </div>
      <dl className="session-confirm-context">
        <div><dt>{t('ui.dba20ab53801')}</dt><dd>{context.profile}</dd></div>
        {context.owner && <div><dt>{t('ui.e26fad285382')}</dt><dd>{context.owner}</dd></div>}
        {context.host && <div><dt>{t('ui.e77a383ee52d')}</dt><dd>{context.host}</dd></div>}
        <div><dt>{t('ui.f7aa03484689')}</dt><dd><code>{context.id}</code></dd></div>
      </dl>
      <p id="session-confirm-detail">{detail}</p>
      {error && <div className="inline-error" role="alert">{localizeText(error)}</div>}
      <div className="modal-actions">
        <button className="button outline" onClick={onClose} disabled={busy}>{t('ui.8fbe9b75cbdf')}</button>
        <button className={`button ${danger ? 'danger' : 'primary'}`} onClick={onConfirm} disabled={busy}>{busy ? t('ui.7e4f3baf839f') : action}</button>
      </div>
    </div>
  </div>;
}

function Dashboard({ user, sessionLimitValue, hosts, profiles, adminProfiles, sessions, page, adminSection = 'sessions', loading, error, allowLocalUsers, onRefresh, onCreate, onRent, onOpen, onRelease, onKill, onReleaseAll }: {
  user: User; sessionLimitValue: number; hosts: Host[]; profiles: Profile[]; adminProfiles: Profile[]; sessions: DeviceSession[]; page: Page; adminSection?: AdminSection; loading: boolean; error: string; allowLocalUsers: boolean;
  onRefresh: () => void; onCreate: () => void; onRent: () => void; onOpen: (id: string) => void; onRelease: (id: string) => void; onKill: (id: string) => void;
  onReleaseAll: (sessions: DeviceSession[]) => Promise<boolean>;
}) {
  const canViewDiagnostics = can(user, 'logs.view');
  const shownHosts = can(user, 'nodes.view') ? hosts : hosts.filter(host => host.status === 'online' && !host.disabled);
  const [bulkConfirm, setBulkConfirm] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);
  const hostMap = useMemo(() => new Map(hosts.map(host => [host.id, host])), [hosts, getLanguage()]);
  const profileMap = useMemo(() => new Map(profiles.map(profile => [profile.id, profile])), [profiles, getLanguage()]);
  const mine = sessions.filter(session => session.ownerId === user.id || !session.ownerId);
  const releasable = mine.filter(session => session.status !== 'stopped' && session.status !== 'stopping');
  const releaseAll = async () => {
    if (bulkBusy) return;
    setBulkBusy(true);
    try { if (await onReleaseAll(releasable)) setBulkConfirm(false); }
    finally { setBulkBusy(false); }
  };
  const sessionLimit = user.role === 'admin' ? 0 : sessionLimitValue;
  const limitReached = sessionLimit > 0 && sessions.filter(session => session.ownerId === user.id).length >= sessionLimit;
  const active = mine.filter(session => session.status === 'running' || session.status === 'starting').length;
  const freeSlots = hosts.reduce((sum, host) => sum + availableSlots(host), 0);
  const noSlots = !loading && !error && freeSlots === 0;
  const createDisabled = loading || Boolean(error) || limitReached;
  const createDisabledReason = loading ? t('ui.272592acf39c') : error ? t('ui.931ba9cd6604') : limitReached ? t('ui.d3fde0b38635', { p0: sessionLimit }) : undefined;
  return <>
    <div className="page-heading"><div><div className="breadcrumbs">{t('ui.3ef4a346c6df')}<span>/</span> {page === 'overview' ? t('ui.6b8377e0a6fa') : page === 'hosts' ? t('ui.f3a46c2f2b5c') : <>{t('ui.fe82037c693a')}<span>/</span> {adminSectionInfo[adminSection].title}</>}</div><div className="page-title-row"><h1>{page === 'overview' ? t('ui.6b8377e0a6fa') : page === 'hosts' ? t('ui.8e4cb48e8703') : adminSectionInfo[adminSection].title}</h1></div><p>{page === 'overview' ? t('ui.1169c0c2f63f') : page === 'hosts' ? t('ui.feefbed8bd52') : adminSectionInfo[adminSection].description}</p></div><div className="heading-actions" id="page-heading-actions">{page === 'overview' && can(user, 'sessions.create') && <button className="button primary" onClick={onCreate} disabled={createDisabled} title={createDisabledReason} aria-describedby={noSlots ? "slots-unavailable" : undefined}><Icon name="plus" size={19} />{t('ui.f7556fd66224')}</button>}{page === 'overview' && can(user, 'sessions.create') && rentableDevices(hosts).length > 0 && <button className="button primary" onClick={onRent}><Icon name="phone" size={19} />{t('ui.2ae7dc61e871')}</button>}</div></div>
    {error && <div className="banner-error" role="alert"><Icon name="alert" size={18} /><span>{localizeText(error)}</span><button onClick={onRefresh}>{t('ui.5189135a6110')}</button></div>}
    {page === 'overview' && noSlots && <aside className="slots-notice" aria-label={t('ui.2cc04b7cf152')}>
      <Icon name="info" size={20} />
      <div id="slots-unavailable" role="status"><strong>{t('ui.1f1133c06dc3')}</strong><span>{t('ui.a8db62c47266')}</span></div>
      {profiles.length > 0 && !limitReached && can(user, 'sessions.create') && <button className="button primary small" type="button" onClick={onCreate}>{t('ui.41c64fd5c674')}</button>}
    </aside>}
    {page === 'overview' && <div className="sessions-page-content">
      <section className="content-section overview-sessions" aria-labelledby="my-sessions-heading">
        <div className="section-heading sessions-section-heading">
          <div>
            <h2 id="my-sessions-heading">{t('ui.20fa69627c53')}</h2>
            <p>{sessionLimit > 0 ? t('ui.9e006a0af9d2', { p0: active, p1: Math.min(mine.length, sessionLimit), p2: sessionLimit }) : active > 0 ? t('ui.aecfbbbf7591', { p0: active }) : t('ui.ee848a47148e')}</p>
          </div>
          {can(user, 'sessions.stop') && releasable.length > 1 && <div className="bulk-actions">
            {bulkConfirm ? <>
              <span><TranslatedText message="copy.App.ddde06cc" values={{ p0: releasable.length }} /></span>
              <button type="button" className="text-button danger" disabled={bulkBusy} onClick={() => void releaseAll()}>{bulkBusy ? t('ui.e85da2d59b06') : t('ui.48d417de363d')}</button>
              <button type="button" className="text-button" disabled={bulkBusy} onClick={() => setBulkConfirm(false)}>{t('ui.8fbe9b75cbdf')}</button>
            </> : <button type="button" className="text-button danger" onClick={() => setBulkConfirm(true)}>{t('ui.2e0dabca3682')}{releasable.length})</button>}
          </div>}
        </div>
        {loading && !mine.length ? <div className="loading-box">{t('ui.f416ed081b69')}</div> : mine.length ? <div className="session-grid">
          {mine.map(session => <SessionCard key={session.id} canManage={canViewDiagnostics} session={session} host={hostMap.get(session.hostId)} profile={profileMap.get(session.profileId)} onRepeat={can(user, 'sessions.create') ? () => { rememberLaunch(session.profileId, session.gpuMode === 'nvidia' ? 'nvidia' : 'software'); onCreate(); } : undefined} onRelease={() => onRelease(session.id)} busy={false} />)}
        </div> : <div className="session-grid session-grid-empty">
          <article className="session-card session-create-card interactive-card" data-disabled={createDisabled || undefined}>
            <div className="session-card-icon"><Icon name="plus" size={22} /></div>
            <div className="session-empty-copy">
              <h3><button type="button" className="card-primary-action" onClick={onCreate} disabled={createDisabled} title={createDisabledReason} aria-label={t('ui.9da159743e3b')} aria-describedby="new-session-card-description">{t('ui.8b90af14df43')}</button></h3>
              <p className="session-meta" id="new-session-card-description">{createDisabledReason || t('ui.a4fdb44ca8c7')}</p>
            </div>
            <Icon name="arrowRight" size={20} />
          </article>
        </div>}
      </section>
      <div className="overview-collaboration"><QueueWidget /><SharedWithMe /></div>
    </div>}
    {page === 'hosts' && can(user, 'nodes.view') && <section className="content-section hosts-page"><div className="section-heading"><div><h2>{t('ui.c2870d5d5a76')}</h2><p>{can(user, 'nodes.manage') ? t('ui.f2e949304c42') : t('ui.e9397edfed57')}</p></div></div>{shownHosts.length ? <div className="hosts-grid">{shownHosts.map(host => <HostCard key={host.id} host={host} canManage={can(user, 'nodes.manage')} layout="row" />)}</div> : <EmptyState icon="server" title={t('ui.1aa02ebe1ebc')} detail={t('ui.1533ebea70f9')} />}</section>}
    {page === 'admin' && <AdminWorkspace section={adminSection} hosts={hosts} profiles={adminProfiles} sessions={sessions} allowLocalUsers={allowLocalUsers} onRefresh={onRefresh} onOpen={onOpen} onKill={onKill} />}
  </>;
}

export default function App() {
  useInterfaceLanguage();
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [booting, setBooting] = useState(true);
  const [bootError, setBootError] = useState('');
  const [route, setRoute] = useState<Route>(routeFromHash);
  const [missingSession, setMissingSession] = useState<string | null>(null);
  const [hosts, setHosts] = useState<Host[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [adminProfiles, setAdminProfiles] = useState<Profile[]>([]);
  const [sessions, setSessions] = useState<DeviceSession[]>([]);
  const [navigationCounts, setNavigationCounts] = useState<NavigationCounts | null>(null);
  const [myLimits, setMyLimits] = useState<MyLimits | null>(null);
  const [inventoryLoading, setInventoryLoading] = useState(true);
  const [inventoryError, setInventoryError] = useState('');
  const [modal, setModal] = useState<'create' | 'rent' | null>(null);
  const [confirm, setConfirm] = useState<{ id: string; kind: 'release' | 'kill'; session?: DeviceSession } | null>(null);
  const [logoutOpen, setLogoutOpen] = useState(false);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [confirmError, setConfirmError] = useState('');
  useEffect(() => setConfirmError(''), [confirm?.id, confirm?.kind]);
  const { notify } = useNotifications();
  const setToast = useCallback((message: string) => notify({ kind: 'info', title: message }), [notify]);
  const [mobileNav, setMobileNav] = useState(false);
  const inventoryRequest = useRef(0);
  const releaseAllPending = useRef(false);

  const boot = useCallback(async () => {
    setBooting(true); setBootError('');
    try {
      const nextConfig = await api.config();
      setConfig(nextConfig);
      try { setUser(await api.me()); }
      catch (cause) { if (!(cause instanceof ApiError) || cause.status !== 401) throw cause; setUser(null); }
    } catch (cause) { setBootError(displayError(cause)); }
    finally { setBooting(false); }
  }, []);

  useEffect(() => { void boot(); }, [boot]);
  useEffect(() => {
    if (!user) { restoreUserPreferences(); return; }
    restoreUserPreferences(user.id);
    let active = true;
    void settingsApi.preferences().then(preferences => {
      if (active) applyUserPreferences(preferences, user.id);
    }).catch(() => { /* Local copy remains active while the server is unavailable. */ });
    return () => { active = false; };
  }, [user?.id]);
  useEffect(() => {
    setMyLimits(null);
    if (!user) return;
    let active = true;
    void teamsApi.limits().then(value => { if (active) setMyLimits(value); }).catch(() => { /* The global limit stays in effect. */ });
    return () => { active = false; };
  }, [user?.id]);
  useEffect(() => {
    const expireSession = () => {
      inventoryRequest.current += 1;
      setUser(null); setHosts([]); setProfiles([]); setAdminProfiles([]); setSessions([]); setNavigationCounts(null);
      setInventoryLoading(true); setInventoryError('');
      setModal(null); setConfirm(null); navigate({ page: 'overview' });
    };
    window.addEventListener('rdf:unauthorized', expireSession);
    return () => window.removeEventListener('rdf:unauthorized', expireSession);
  }, []);
  useEffect(() => { const listener = () => { setRoute(routeFromHash()); window.scrollTo(0, 0); }; window.addEventListener('hashchange', listener); return () => window.removeEventListener('hashchange', listener); }, []);

  const observedSessions = useRef(new Map<string, DeviceSession['status']>());
  const readyNotified = useRef(new Set<string>());
  const observeSession = useCallback((session: DeviceSession) => {
    const previous = observedSessions.current.get(session.id);
    observedSessions.current.set(session.id, session.status);
    if (previous !== 'starting' || session.status !== 'running' || session.ownerId !== user?.id || readyNotified.current.has(session.id)) return;
    readyNotified.current.add(session.id);
    notify({ kind: 'success', title: t('ui.ad0b444760b8'), message: t('ui.1f5dac083811', { p0: session.id.slice(0, 8), p1: session.label || session.profileName || t('ui.dba20ab53801') }), key: `session-ready:${session.id}` });
  }, [notify, user?.id]);
  useEffect(() => { observedSessions.current.clear(); readyNotified.current.clear(); }, [user?.id]);

  const loadInventory = useCallback(async () => {
    if (!user) return;
    const requestId = ++inventoryRequest.current;
    void api.me().then(next => { if (requestId !== inventoryRequest.current) return; if (!next) { setUser(null); return; } setUser(previous => previous?.id === next.id && JSON.stringify([previous.roleId,previous.roleName,previous.permissions]) !== JSON.stringify([next.roleId,next.roleName,next.permissions]) ? next : previous); }).catch(() => {});
    setInventoryError('');
    // Counter failure must not prevent the session list from opening. Keep the last confirmed totals.
    void api.navigationCounts().then(counts => {
      if (requestId === inventoryRequest.current) setNavigationCounts(counts);
    }).catch(() => {});
    try {
      const [nextHosts, nextProfiles, nextSessions, nextAdminProfiles] = await Promise.all([api.hosts(), api.profiles(), can(user, 'sessions.view') ? api.sessions() : Promise.resolve([]), can(user, 'profiles.view') ? api.adminProfiles() : Promise.resolve([])]);
      if (requestId !== inventoryRequest.current) return;
      nextSessions.forEach(observeSession);
      setHosts(nextHosts); setProfiles(nextProfiles); setSessions(nextSessions); setAdminProfiles(nextAdminProfiles);
    } catch (cause) { if (requestId === inventoryRequest.current) setInventoryError(displayError(cause)); }
    finally { if (requestId === inventoryRequest.current) setInventoryLoading(false); }
  }, [user, observeSession]);
  const failedStarts = useRef(new Map<string, BackgroundNotification>());
  const notifyBackground = useCallback((item: BackgroundNotification) => {
    if (item.kind === 'session.ready' && item.sessionId) {
      if (readyNotified.current.has(item.sessionId)) return;
      readyNotified.current.add(item.sessionId);
    }
    if (item.kind === 'session.failed' && item.sessionId) {
      failedStarts.current.set(item.sessionId, item);
      if (failedStarts.current.size > 100) failedStarts.current.delete(failedStarts.current.keys().next().value!);
    }
    notify({
      kind: item.kind === 'session.failed' || item.kind === 'device.quarantined' ? 'error'
        : item.kind === 'session.ready' || item.kind === 'queue.assigned' ? 'success' : 'info',
      title: item.title,
      ...(item.kind === 'session.failed' && item.sessionId && can(user, 'logs.view') ? { action: { href: '#/admin/journal?tab=logs&session=' + encodeURIComponent(item.sessionId), label: t('ui.7c3975084b6a') } } : {}),
      messagePrefix: item.sessionId ? t('ui.71565c75af24', { p0: item.sessionId.slice(0, 8) }) : undefined,
      message: item.body,
      key: item.kind === 'session.failed' && item.sessionId ? `session-outcome:${item.sessionId}` : item.kind === 'session.ready' && item.sessionId ? `session-ready:${item.sessionId}` : `background:${item.id}`,
    });
  }, [notify, user?.role]);
  useNotificationPoller(user?.id, notifyBackground);
  const sessionNotFound = useCallback((id: string) => {
    const current = routeFromHash();
    if (current.page !== 'session' || current.id !== id) return;
    // Replace the broken URL so browser Back does not reopen the missing session.
    window.history.replaceState(window.history.state, '', '#/overview');
    setRoute({ page: 'overview' });
    window.scrollTo(0, 0);
    setConfirm(null);
    setSessions(items => items.filter(session => session.id !== id));
    setMissingSession(id);
    void loadInventory();
  }, [loadInventory]);
  useEffect(() => {
    if (route.page !== 'overview' || !missingSession) return;
    // Effects run after the Home page has committed; the toast survives SessionView unmounting.
    let active = true;
    const id = missingSession;
    // Cleanup can delete a failed start before the next session poll. Prefer
    // its actual failure and reuse the same key as the background notification.
    void queueApi.notifications(AbortSignal.timeout(5000)).then(({ notifications }) => {
      const failure = failedStarts.current.get(id) ?? notifications.find(item => item.sessionId === id && item.kind === 'session.failed');
      if (!active) return;
      if (failure) notifyBackground(failure);
      else notify({ kind: 'error', title: t('ui.275e64a58684'), message: t('ui.71565c75af24', { p0: id.slice(0, 8) }), key: `session-outcome:${id}` });
      setMissingSession(null);
    }).catch(() => {
      if (!active) return;
      notify({ kind: 'error', title: t('ui.275e64a58684'), message: t('ui.71565c75af24', { p0: id.slice(0, 8) }), key: `session-outcome:${id}` });
      setMissingSession(null);
    });
    return () => { active = false; };
  }, [route.page, missingSession, notify, notifyBackground]);

  // Every click on a sidebar entry reloads the data and remounts the page, even when it is already open.
  const [refreshKey, setRefreshKey] = useState(0);
  const refreshView = () => { setMobileNav(false); setRefreshKey(value => value + 1); void loadInventory(); };

  useEffect(() => {
    if (!user) return;
    void loadInventory();
    const timer = window.setInterval(() => void loadInventory(), 10000);
    const refreshOnFocus = () => void loadInventory();
    window.addEventListener('focus', refreshOnFocus);
    return () => { window.clearInterval(timer); window.removeEventListener('focus', refreshOnFocus); };
  }, [user, loadInventory]);


  const createSession = async (hostId: string, profileId: string, adbKeyId: string | null, gpuMode?: 'software' | 'nvidia', storage?: { diskGb?: number; sdcardGb?: number }, launchOptions?: SessionLaunchOptions, count = 1) => {
    const notificationKey = `launch-request:${Date.now()}`;
    notify({ kind: 'info', pending: true, title: t('ui.1f7b094bc0fa'), message: count > 1 ? t('ui.27d547d26819', { p0: count }) : profiles.find(profile => profile.id === profileId)?.name, key: notificationKey, allowInModal: true });
    let first: { id: string };
    try { first = await api.createSession(hostId, profileId, adbKeyId, gpuMode, storage, launchOptions); }
    catch (error) { notify({ kind: 'error', title: t('ui.37f039b09ee3'), message: displayError(error), key: notificationKey, allowInModal: true }); throw error; }
    observedSessions.current.set(first.id, 'starting');
    if (count <= 1) {
      setModal(null); notify({ kind: 'info', title: t('ui.12ddafe21676'), message: t('ui.71565c75af24', { p0: first.id.slice(0, 8) }), key: notificationKey });
      navigate({ page: 'session', id: first.id }); void loadInventory();
      return;
    }
    let started = 1;
    let failure = '';
    for (; started < count; started++) {
      try { const next = await api.createSession(hostId, profileId, adbKeyId, gpuMode, storage, launchOptions); observedSessions.current.set(next.id, 'starting'); }
      catch (cause) { failure = cause instanceof Error ? cause.message : t('ui.7350e2b3b328'); break; }
    }
    setModal(null);
    notify({ kind: failure ? 'error' : 'info', title: failure ? t('ui.cefca364c3cd', { p0: started, p1: count }) : t('ui.f6a94ecaf30b', { p0: started }), ...(failure ? { message: failure } : {}), key: notificationKey });
    await loadInventory(); navigate({ page: 'overview' });
  };

  const releaseAllSessions = async (targets: DeviceSession[]): Promise<boolean> => {
    if (releaseAllPending.current || !targets.length) return false;
    releaseAllPending.current = true;
    const key = 'sessions.bulkRelease';
    notify({ kind: 'info', pending: true, title: t('sessions.bulkReleasePending'), key });
    try {
      const results = await Promise.allSettled(targets.map(session => api.releaseSession(session.id)));
      const accepted = new Map<string, boolean>();
      const failed: string[] = [];
      results.forEach((result, index) => {
        const session = targets[index]!;
        if (result.status === 'fulfilled') accepted.set(session.id, result.value.released === true);
        else failed.push((session.label || session.profileName || t('ui.f7aa03484689')) + ' · #' + session.id.slice(0, 8) + ': ' + displayError(result.reason));
      });
      inventoryRequest.current += 1;
      setSessions(items => items.flatMap(session => !accepted.has(session.id) ? [session]
        : accepted.get(session.id) ? [] : [{ ...session, status: 'stopping' as const }]));
      notify({ kind: failed.length ? 'error' : 'info', title: t(failed.length ? 'sessions.bulkReleaseFailed' : 'sessions.bulkReleaseAccepted'),
        message: failed.length ? t('sessions.bulkReleaseSummary', { p0: accepted.size, p1: failed.length }) : t('sessions.bulkReleaseCleanup', { p0: accepted.size }),
        ...(failed.length ? { details: failed.join('\n') } : {}), key });
      void loadInventory();
      return failed.length === 0;
    } finally { releaseAllPending.current = false; }
  };

  const confirmAction = async () => {
    if (!confirm || confirmBusy) return;
    const action = confirm;
    const session = action.session ?? sessions.find(item => item.id === action.id);
    const name = session?.label?.trim() || session?.profileName?.trim() || profiles.find(profile => profile.id === session?.profileId)?.name || t('ui.f7aa03484689');
    const identity = `${name} · #${action.id.slice(0, 8)}`;
    setConfirmBusy(true); setConfirmError('');
    try {
      const result = action.kind === 'kill'
        ? await api.killSession(action.id)
        : await api.releaseSession(action.id);
      // Acceptance is durable on the server. Leave immediately; neither device
      // cleanup nor a slow inventory refresh should hold the user on this page.
      inventoryRequest.current += 1;
      setSessions(items => result.released
        ? items.filter(session => session.id !== action.id)
        : items.map(session => session.id === action.id ? { ...session, status: 'stopping' } : session));
      setConfirm(null);
      const currentRoute = routeFromHash();
      if (currentRoute.page === 'session' && currentRoute.id === action.id) navigate({ page: 'overview' });
      notify(result.released
        ? { kind: 'info', title: t('ui.81c7e64d3d07'), message: t('ui.b3d7e4123e9b', { p0: identity }) }
        : { kind: 'info', title: t('ui.a5d1f400c97e'), message: t('ui.baf3714c873c', { p0: identity }) });
      void loadInventory();
    } catch (cause) { setConfirmError(displayError(cause)); }
    finally { setConfirmBusy(false); }
  };

  const logout = async () => {
    try { await api.logout(); }
    catch (cause) {
      if (!(cause instanceof ApiError) || cause.status !== 401) {
        throw cause;
      }
    }
    setLogoutOpen(false);
    inventoryRequest.current += 1;
    setUser(null); setHosts([]); setProfiles([]); setAdminProfiles([]); setSessions([]); setNavigationCounts(null);
    setInventoryLoading(true); setInventoryError(''); navigate({ page: 'overview' });
  };

  if (booting) return <div className="boot-screen"><Brand /><div className="loading-ring" /><span>{t('ui.808f3aae25c0')}</span></div>;
  if (bootError || !config) return <div className="boot-screen"><Brand /><div className="boot-error"><Icon name="alert" size={25} /><h1>{t('ui.b323a1b637de')}</h1><p>{bootError || t('ui.7f8942516a7e')}</p><button className="button primary" onClick={() => void boot()}>{t('ui.5189135a6110')}</button></div></div>;
  if (!user) return <Login config={config} onLogin={next => { inventoryRequest.current += 1; setInventoryLoading(true); setUser(next); }} />;

  const allowedRoute: Route = (route.page === 'admin' && !can(user, sectionPermission[route.section])) || (route.page === 'hosts' && !can(user, 'nodes.view')) || (route.page === 'tokens' && !can(user, 'tokens.personal')) || (route.page === 'session' && !can(user, 'sessions.view')) ? (can(user, 'sessions.view') ? { page: 'overview' } : { page: 'account' }) : (route.page === 'overview' && !can(user, 'sessions.view') ? { page: 'account' } : route);
  const confirmedSession = confirm ? confirm.session ?? sessions.find(session => session.id === confirm.id) : undefined;
  const confirmContext = confirm ? { id: confirm.id, profile: confirmedSession?.profileName || profiles.find(profile => profile.id === confirmedSession?.profileId)?.name || t('ui.85e2179937ff'), owner: confirmedSession?.ownerName || confirmedSession?.ownerId, host: confirmedSession?.hostName || hosts.find(host => host.id === confirmedSession?.hostId)?.name || confirmedSession?.hostId } : null;
  const currentPage: Page = allowedRoute.page === 'session' || allowedRoute.page === 'shared' ? 'overview' : allowedRoute.page;
  return <AccessProvider user={user}><div className="app-shell">
    <aside className={`sidebar ${mobileNav ? 'mobile-open' : ''}`}><div className="sidebar-brand"><a className="brand-link" href="#/overview" aria-label={t('ui.dc22f0654c57')} onClick={refreshView}><Brand /></a><button className="icon-button mobile-close" onClick={() => setMobileNav(false)} aria-label={t('ui.980d22e392a7')}><Icon name="close" size={20} /></button></div><SidebarNavigation page={currentPage} section={allowedRoute.page === 'admin' ? allowedRoute.section : undefined} user={user} counts={navigationCounts} onNavigate={refreshView} /><div className="sidebar-bottom"><button className={`side-profile ${currentPage === 'account' ? 'active' : ''}`} onClick={() => { navigate({ page: 'account' }); refreshView(); }} title={`${user.displayName || user.username} · ${roleLabel(user)}`} aria-label={t('ui.32fe3de56050')}><span className="avatar">{(user.displayName || user.username).slice(0, 1).toUpperCase()}{user.role === 'admin' && <span className="role-badge" aria-label={t('ui.6c7719973e58')}><Icon name="shield" size={10} strokeWidth={2.6} /></span>}</span><span className="side-profile-name">{user.displayName || user.username}<small>{roleLabel(user)}</small></span></button><button className="side-logout" onClick={() => setLogoutOpen(true)}><Icon name="logout" size={18} /><span>{t('ui.5690c2e63b9d')}</span></button></div></aside>
    {mobileNav && <div className="nav-scrim" onClick={() => setMobileNav(false)} />}
    <div className="app-main"><FormSaveDock/><header className="topbar"><button className="icon-button mobile-menu" onClick={() => setMobileNav(true)} aria-label={t('ui.b2bbe9885780')}><Icon name="menu" size={21} /></button><div className="topbar-context"><span className="connection-dot" />{t('ui.297c7852691a')}</div><div className="topbar-user"><span className="avatar">{(user.displayName || user.username).slice(0, 1).toUpperCase()}</span><span>{user.displayName || user.username}<small>{roleLabel(user)}</small></span></div></header><main key={refreshKey} className={allowedRoute.page === 'session' ? 'main-content session-main' : `main-content page-${allowedRoute.page}`}>{allowedRoute.page === 'shared' ? <SharedRedeemPage token={allowedRoute.token} onOpen={id => navigate({ page: 'session', id })} onCancel={() => setRoute({ page: 'overview' })} /> : allowedRoute.page === 'session' ? <SessionView key={allowedRoute.id} sessionId={allowedRoute.id} user={user} onBack={() => navigate({ page: 'overview' })} onNotFound={sessionNotFound} onRelease={session => setConfirm({ id: session.id, kind: 'release', session })} onKill={can(user, 'sessions.manageAll') ? session => setConfirm({ id: session.id, kind: 'kill', session }) : undefined} onObserved={observeSession} onUpdated={() => void loadInventory()} /> : allowedRoute.page === 'tokens' ? <TokenManager user={user} onChanged={() => void loadInventory()} /> : allowedRoute.page === 'account' ? <UserSettingsPage user={user} /> : <Dashboard user={user} sessionLimitValue={myLimits?.maxSessions ?? config.limits?.maxSessionsPerUser ?? 0} hosts={hosts} profiles={profiles} adminProfiles={adminProfiles} sessions={sessions} page={allowedRoute.page} adminSection={allowedRoute.page === 'admin' ? allowedRoute.section : undefined} loading={inventoryLoading} error={localizeText(inventoryError)} allowLocalUsers={config.authMethods.includes('local')} onRefresh={() => void loadInventory()} onCreate={() => setModal('create')} onRent={() => setModal('rent')} onOpen={id => navigate({ page: 'session', id })} onRelease={id => setConfirm({ id, kind: 'release' })} onKill={id => setConfirm({ id, kind: 'kill' })} onReleaseAll={releaseAllSessions} />}</main></div>
    {logoutOpen && <LogoutDialog onClose={() => setLogoutOpen(false)} onConfirm={logout} />}
    {modal === 'rent' && <RentDeviceModal devices={rentableDevices(hosts)} onClose={() => setModal(null)} onRented={session => { setModal(null); setToast(t('ui.b4976e1c20a1')); void loadInventory(); navigate({ page: 'session', id: session.id }); }} />}
    {modal === 'create' && <CreateSessionModal canConfigureContainer={can(user, 'sessions.configure')} hosts={hosts} profiles={profiles} allowedProfileIds={user.role === 'admin' ? null : myLimits?.allowedProfileIds ?? null} onClose={() => setModal(null)} onCreate={createSession} onQueued={() => { setModal(null); setToast(t('ui.a17fda82f223')); }} />}
    {confirm && confirmContext && <ConfirmModal error={confirmError} context={confirmContext} title={confirm.kind === 'kill' ? t('ui.3daad319d271') : t('ui.8de2e3939c0b')} detail={t('ui.a7303f8af6d3')} action={confirm.kind === 'kill' ? t('ui.064a949b1b2a') : t('ui.73cf3a18cd74')} danger busy={confirmBusy} onClose={() => setConfirm(null)} onConfirm={() => void confirmAction()} />}
  </div></AccessProvider>;
}
