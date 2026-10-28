import { Fragment, useEffect, useState } from 'react';
import { t, localizeText } from './i18n';
import { permissionCatalog, permissionLabel, roleLabel, togglePermission, useAccess, type AccessRole } from './permissions';
import { roleApi } from './roles-api';
import { Icon } from './icons';
import { useAdminDialog } from './useAdminDialog';
import { useNotifications } from './notifications';
import './RoleManagement.css';
import { RegistrationSettings } from './RegistrationSettings';
import { HeadingSlot } from './HeadingSlot';

export function RoleManagement({ onChanged }: { onChanged: () => void }) {
 const can = useAccess(), { notify } = useNotifications();
 const [roles, setRoles] = useState<AccessRole[]>([]);
 const [loading, setLoading] = useState(true), [error, setError] = useState('');
 const [selected, setSelected] = useState<string | null>(null);
 const [name, setName] = useState(''), [permissions, setPermissions] = useState<string[]>([]);
 const [busy, setBusy] = useState(false), [removing, setRemoving] = useState<AccessRole | null>(null);
 const [deleteError, setDeleteError] = useState('');
 const closeDelete = () => { if (!busy) setRemoving(null); };
 const dialog = useAdminDialog(Boolean(removing), busy, closeDelete);
 const current = roles.find(role => role.id === selected);
 const locked = current?.builtin === 'admin' || !can('roles.manage');
 const choose = (role: AccessRole | null) => { setSelected(role?.id ?? null); setName(role?.name ?? ''); setPermissions(role?.permissions ?? []); setError(''); };
 const load = async () => {
  try { const data = await roleApi.list(); setRoles(data.roles); return data.roles; }
  catch (cause) { setError(cause instanceof Error ? cause.message : t('ui.8f9c4884b8f9')); return []; }
  finally { setLoading(false); }
 };
 useEffect(() => {
  const controller = new AbortController();
  void roleApi.list(controller.signal).then(data => { setRoles(data.roles); if (data.roles.length) choose(data.roles[0]); })
   .catch(cause => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : t('ui.8f9c4884b8f9')); })
   .finally(() => { if (!controller.signal.aborted) setLoading(false); });
  return () => controller.abort();
 }, []);
 const save = async (event: React.FormEvent) => {
  event.preventDefault(); if (busy || locked) return; setBusy(true); setError('');
  try {
   const data = { name: name.trim(), permissions };
   if (selected) await roleApi.update(selected, data); else await roleApi.create(data);
   const updated = await load(); choose(updated.find(role => role.id === selected || role.name === data.name) ?? null);
   notify({ kind: 'success', title: t('roles.saved') }); onChanged();
  } catch (cause) { setError(cause instanceof Error ? cause.message : t('ui.8f9c4884b8f9')); }
  finally { setBusy(false); }
 };
 const permissionHint = (id: string) => {
  if (!permissions.includes(id)) return null;
  if (id === 'sessions.console' || id === 'sessions.adb' && !permissions.includes('sessions.console')) return t('roles.deviceAccessHint');
  if (id === 'sessions.configure') return t('roles.launchWarning');
  if (id === 'roles.manage') return t('roles.manageWarning');
  if (id === 'tokens.system') return t('roles.tokenWarning');
  return null;
 };
 const remove = async () => {
  if (!removing || busy) return; setBusy(true); setDeleteError('');
  try { await roleApi.remove(removing.id); const updated = await load(); choose(updated[0] ?? null); setRemoving(null); notify({ kind: 'success', title: t('roles.deleted') }); onChanged(); }
  catch (cause) { setDeleteError(cause instanceof Error ? cause.message : t('ui.8f9c4884b8f9')); }
  finally { setBusy(false); }
 };
 return <section className="role-management">
  <HeadingSlot slot="actions">{can('roles.manage') && <button className="button primary small" type="button" disabled={busy || loading || !roles.length} onClick={() => choose(null)}><Icon name="plus" size={16}/>{t('roles.create')}</button>}</HeadingSlot>
  {!loading && roles.length > 0 && <RegistrationSettings roles={roles} />}
  {loading ? <p role="status">{t('ui.85a915216eba')}</p> : error && !roles.length ? <div className="inline-error" role="alert"><p>{localizeText(error)}</p><button type="button" className="button outline" onClick={() => { setLoading(true); void load().then(items => { if (items.length) choose(items[0]); }); }}>{t('ui.163a016f3df7')}</button></div> : <div className="role-workspace">
   <nav className="role-list" aria-label={t('roles.title')}>{roles.map(role => <button key={role.id} type="button" className={selected === role.id ? 'selected' : ''} aria-pressed={selected === role.id} disabled={busy} onClick={() => choose(role)}><span><strong>{roleLabel(role)}</strong>{role.builtin && <small>{t('roles.builtin')}</small>}</span><small>{t('roles.members', { p0: role.userCount })}</small></button>)}</nav>
   <form className="role-editor" onSubmit={save}>
    <header className="role-editor-heading"><h3>{selected ? roleLabel(current ?? {}) : t('roles.create')}</h3>{current && !current.builtin && can('roles.manage') && <button className="icon-button danger-icon" type="button" title={t('roles.delete')} aria-label={t('roles.delete')} disabled={busy} onClick={() => { setDeleteError(''); setRemoving(current); }}><Icon name="trash" size={18}/></button>}</header>
    <label className="role-name">{t('roles.name')}<input value={current?.builtin ? roleLabel(current) : name} maxLength={80} required disabled={busy || locked || Boolean(current?.builtin)} onChange={event => setName(event.target.value)}/></label>
    {current?.builtin === 'admin' && <p className="role-notice">{t('roles.adminLocked')}</p>}
    <p className="role-notice">{t('roles.dependencyHint')}</p>
    <h4 className="role-permissions-heading">{t('roles.permissions')}<span>{t('roles.count', { p0: permissions.length })}</span></h4>
    <div className="permission-groups">{permissionCatalog.map(group => <fieldset key={group.id} disabled={busy || locked}><legend>{permissionLabel(group.labelKey)}</legend>{group.actions.map(action => {
     const hint = permissionHint(action.id), hintId = 'permission-hint-' + action.id;
     return <Fragment key={action.id}><label className="permission-choice"><input type="checkbox" checked={permissions.includes(action.id)} aria-describedby={hint ? hintId : undefined} onChange={event => setPermissions(values => togglePermission(values, action.id, event.target.checked))}/><span>{permissionLabel(action.labelKey)}</span></label>
      {hint && <p id={hintId} className="role-notice permission-hint">{hint}</p>}</Fragment>;
    })}</fieldset>)}</div>
    {error && <p className="inline-error" role="alert">{localizeText(error)}</p>}
    {!locked && <footer className="role-editor-actions"><button type="submit" className="button primary" disabled={busy || !name.trim()}>{busy ? t('ui.9c27c381dd8b') : t('ui.b4d30cae5289')}</button></footer>}
   </form>
  </div>}
  {loading && error && <p className="inline-error" role="alert">{localizeText(error)}</p>}
  {removing && <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) closeDelete(); }}><div className="modal confirm-modal" ref={dialog} tabIndex={-1} role="alertdialog" aria-modal="true" aria-labelledby="role-delete-heading"><h2 id="role-delete-heading">{t('roles.delete')}</h2><p>{t('roles.deleteDescription', { p0: roleLabel(removing) })}</p>{deleteError && <p className="inline-error" role="alert">{localizeText(deleteError)}</p>}<div className="role-editor-actions"><button type="button" className="button outline" disabled={busy} onClick={closeDelete}>{t('ui.8fbe9b75cbdf')}</button><button type="button" className="button danger" disabled={busy} onClick={() => void remove()}>{t('roles.delete')}</button></div></div></div>}
 </section>;
}
