import { ImageManagement } from './ImageManagement';
import { useAccess } from './permissions';
import { RoleManagement } from './RoleManagement';
import { getLocale, t } from './i18n';
import { useState } from 'react';
import type { DeviceSession, Host, Profile } from './api';
import { Icon } from './icons';
import { adminSections, type AdminSection } from './admin-navigation';
import { AdminTools } from './AdminTools';
import { AdminOps } from './AdminOps';
import { AdminJournal } from './AdminJournal';
import { NodeManagement } from './NodeManagement';
import { DeviceInventory } from './DeviceInventory';

const statusLabels = { get starting() { return t('ui.a207dbeaf97a'); }, get running() { return t('ui.0232a305412b'); }, get stopping() { return t('ui.546ea337315e'); }, get stopped() { return t('ui.39e74d43c11a'); }, get error() { return t('ui.bf22dfeeba8b'); } };
const dateLabel = (date: string) => new Intl.DateTimeFormat(getLocale(), { dateStyle: 'short', timeStyle: 'short' }).format(new Date(date));

type Props = {
  section: AdminSection;
  hosts: Host[];
  profiles: Profile[];
  sessions: DeviceSession[];
  allowLocalUsers: boolean;
  onRefresh: () => void;
  onOpen: (id: string) => void;
  onKill: (id: string) => void;
};

function Sessions({ hosts, profiles, sessions, onOpen, onKill }: Pick<Props, 'hosts' | 'profiles' | 'sessions' | 'onOpen' | 'onKill'>) {
  const can = useAccess();
  const [query, setQuery] = useState('');
  const profileName = (session: DeviceSession) => session.profileName || profiles.find(profile => profile.id === session.profileId)?.name || t('ui.85e2179937ff');
  const hostName = (session: DeviceSession) => session.hostName || hosts.find(host => host.id === session.hostId)?.name || '—';
  const visible = sessions.filter(session => [profileName(session), hostName(session), session.ownerName, session.ownerId, session.id].join(' ').toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  return <section className="admin-session-list" aria-labelledby="admin-sessions-heading">
    <div className="section-heading"><div><h2 id="admin-sessions-heading">{t('ui.156552b7ff38')}</h2><p>{t('ui.0c3439cbfe6a')}</p></div></div>
    {sessions.length > 0 && <label className="admin-search"><Icon name="search" size={18} /><input aria-label={t('ui.0f84efb378f0')} value={query} onChange={event => setQuery(event.target.value)} placeholder={t('ui.948a677bab79')} /></label>}
    {visible.length > 0 ? <div className="table-wrap"><table className="sessions-table admin-sessions-table"><thead><tr><th>{t('ui.dba20ab53801')}</th><th>{t('ui.e26fad285382')}</th><th>{t('ui.e77a383ee52d')}</th><th>{t('ui.0a39fbc65169')}</th><th>{t('ui.225077c6d479')}</th><th><span className="sr-only">{t('ui.cad123465b9e')}</span></th></tr></thead><tbody>
      {visible.map(session => <tr className={session.status === 'stopped' ? undefined : 'interactive-card'} key={session.id}>
        <td data-label={t('ui.dba20ab53801')}><div className="table-device"><span className="table-device-icon"><Icon name="phone" size={18} /></span><div><strong>{session.status === 'stopped' ? profileName(session) : <a className="card-primary-action" href={'#/session/' + encodeURIComponent(session.id)} onClick={event => { if (event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) { event.preventDefault(); onOpen(session.id); } }} aria-label={t('ui.e0edc9562b52') + profileName(session) + '», #' + session.id.slice(0, 8)}>{profileName(session)}</a>}</strong><small>#{session.id.slice(0, 8)}</small></div></div></td>
        <td data-label={t('ui.e26fad285382')}>{session.ownerName || session.ownerId || '—'}</td>
        <td data-label={t('ui.e77a383ee52d')}>{hostName(session)}</td>
        <td data-label={t('ui.0a39fbc65169')}>{dateLabel(session.createdAt)}</td>
        <td data-label={t('ui.225077c6d479')}><span className={'status-badge status-' + session.status}><span className="status-dot" />{statusLabels[session.status]}</span></td>
        <td data-label={t('ui.cad123465b9e')}><div className="row-actions">{session.status === 'error' && <a className="text-button card-secondary-action" href={'#/admin/journal?tab=logs&host=' + encodeURIComponent(session.hostId)}>{t('ui.0eaba72ab999')}</a>}{can('sessions.manageAll') && <button className="text-button danger-text card-secondary-action" type="button" onClick={() => onKill(session.id)} disabled={session.status === 'stopped'}>{t('ui.0444e74d7ca8')}</button>}</div></td>
      </tr>)}
    </tbody></table></div> : <div className="admin-empty"><Icon name={sessions.length ? 'search' : 'phone'} size={26} /><div><h3>{sessions.length ? t('ui.480fae1c4bc9') : t('ui.e2679b63a587')}</h3><p>{sessions.length ? t('ui.a8fab9f8470e') : t('ui.4538b9331b40')}</p></div></div>}
  </section>;
}

export function AdminWorkspace(props: Props) {
  const { section } = props;
  return <div className="admin-workspace">
    <section className="admin-section-panel" id={'admin-panel-' + section} aria-label={adminSections.find(item => item.id === section)?.label}>
      {section === 'sessions' && <Sessions {...props} />}
      {section === 'nodes' && <><NodeManagement hosts={props.hosts} profiles={props.profiles} onRefresh={props.onRefresh} /><DeviceInventory hosts={props.hosts} onRefresh={props.onRefresh} /></>}
      {(section === 'profiles' || section === 'users') && <AdminTools key={section} section={section} profiles={props.profiles} allowLocalUsers={props.allowLocalUsers} onRefresh={props.onRefresh} />}
      {section === 'images' && <ImageManagement hosts={props.hosts} onChanged={props.onRefresh}/> }
      {section === 'roles' && <RoleManagement onChanged={props.onRefresh} />}
      {section === 'ops' && <AdminOps />}
      {section === 'journal' && <AdminJournal hosts={props.hosts} sessions={props.sessions} />}
    </section>
  </div>;
}
