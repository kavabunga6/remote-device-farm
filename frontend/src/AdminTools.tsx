import { useAccess } from './permissions';
import { t } from './i18n';
import { useEffect, useState } from 'react';
import { api, type Profile } from './api';
import { Icon } from './icons';
import { UserManagement } from './UserManagement';
import { ProfileModal } from './ProfileModal';
import { AdminProfiles } from './AdminProfiles';
import { useAdminDialog } from './useAdminDialog';
import { useNotifications } from './notifications';
import './AdminActionConfirm.css';

type ProfileLink = { id: string };
function profileLinkFromHash(): ProfileLink | null {
  const [path, query = ''] = window.location.hash.split('?');
  const params = new URLSearchParams(query);
  const id = params.get('profile');
  return path === '#/admin/profiles' && id ? { id } : null;
}
function clearProfileLink() {
  const [path, query = ''] = window.location.hash.split('?');
  const params = new URLSearchParams(query);
  if (path !== '#/admin/profiles' || !params.has('profile')) return;
  params.delete('profile'); params.delete('section');
  window.history.replaceState(null, '', path + (params.size ? '?' + params.toString() : ''));
  window.dispatchEvent(new HashChangeEvent('hashchange'));
}

export function AdminTools({ section, profiles, allowLocalUsers, onRefresh }: { section: 'profiles' | 'users'; profiles: Profile[]; allowLocalUsers: boolean; onRefresh: () => void }) {
  const [editing, setEditing] = useState<Profile | 'new' | null>(null);
  const [profileLink, setProfileLink] = useState<ProfileLink | null>(profileLinkFromHash);
  // Resolve against the latest inventory so a direct link also works before profiles finish loading.
  const can = useAccess();
  const activeEditor = profileLink ? profiles.find(profile => profile.id === profileLink.id) ?? null : editing;
  const closeEditor = () => { setEditing(null); setProfileLink(null); clearProfileLink(); };
  const openEditor = (profile: Profile | 'new') => { clearProfileLink(); setProfileLink(null); setEditing(profile); };
  useEffect(() => {
    const update = () => { setProfileLink(profileLinkFromHash()); setEditing(null); };
    window.addEventListener('hashchange', update);
    return () => window.removeEventListener('hashchange', update);
  }, []);
  const [pendingAction, setPendingAction] = useState<{ kind: 'disable-profile' | 'delete-profile'; id: string; name?: string } | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const { notify, notifyError } = useNotifications();
  const closeAction = () => { if (!actionBusy) setPendingAction(null); };
  const dialogRef = useAdminDialog(Boolean(pendingAction), actionBusy, closeAction);

  const confirmAction = async () => {
    if (!pendingAction) return;
    if (actionBusy) return;
    setActionBusy(true);
    try {
      if (pendingAction.kind === 'delete-profile') { await api.deleteProfile(pendingAction.id); onRefresh(); notify({ kind: 'success', title: t('ui.925efb6367cf'), message: pendingAction.name }); }
      else if (pendingAction.kind === 'disable-profile') { await api.disableProfile(pendingAction.id); onRefresh(); }
      setPendingAction(null);
    } catch (cause) { notifyError(t('ui.b9f61453dd3f'), cause); }
    finally { setActionBusy(false); }
  };

  const enableProfile = async (id: string) => {
    try { await api.updateProfile(id, { enabled: true }); onRefresh(); }
    catch (cause) { notifyError(t('ui.b9f61453dd3f'), cause); }
  };

  return <>
    {section === 'profiles' && <AdminProfiles profiles={profiles} onImported={onRefresh} onCreate={() => openEditor('new')} onEdit={openEditor}
      onToggle={profile => profile.enabled === false ? void enableProfile(profile.id) : setPendingAction({ kind: 'disable-profile', id: profile.id, name: profile.name })}
      onDelete={profile => setPendingAction({ kind: 'delete-profile', id: profile.id, name: profile.name })}/>}
    {section === 'users' && <UserManagement allowLocalUsers={allowLocalUsers} onChanged={onRefresh} />}
    {can('profiles.manage') && activeEditor && <ProfileModal key={activeEditor === 'new' ? 'new' : activeEditor.id} current={activeEditor === 'new' ? null : activeEditor} onClose={closeEditor} onSaved={() => { closeEditor(); onRefresh(); }} />}
    {pendingAction && <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) closeAction(); }}>
      <div ref={dialogRef} tabIndex={-1} className="modal confirm-modal admin-action-confirm" role="alertdialog" aria-modal="true" aria-labelledby="admin-action-heading" aria-describedby="admin-action-target admin-action-description" aria-busy={actionBusy}>
        <header className="admin-action-heading"><span className="confirm-icon danger"><Icon name={pendingAction.kind === 'delete-profile' ? 'trash' : 'alert'} size={22}/></span><h2 id="admin-action-heading">{pendingAction.kind === 'delete-profile' ? t('ui.b745f551a951') : pendingAction.kind === 'disable-profile' ? t('ui.916399b78fa6') : t('ui.2289d3c906a0')}</h2></header>
        <div className="admin-action-target" id="admin-action-target"><strong>{pendingAction.name || pendingAction.id}</strong>{pendingAction.name && <code>{pendingAction.id}</code>}</div>
        <p id="admin-action-description">{pendingAction.kind === 'delete-profile'
          ? t('ui.da17c1292d53')
          : pendingAction.kind === 'disable-profile'
            ? t('ui.5a5e29ae2076')
            : t('ui.2869ee1fa949')}</p>
        <div className="modal-actions"><button type="button" className="button outline" onClick={closeAction} disabled={actionBusy}>{t('ui.8fbe9b75cbdf')}</button><button type="button" className="button danger" onClick={() => void confirmAction()} disabled={actionBusy}>{actionBusy ? t('ui.7e4f3baf839f') : pendingAction.kind === 'delete-profile' ? t('ui.be99b1361201') : pendingAction.kind === 'disable-profile' ? t('ui.bb5bdd176cdf') : t('ui.b66927e0fc8e')}</button></div>
      </div>
    </div>}
  </>;
}
