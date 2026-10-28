import { TranslatedText } from './TranslatedText';
import { useAccess, roleLabel, type AccessRole } from './permissions';
import { roleApi } from './roles-api';
import { RoleAssignmentDialog } from './RoleAssignmentDialog';
import { getLocale, localizeText, t } from './i18n';
import { useEffect, useState } from 'react';
import { api, type AdminUser } from './api';
import { Icon } from './icons';
import { HeadingSlot } from './HeadingSlot';
import { useAdminDialog } from './useAdminDialog';
import { useNotifications } from './notifications';
import { PasswordTools } from './PasswordTools';
import './UserManagement.css';

function errorText(error: unknown): string { return error instanceof Error ? error.message : t('ui.8f9c4884b8f9'); }

const userNameOrder = { compare: (left: string, right: string) => left.localeCompare(right, getLocale(), { sensitivity: 'base', numeric: true }) };
function registeredOn(value: string | undefined): string {
  if (!value) return t('ui.975ffdce6aa2');
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? t('ui.975ffdce6aa2') : new Intl.DateTimeFormat(getLocale(), { day: 'numeric', month: 'short', year: 'numeric' }).format(date);
}

export function UserManagement({ allowLocalUsers, onChanged }: { allowLocalUsers: boolean; onChanged?: () => void }) {
  const { notify } = useNotifications();
  const can = useAccess();
  const [assigning, setAssigning] = useState<AdminUser | null>(null);
  const [roles, setRoles] = useState<AccessRole[]>([]);
  useEffect(() => { if (can('roles.view')) void roleApi.list().then(data => setRoles(data.roles)).catch(() => {}); }, []);
  const [resetting, setResetting] = useState<AdminUser | null>(null);
  const [removing, setRemoving] = useState<AdminUser | null>(null);
  const [removeError, setRemoveError] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [resetError, setResetError] = useState('');
  const [resetPasswordVisible, setResetPasswordVisible] = useState(false);
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<AdminUser | null>(null);
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [company, setCompany] = useState('');
  const [jobTitle, setJobTitle] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState('00000000-0000-4000-8000-000000000002');
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState('');
  const [companyFilter, setCompanyFilter] = useState('');
  const [jobFilter, setJobFilter] = useState('');
  const [roleFilter, setRoleFilter] = useState<string>('');
  const [error, setError] = useState('');
  const close = () => { setOpen(false); setPassword(''); setPasswordVisible(false); };
  const dialogRef = useAdminDialog(open, busy, close);
  const closeReset = () => { setResetting(null); setNewPassword(''); setConfirmPassword(''); setResetError(''); setResetPasswordVisible(false); };
  const resetDialogRef = useAdminDialog(Boolean(resetting), busy, closeReset);
  const closeRemove = () => { setRemoving(null); setRemoveError(''); };
  const removeDialogRef = useAdminDialog(Boolean(removing), busy, closeRemove);
  const removeUser = async () => {
    if (!removing || busy) return;
    setBusy(true); setRemoveError('');
    try {
      await api.deleteUser(removing.id);
      setUsers(previous => previous.filter(person => person.id !== removing.id));
      notify({ kind: 'success', title: t('ui.4bf44dca589b'), message: t('ui.7023ae1bfd8b', { p0: removing.displayName || removing.username, p1: removing.username }) });
      closeRemove(); onChanged?.();
    } catch (cause) { setRemoveError(errorText(cause)); }
    finally { setBusy(false); }
  };
  const startReset = (person: AdminUser) => {
    close(); setError(''); setNewPassword(''); setConfirmPassword(''); setResetError(''); setResetPasswordVisible(false); setResetting(person);
  };
  const resetPassword = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy || !resetting) return;
    if (newPassword !== confirmPassword) { setResetError(t('ui.6c0385c91e9d')); return; }
    if (newPassword.length < 12 || newPassword.length > 2048) { setResetError(t('ui.169dabeb6a9e')); return; }
    setBusy(true); setResetError('');
    try {
      await api.resetUserPassword(resetting.id, newPassword);
      notify({ kind: 'success', title: t('ui.c1851ab1291a'), message: t('ui.a7feaa2129fb', { p0: resetting.displayName || resetting.username, p1: resetting.username }) });
      closeReset();
    } catch (cause) { setResetError(errorText(cause)); }
    finally { setBusy(false); }
  };

  const load = async () => {
    try { setUsers(await api.users()); setError(''); }
    catch (cause) { setError(errorText(cause)); }
    finally { setLoading(false); }
  };
  useEffect(() => { void load(); }, []);
  const start = (person: AdminUser | null) => {
    setEditing(person); setUsername(person?.username || ''); setDisplayName(person?.displayName || '');
    setCompany(person?.company || ''); setJobTitle(person?.jobTitle || '');
    setPassword(''); setPasswordVisible(false); setRole(person?.roleId || '00000000-0000-4000-8000-000000000002'); setError(''); setOpen(true);
  };
  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setError('');
    try {
      if (editing) await api.updateUser(editing.id, { displayName, company, jobTitle });
      else await api.createUser({ username, displayName, company, jobTitle, password, role: 'user', ...(can('roles.manage') ? { roleId: role } : {}) });
      close(); onChanged?.(); await load();
    } catch (cause) { setError(errorText(cause)); }
    finally { setBusy(false); }
  };

  const companies = [...new Set(users.map(person => person.company).filter((value): value is string => Boolean(value)))].sort((a, b) => a.localeCompare(b, getLocale()));
  const jobs = [...new Set(users.map(person => person.jobTitle).filter((value): value is string => Boolean(value)))].sort((a, b) => a.localeCompare(b, getLocale()));
  const needle = query.trim().toLowerCase();
  const visibleUsers = users.filter(person =>
    (!companyFilter || person.company === companyFilter) && (!jobFilter || person.jobTitle === jobFilter) && (!roleFilter || (person.roleId || person.role) === roleFilter) &&
    (!needle || [person.username, person.displayName, person.company, person.jobTitle].some(value => (value ?? '').toLowerCase().includes(needle))))
    .sort((a, b) => userNameOrder.compare(a.displayName || a.username, b.displayName || b.username)
      || userNameOrder.compare(a.username, b.username) || a.id.localeCompare(b.id));
  const filtering = Boolean(needle || companyFilter || jobFilter || roleFilter);
  const roleCounts = new Map<string, { label: string; count: number }>();
  for (const person of users) {
    const key = person.roleId || person.role;
    const choice = roleCounts.get(key) ?? { label: roleLabel(person), count: 0 };
    choice.count++; roleCounts.set(key, choice);
  }
  const roleChoices = Array.from(roleCounts, ([id, item]) => [id, item.label, item.count] as const).sort((a,b) => userNameOrder.compare(a[1],b[1]));
  const initials = (person: { displayName?: string | null; username: string }) => (person.displayName || person.username).split(/\s+/).filter(Boolean).slice(0, 2).map(part => part[0]!.toUpperCase()).join('') || '?';
  return <section id="adm-users" className="content-section admin-tools">
    <div className="section-heading"><div><h2>{t('ui.845595d6e899')}</h2><p>{t('ui.19b9c9ecca8b')}</p></div>
      <HeadingSlot slot="actions"><div className="admin-heading-actions">{allowLocalUsers && can('users.manage') && <button className="button primary small" type="button" onClick={() => start(null)}><Icon name="plus" size={16} />{t('ui.75ffea39abea')}</button>}</div></HeadingSlot>
    </div>
    {users.length > 0 && <div className="admin-filter-bar">
      <label className="admin-search"><Icon name="search" size={18} /><input aria-label={t('ui.b8bcabd66839')} value={query} onChange={event => setQuery(event.target.value)} placeholder={t('ui.477c5ac57267')} /></label>
      {companies.length > 0 && <select aria-label={t('ui.64d92044a1ff')} value={companyFilter} onChange={event => setCompanyFilter(event.target.value)}><option value="">{t('ui.a3cc5e58235f')}</option>{companies.map(value => <option key={value} value={value}>{value}</option>)}</select>}
      {jobs.length > 0 && <select aria-label={t('ui.65e47aff6622')} value={jobFilter} onChange={event => setJobFilter(event.target.value)}><option value="">{t('ui.9b92007123a5')}</option>{jobs.map(value => <option key={value} value={value}>{value}</option>)}</select>}
      <div className="role-pills" role="group" aria-label={t('ui.ebd4563f5ac7')}>{([['', t('ui.d8c315182fcb'), users.length], ...roleChoices] as const).map(([value, label, count]) => <button key={value} type="button" className="role-pill" aria-pressed={roleFilter === value} onClick={() => setRoleFilter(value)}>{label} <b>{count}</b></button>)}</div>
      {filtering && <button type="button" className="button outline small" onClick={() => { setQuery(''); setCompanyFilter(''); setJobFilter(''); setRoleFilter(''); }}>{t('ui.407f871778d3')}</button>}
    </div>}
    <div className="admin-list-only"><div className="agent-list">
      {loading ? <p className="agent-empty">{t('ui.85a915216eba')}</p> : visibleUsers.length ? visibleUsers.map(person => <div className={"agent-row user-record" + (person.provider === 'local' && can('users.manage') ? ' interactive-card' : '')} key={person.id}>
        <span className="agent-icon user-icon user-avatar" aria-hidden="true">{initials(person)}</span>
        <div className="user-record-copy">
          <div className="user-record-name">
            <strong>{person.provider === 'local' && can('users.manage') ? <button className="card-primary-action" type="button" onClick={() => start(person)} aria-label={t('ui.a4891c87f538') + (person.displayName || person.username) + "»"}>{person.displayName || person.username}</button> : person.displayName || person.username}</strong>
            {(person.role === 'admin' || person.roleBuiltin === null && person.roleName) && <span className={'user-role ' + (person.role === 'admin' ? 'is-admin' : 'is-custom')} title={roleLabel(person)}><span>{roleLabel(person)}</span></span>}
          </div>
          <small><TranslatedText message="copy.UserManagement.6577f89e" values={{ p0: person.username }} /></small>
          {(person.company || person.jobTitle) && <small className="user-record-work">{[person.company, person.jobTitle].filter(Boolean).join(' · ')}</small>}
        </div>
        <div className="user-record-registration"><span>{t('ui.8d7746c4a1bd')}</span><time dateTime={person.createdAt}>{registeredOn(person.createdAt)}</time></div>
        <span className="user-record-actions">{can('users.password') && allowLocalUsers && person.provider === 'local' && <button type="button" className="icon-button card-secondary-action" onClick={() => startReset(person)} title={t('ui.bb6b4ce0e617')} aria-label={t('ui.59b46498cf91', { p0: person.displayName || person.username })}><Icon name="key" size={18} /></button>}{can('users.delete') && <button type="button" className="icon-button danger-icon card-secondary-action" title={t('ui.6249cca1d8ed')} aria-label={t('ui.ad4041fdf1a5', { p0: person.displayName || person.username })} onClick={() => { setRemoveError(''); setRemoving(person); }}><Icon name="trash" size={18} /></button>}{can('roles.manage') && <button className="icon-button card-secondary-action" type="button" title={t('roles.assign')} aria-label={t('roles.assign') + ' · ' + person.username} onClick={() => setAssigning(person)}><Icon name="shield" size={18}/></button>}</span>
      </div>) : <p className="agent-empty">{users.length ? t('ui.68ff3804070f') : t('ui.1aba1ff0f244')}</p>}
    </div></div>
    {open && <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !busy) close(); }}>
      <div className="modal admin-form-dialog user-form-dialog" ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="user-editor-heading">
        <div className="modal-top"><h2 id="user-editor-heading">{editing ? t('ui.5f2b5434f307') : t('ui.75ffea39abea')}</h2><button className="icon-button" type="button" aria-label={t('ui.a7a4033657e8')} disabled={busy} onClick={close}><Icon name="close" size={19} /></button></div>
        <form className="agent-create user-create" onSubmit={save}>
          <p>{editing ? t('ui.e3924b4282e2') : t('ui.5b8ee02f3bfd')}</p>
          <div className="user-form-grid">
            <label>{t('ui.5be12bfe49ea')}<input value={username} onChange={event => setUsername(event.target.value)} pattern="[A-Za-z0-9._@-]{3,150}" required placeholder={t('ui.16f78a7d6317')} autoComplete="off" disabled={busy} readOnly={Boolean(editing)} /></label>
            <label>{t('ui.a1ce1abad9de')}<input value={displayName} onChange={event => setDisplayName(event.target.value)} maxLength={150} placeholder={t('ui.50c46937d9d5')} required={Boolean(editing)} disabled={busy} /></label>
            <label>{t('ui.64d92044a1ff')}<input value={company} onChange={event => setCompany(event.target.value)} maxLength={150} autoComplete="organization" disabled={busy} /></label>
            <label>{t('ui.65e47aff6622')}<input value={jobTitle} onChange={event => setJobTitle(event.target.value)} maxLength={150} autoComplete="organization-title" disabled={busy} /></label>
            {!editing && <><label>{t('ui.cb1a2074b3a0')}<input type={passwordVisible ? 'text' : 'password'} value={password} onChange={event => setPassword(event.target.value)} minLength={12} required placeholder={t('ui.f16b87444e25')} autoComplete="new-password" disabled={busy} /></label>{can('roles.manage') && <label>{t('ui.ebd4563f5ac7')}<select value={role} onChange={event => setRole(event.target.value)} disabled={busy || !roles.length}>{roles.map(item => <option key={item.id} value={item.id}>{roleLabel(item)}</option>)}</select></label>}</>}
          </div>
          {!editing && <PasswordTools value={password} visible={passwordVisible} disabled={busy} onVisibleChange={setPasswordVisible} onGenerate={setPassword} />}
          {error && <div className="inline-error" role="alert">{localizeText(error)}</div>}
          <div className="user-form-actions">{editing && allowLocalUsers && can('users.password') && <button type="button" className="text-button user-reset-trigger" disabled={busy} onClick={() => startReset(editing)}><Icon name="key" size={16} />{t('ui.bb6b4ce0e617')}</button>}<button className="button outline" type="button" disabled={busy} onClick={close}>{t('ui.8fbe9b75cbdf')}</button><button className="button primary" type="submit" disabled={busy}>{busy ? t('ui.9c27c381dd8b') : editing ? t('ui.b4d30cae5289') : t('ui.9ded8d1f33a1')}<Icon name="arrowRight" size={16} /></button></div>
        </form>
      </div>
    </div>}
    {resetting && <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !busy) closeReset(); }}>
      <div className="modal admin-form-dialog user-password-dialog" ref={resetDialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="user-password-heading" aria-describedby="user-password-description">
        <div className="modal-top"><h2 id="user-password-heading">{t('ui.bb6b4ce0e617')}</h2><button type="button" className="icon-button" aria-label={t('ui.a7a4033657e8')} disabled={busy} onClick={closeReset}><Icon name="close" size={19} /></button></div>
        <form className="agent-create user-create" onSubmit={resetPassword}>
          <p id="user-password-description" className="user-password-person"><strong>{resetting.displayName || resetting.username}</strong><span>@{resetting.username}</span></p>
          <div className="user-password-fields new-password-fields">
            <label>{t('ui.f104cf99dcdb')}<input type={resetPasswordVisible ? 'text' : 'password'} autoComplete="new-password" value={newPassword} onChange={event => { setNewPassword(event.target.value); setResetError(''); }} minLength={12} maxLength={2048} required disabled={busy} aria-describedby="user-password-hint" /></label>
            <label>{t('ui.65af96d11b73')}<input type={resetPasswordVisible ? 'text' : 'password'} autoComplete="new-password" value={confirmPassword} onChange={event => { setConfirmPassword(event.target.value); setResetError(''); }} minLength={12} maxLength={2048} required disabled={busy} aria-invalid={Boolean(resetError && newPassword !== confirmPassword)} aria-describedby={resetError ? 'user-password-error' : undefined} /></label>
          </div>
          <PasswordTools value={newPassword} visible={resetPasswordVisible} disabled={busy} onVisibleChange={setResetPasswordVisible} onGenerate={value => { setNewPassword(value); setConfirmPassword(value); setResetError(''); }} />
          <p id="user-password-hint" className="user-password-hint">{t('ui.f198315d3a4e')}</p>
          <p className="user-password-notice"><Icon name="info" size={18} /><span>{t('ui.d8570601f284')}</span></p>
          {resetError && <div id="user-password-error" className="inline-error" role="alert">{localizeText(resetError)}</div>}
          <div className="user-form-actions"><button type="button" className="button outline" onClick={closeReset} disabled={busy}>{t('ui.8fbe9b75cbdf')}</button><button type="submit" className="button primary" disabled={busy || !newPassword || !confirmPassword}>{busy ? t('ui.c8769cfcfb49') : t('ui.bb6b4ce0e617')}</button></div>
        </form>
      </div>
    </div>}
    {removing && <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !busy) closeRemove(); }}>
      <div className="modal admin-form-dialog user-delete-dialog" ref={removeDialogRef} tabIndex={-1} role="alertdialog" aria-modal="true" aria-labelledby="user-delete-heading" aria-describedby="user-delete-description">
        <div className="modal-top"><h2 id="user-delete-heading">{t('ui.806f94995626')}</h2><button type="button" className="icon-button" aria-label={t('ui.a7a4033657e8')} disabled={busy} onClick={closeRemove}><Icon name="close" size={19} /></button></div>
        <div className="user-delete-content">
          <p className="user-password-person"><strong>{removing.displayName || removing.username}</strong><span><TranslatedText message="copy.UserManagement.6577f89e" values={{ p0: removing.username }} /></span></p>
          <p id="user-delete-description">{t('ui.dc52df57efeb')}</p>
          {removing.provider !== 'local' && <p>{t('ui.d23a5c6db7b7')}</p>}
          {removeError && <div className="inline-error" role="alert">{localizeText(removeError)}</div>}
          <div className="user-form-actions"><button type="button" className="button outline" disabled={busy} onClick={closeRemove}>{t('ui.8fbe9b75cbdf')}</button><button type="button" className="button danger" disabled={busy} onClick={() => void removeUser()}>{busy ? t('ui.044870c94eb5') : t('ui.6249cca1d8ed')}</button></div>
        </div>
      </div>
    </div>}
    {assigning && <RoleAssignmentDialog person={assigning} onClose={() => setAssigning(null)} onSaved={() => { void load(); onChanged?.(); notify({ kind: 'success', title: t('roles.assigned') }); }} />}
    {error && !open && <div className="inline-error admin-error" role="alert">{localizeText(error)}</div>}
  </section>;
}
