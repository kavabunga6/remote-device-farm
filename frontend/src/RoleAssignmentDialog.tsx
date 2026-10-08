import { useEffect, useState } from 'react';
import { roleApi } from './roles-api';
import { roleLabel, type AccessRole } from './permissions';
import type { AdminUser } from './api';
import { t, localizeText } from './i18n';
import { Icon } from './icons';
import { useAdminDialog } from './useAdminDialog';
import './RoleManagement.css';

export function RoleAssignmentDialog({ person, onClose, onSaved }: { person: AdminUser; onClose: () => void; onSaved: () => void }) {
 const [roles, setRoles] = useState<AccessRole[]>([]), [roleId, setRoleId] = useState(person.roleId ?? (person.role === 'admin' ? '00000000-0000-4000-8000-000000000001' : '00000000-0000-4000-8000-000000000002'));
 const previousRole = person.roleId ?? (person.role === 'admin' ? '00000000-0000-4000-8000-000000000001' : '00000000-0000-4000-8000-000000000002');
 const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState('');
 const dialog = useAdminDialog(true, busy, onClose);
 useEffect(() => {
  const controller = new AbortController();
  void roleApi.list(controller.signal).then(data => setRoles(data.roles)).catch(cause => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : t('ui.8f9c4884b8f9')); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
  return () => controller.abort();
 }, []);
 const save = async (event: React.FormEvent) => {
  event.preventDefault(); if (busy || !roleId) return; setBusy(true); setError('');
  try { await roleApi.assign(person.id, roleId); onSaved(); onClose(); }
  catch (cause) { setError(cause instanceof Error ? cause.message : t('ui.8f9c4884b8f9')); }
  finally { setBusy(false); }
 };
 return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !busy) onClose(); }}><div className="modal admin-form-dialog" ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="role-assignment-heading">
  <header className="modal-top"><h2 id="role-assignment-heading">{t('roles.assign')}</h2><button type="button" className="icon-button" disabled={busy} aria-label={t('ui.a7a4033657e8')} onClick={onClose}><Icon name="close" size={18}/></button></header>
  <form className="role-assign-content" onSubmit={save}><p className="user-password-person"><strong>{person.displayName || person.username}</strong><span>@{person.username}</span></p>
   <label>{t('roles.choose')}<select value={roleId} disabled={busy || loading} onChange={event => setRoleId(event.target.value)}>{roles.map(role => <option key={role.id} value={role.id}>{roleLabel(role)}</option>)}</select></label>
   {loading && <p role="status">{t('ui.85a915216eba')}</p>}
   {error && <p className="inline-error" role="alert">{localizeText(error)}</p>}
   <footer className="role-editor-actions"><button type="button" className="button outline" disabled={busy} onClick={onClose}>{t('ui.8fbe9b75cbdf')}</button><button type="submit" className="button primary" disabled={busy || loading || !roles.length || roleId === previousRole}>{busy ? t('ui.9c27c381dd8b') : t('ui.b4d30cae5289')}</button></footer>
  </form>
 </div></div>;
}
