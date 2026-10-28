import { useEffect, useState } from 'react';
import { localizeText, t } from './i18n';
import { roleLabel, useAccess, type AccessRole } from './permissions';
import { registrationApi, type RegistrationSettings as Settings } from './registration-api';
import { ActivityIndicator } from './ActivityIndicator';
import './RegistrationSettings.css';

export function RegistrationSettings({ roles }: { roles: AccessRole[] }) {
  const can = useAccess();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [draft, setDraft] = useState<Settings | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false), [saved, setSaved] = useState(false), [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setError('');
    void registrationApi.settings(controller.signal).then(next => { if (!controller.signal.aborted) { setSettings(next); setDraft(next); } })
      .catch(cause => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : t('ui.8f9c4884b8f9')); });
    return () => controller.abort();
  }, [attempt]);
  const editable = can('roles.manage') && draft?.available === true && !busy;
  const dirty = draft && (draft.enabled !== settings?.enabled || draft.roleId !== settings?.roleId);
  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!editable || !draft || !dirty) return;
    setBusy(true); setError(''); setSaved(false);
    try { const next = await registrationApi.save(draft.enabled, draft.roleId); setSettings(next); setDraft(next); setSaved(true); }
    catch (cause) { setError(cause instanceof Error ? cause.message : t('ui.8f9c4884b8f9')); }
    finally { setBusy(false); }
  };
  return <details className="registration-settings">
    <summary>{t('registration.title')}</summary>
    <form onSubmit={event => void save(event)} aria-busy={busy}>
      <p>{t('registration.description')}</p>
      {!draft && !error && <p role="status"><ActivityIndicator />{t('ui.22a5d9112486')}</p>}
      {draft && <>
        {!draft.available && <p className="registration-settings-hint">{t('registration.unavailable')}</p>}
        <label className="registration-toggle"><span>{t('registration.allow')}</span><input type="checkbox" role="switch" checked={draft.enabled} disabled={!editable} onChange={event => { setDraft({ ...draft, enabled: event.target.checked }); setSaved(false); }} /></label>
        <label className="registration-role"><span id="registration-role-label">{t('registration.defaultRole')}</span><select aria-labelledby="registration-role-label" value={draft.roleId} disabled={!editable} aria-describedby="registration-role-hint" onChange={event => { setDraft({ ...draft, roleId: event.target.value }); setSaved(false); }}>
          {roles.filter(role => role.builtin !== 'admin').map(role => <option key={role.id} value={role.id}>{roleLabel(role)}</option>)}
        </select><small id="registration-role-hint">{t('registration.roleHint')}</small></label>
        {can('roles.manage') && <button className="button primary small" type="submit" disabled={!editable || !dirty}>{busy ? t('ui.9c27c381dd8b') : t('ui.b4d30cae5289')}</button>}
      </>}
      {error && <div className="inline-error" role="alert">{localizeText(error)}{!draft && <button type="button" className="button outline small" onClick={() => setAttempt(value => value + 1)}>{t('ui.5189135a6110')}</button>}</div>}
      {saved && <p className="registration-settings-saved" role="status">{t('registration.saved')}</p>}
    </form>
  </details>;
}
