import { can, roleLabel } from './permissions';
import { getLocale, localizeText, t } from './i18n';
import { LanguageControl, useInterfaceLanguage } from './LanguageControl';
import { NotificationSettings } from './NotificationSettings';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { User } from './api';
import { AdbKeysPage } from './AdbKeysPage';
import { Icon } from './icons';
import { applyUserPreferences } from './user-preferences';
import { settingsApi, type RentalRecord, type UserPreferences, type UserProfile } from './settings-api';
import { PasswordTools } from './PasswordTools';
import { loadUserPreferences, saveUserPreferences } from './preferences-autosave';
import './UserSettingsPage.css';

type SettingsSection = 'profile' | 'appearance' | 'security' | 'keys' | 'notifications' | 'history';
function settingsSections(): ReadonlyArray<readonly [SettingsSection, string]> { return [['profile', t('ui.359497aff53e')], ['appearance', t('ui.1731619efa3a')], ['security', t('ui.64e2a7500e34')], ['keys', t('ui.cc48c41eb523')], ['notifications', t('ui.d4baf8f6b173')], ['history', t('ui.d9603f333a4a')]]; }
function settingsSectionFromHash(): SettingsSection {
  const section = window.location.hash.split('/')[2];
  return settingsSections().some(([id]) => id === section) ? section as SettingsSection : 'profile';
}

const initialPreferences: UserPreferences = {
  theme: 'system', fontFamily: 'system', fontScale: 0, defaultAdbKeyId: null,
};

function dateLabel(value: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' :
    new Intl.DateTimeFormat(getLocale(), { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : t('ui.8f9c4884b8f9');
}

function Segmented<T extends string | number>({ legend, value, options, onChange, disabled, hint }: { legend: string; value: T; options: ReadonlyArray<readonly [T, string]>; onChange: (value: T) => void; disabled?: boolean; hint?: string }) {
  return <div className="choice-group">
    <span className="choice-group-legend">{legend}</span>
    <div className="choice-group-options" role="radiogroup" aria-label={legend} onKeyDown={event => {
      if (disabled || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
      const current = options.findIndex(([optionValue]) => optionValue === value);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1
        : (current + (event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1) + options.length) % options.length;
      event.preventDefault();
      onChange(options[next][0]);
      (event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]')[next])?.focus();
    }}>
      {options.map(([optionValue, label]) => <button key={String(optionValue)} type="button" role="radio" aria-checked={optionValue === value} tabIndex={optionValue === value ? 0 : -1} className={optionValue === value ? 'active' : undefined} disabled={disabled} onClick={() => onChange(optionValue)}>{label}</button>)}
    </div>
    {hint && <small>{hint}</small>}
  </div>;
}

export function UserSettingsPage({ user }: { user: User }) {
  useInterfaceLanguage();
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [jobTitle, setJobTitle] = useState('');
  const [company, setCompany] = useState('');
  const [preferences, setPreferences] = useState<UserPreferences>(initialPreferences);
  const [section, setSection] = useState<SettingsSection>(settingsSectionFromHash);
  useEffect(() => {
    const sync = () => setSection(settingsSectionFromHash());
    window.addEventListener('hashchange', sync);
    return () => window.removeEventListener('hashchange', sync);
  }, []);
  const [rentals, setRentals] = useState<RentalRecord[]>([]);
  const [rentalCursor, setRentalCursor] = useState<string | null>(null);
  const [profileLoading, setProfileLoading] = useState(true);
  const [preferencesLoading, setPreferencesLoading] = useState(true);
  const [preferencesReady, setPreferencesReady] = useState(false);
  const [rentalsLoading, setRentalsLoading] = useState(true);
  const [profileError, setProfileError] = useState('');
  const [preferencesError, setPreferencesError] = useState('');
  const [rentalsError, setRentalsError] = useState('');
  const [profileRetry, setProfileRetry] = useState(0);
  const [preferencesRetry, setPreferencesRetry] = useState(0);
  const [rentalsRetry, setRentalsRetry] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [savingProfile, setSavingProfile] = useState(false);
  const [savingPassword, setSavingPassword] = useState(false);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [prefsStatus, setPrefsStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const prefsTimer = useRef<number | undefined>(undefined);
  const preferencesRef = useRef(preferences);
  const prefsVersion = useRef(0);
  const pendingPreferences = useRef<{ value: UserPreferences; version: number } | null>(null);
  const saveScope = useRef({ active: true });

  useEffect(() => {
    let active = true;
    setProfileLoading(true); setProfileError('');
    void settingsApi.profile().then(nextProfile => {
      if (!active) return;
      setProfile(nextProfile);
      setFirstName(nextProfile.firstName || '');
      setLastName(nextProfile.lastName || '');
      setJobTitle(nextProfile.jobTitle || '');
      setCompany(nextProfile.company || '');
    }).catch(cause => {
      if (active) setProfileError(errorText(cause));
    }).finally(() => {
      if (active) setProfileLoading(false);
    });
    return () => { active = false; };
  }, [user.id, profileRetry]);

  useEffect(() => {
    let active = true;
    setPreferencesLoading(true); setPreferencesError('');
    void loadUserPreferences(user.id).then(nextPreferences => {
      if (!active) return;
      preferencesRef.current = nextPreferences;
      setPreferences(nextPreferences); setPreferencesReady(true);
      applyUserPreferences(nextPreferences, user.id);
    }).catch(cause => {
      if (active) setPreferencesError(errorText(cause));
    }).finally(() => {
      if (active) setPreferencesLoading(false);
    });
    return () => { active = false; };
  }, [user.id, preferencesRetry]);

  useEffect(() => {
    let active = true;
    setRentalsLoading(true); setRentalsError('');
    void settingsApi.myRentals().then(history => {
      if (!active) return;
      setRentals(history.rentals);
      setRentalCursor(history.nextCursor);
    }).catch(cause => {
      if (active) setRentalsError(errorText(cause));
    }).finally(() => {
      if (active) setRentalsLoading(false);
    });
    return () => { active = false; };
  }, [user.id, rentalsRetry]);

  const saveProfile = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!profile || profileLoading || savingProfile || profile.managedByProvider) return;
    setSavingProfile(true); setError(''); setNotice('');
    try {
      const result = await settingsApi.updateProfile({ firstName, lastName, jobTitle, company });
      setProfile(result);
      setNotice(t('ui.07d1bcc0fb74'));
    } catch (cause) { setError(errorText(cause)); }
    finally { setSavingProfile(false); }
  };

  // Serialize requests, and publish a response only while it is still the latest
  // choice. The queue also orders writes flushed by an account page that left.
  const persistPreferences = useCallback(() => {
    const pending = pendingPreferences.current;
    if (!pending) return;
    pendingPreferences.current = null;
    const scope = saveScope.current;
    const { theme, fontFamily, fontScale } = pending.value;
    void saveUserPreferences(user.id, { theme, fontFamily, fontScale }).then(result => {
      if (!scope.active || pending.version !== prefsVersion.current) return;
      const next = { ...preferencesRef.current, theme: result.theme, fontFamily: result.fontFamily, fontScale: result.fontScale };
      preferencesRef.current = next;
      setPreferences(next); applyUserPreferences(next, user.id);
      setPrefsStatus('saved'); setPreferencesError('');
    }).catch(cause => {
      if (!scope.active || pending.version !== prefsVersion.current) return;
      setPrefsStatus('error'); setPreferencesError(errorText(cause));
    });
  }, [user.id]);
  const changePreferences = (patch: Partial<UserPreferences>) => {
    if (!preferencesReady || preferencesLoading) return;
    const next = { ...preferencesRef.current, ...patch, fontFamily: 'system' as const };
    preferencesRef.current = next;
    pendingPreferences.current = { value: next, version: ++prefsVersion.current };
    setPreferences(next); applyUserPreferences(next, user.id);
    setPrefsStatus('saving'); setPreferencesError('');
    window.clearTimeout(prefsTimer.current);
    prefsTimer.current = window.setTimeout(persistPreferences, 500);
  };
  useEffect(() => {
    const scope = { active: true }; saveScope.current = scope;
    return () => {
      scope.active = false;
      window.clearTimeout(prefsTimer.current);
      persistPreferences();
    };
  }, [persistPreferences]);

  const savePassword = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(''); setNotice('');
    if (newPassword !== confirmPassword) {
      setError(t('ui.aefb37b57125'));
      return;
    }
    if (newPassword.length < 12) {
      setError(t('ui.6749b587bead'));
      return;
    }
    setSavingPassword(true);
    try {
      await settingsApi.changePassword(currentPassword, newPassword);
      setCurrentPassword(''); setNewPassword(''); setConfirmPassword(''); setPasswordVisible(false);
      setNotice(t('ui.b6e0f5e286a1'));
    } catch (cause) { setError(errorText(cause)); }
    finally { setSavingPassword(false); }
  };

  const loadMoreRentals = async () => {
    if (!rentalCursor || loadingMore) return;
    setLoadingMore(true); setRentalsError('');
    try {
      const page = await settingsApi.myRentals(rentalCursor);
      setRentals(previous => [...previous, ...page.rentals]);
      setRentalCursor(page.nextCursor);
    } catch (cause) { setRentalsError(errorText(cause)); }
    finally { setLoadingMore(false); }
  };

  const setDefaultKey = async (id: string | null) => {
    if (!preferencesReady || preferencesLoading) return;
    setError(''); setNotice('');
    window.clearTimeout(prefsTimer.current); persistPreferences();
    try {
      const result = await saveUserPreferences(user.id, { defaultAdbKeyId: id });
      preferencesRef.current = { ...preferencesRef.current, defaultAdbKeyId: result.defaultAdbKeyId };
      setPreferences(previous => ({ ...previous, defaultAdbKeyId: result.defaultAdbKeyId }));
      setNotice(id ? t('ui.bb8652b96f4c') : t('ui.b56c215d43a6'));
    } catch (cause) { setError(errorText(cause)); }
  };

  const loadError = (message: string, retry: () => void) => message && <div className="inline-error settings-feedback" role="alert"><span>{localizeText(message)}</span><button type="button" className="text-button" onClick={retry}>{t('ui.5189135a6110')}</button></div>;
  const profileFeedback = loadError(profileError, () => setProfileRetry(value => value + 1));
  const preferencesFeedback = loadError(preferencesError, () => prefsStatus === 'error' ? changePreferences({}) : setPreferencesRetry(value => value + 1));

  const passwordCard = profile?.provider === 'local' ? <section className="settings-card settings-password">
      <div className="settings-card-title"><h2>{t('ui.cb1a2074b3a0')}</h2><p>{t('ui.4b3f0ec56a27')}</p></div>
      <form onSubmit={event => void savePassword(event)} className="settings-form settings-password-form">
        <label>{t('ui.d83e5a22c025')}<input type="password" value={currentPassword} onChange={event => setCurrentPassword(event.target.value)} autoComplete="current-password" required disabled={savingPassword} /></label>
        <div className="new-password-fields">
        <label>{t('ui.f104cf99dcdb')}<input type={passwordVisible ? 'text' : 'password'} value={newPassword} onChange={event => setNewPassword(event.target.value)} minLength={12} maxLength={2048} autoComplete="new-password" required disabled={savingPassword} /></label>
        <label>{t('ui.fb22627cf996')}<input type={passwordVisible ? 'text' : 'password'} value={confirmPassword} onChange={event => setConfirmPassword(event.target.value)} minLength={12} maxLength={2048} autoComplete="new-password" required disabled={savingPassword} /></label>
        </div>
        <PasswordTools value={newPassword} visible={passwordVisible} disabled={savingPassword} onVisibleChange={setPasswordVisible} onGenerate={value => { setNewPassword(value); setConfirmPassword(value); setError(''); setNotice(''); }} />
        <button type="submit" className="button outline" disabled={savingPassword}>{savingPassword ? t('ui.388a6a44bc1d') : t('ui.ce5652956107')}</button>
      </form>
    </section> : profile && <section className="settings-card settings-password">
      <div className="settings-card-title"><h2>{t('ui.cb1a2074b3a0')}</h2><p>{t('ui.c7e28223e858')}{profile.provider === 'ldap' ? 'LDAP/AD' : profile.provider === 'oidc' ? t('ui.72ea3132f2ac') : t('ui.9e3043ce35d0')}.</p></div>
      <p className="settings-hint">{t('ui.b2e57648fecd')}</p>
    </section>;

  return <div className="user-settings-page">
    <div className="page-heading">
      <div>
        <div className="breadcrumbs">{t('ui.3ef4a346c6df')}<span>/</span> {t('ui.5ea628ee36fe')}</div>
        <h1>{t('ui.32fe3de56050')}</h1>
        <p>{t('ui.3a6fe7fca78c')}</p>
      </div>
    </div>
    {error && <div className="inline-error settings-feedback" role="alert"><Icon name="alert" size={16} />{localizeText(error)}</div>}
    {notice && <div className="account-notice settings-feedback" role="status"><Icon name="check" size={16} />{localizeText(notice)}</div>}
    <div className="settings-layout">
    <aside className="settings-side">
    <section className="settings-identity">
      <span className="account-avatar">{(profile?.displayName || user.displayName || user.username).slice(0, 1).toUpperCase()}</span>
      <div><strong>{profile?.displayName || user.displayName || user.username}</strong><small>@{user.username}</small></div>
      <span className="account-role">{roleLabel(user)}</span>
    </section>
    <nav className="settings-nav" aria-label={t('ui.2d73b4c38491')}>
      {settingsSections().filter(([id]) => id !== 'keys' || can(user, 'sessions.adb')).map(([id, label]) =>
        <button key={id} type="button" aria-current={section === id ? 'page' : undefined} aria-controls={`settings-${id}`} onClick={() => { setSection(id); window.location.hash = `/account/${id}`; }}>{label}</button>)}
    </nav>
    </aside>
    <div className="settings-content">
    <div id="settings-profile" className="settings-panel" hidden={section !== 'profile'}>
      <section className="settings-card">
        <div className="settings-card-title"><h2>{t('ui.265bd5fc9cb2')}</h2><p>{profile?.managedByProvider ? t('ui.63b39f64a1f9') : t('ui.02f14dd10eda')}</p></div>
        {profileFeedback}
        {profileLoading ? <p className="settings-muted">{t('ui.22a5d9112486')}</p> :
          <form onSubmit={event => void saveProfile(event)} className="settings-form">
            <div className="settings-form-two">
              <label>{t('ui.1da7e9372e2f')}<input value={firstName} onChange={event => setFirstName(event.target.value)} maxLength={100} disabled={!profile || savingProfile || profile.managedByProvider} autoComplete="given-name" /></label>
              <label>{t('ui.353eafa3bb36')}<input value={lastName} onChange={event => setLastName(event.target.value)} maxLength={100} disabled={!profile || savingProfile || profile.managedByProvider} autoComplete="family-name" /></label>
            </div>
            <div className="settings-form-two"><label>{t('ui.64d92044a1ff')}<input value={company} onChange={event => setCompany(event.target.value)} maxLength={150} disabled={!profile || savingProfile || profile.managedByProvider} autoComplete="organization" /></label>
            <label>{t('ui.65e47aff6622')}<input value={jobTitle} onChange={event => setJobTitle(event.target.value)} maxLength={150} disabled={!profile || savingProfile || profile.managedByProvider} autoComplete="organization-title" /></label></div>
            {profile?.managedByProvider ? <p className="settings-hint">{t('ui.48311ccc29ec')}</p> :
              <button type="submit" className="button primary" disabled={!profile || savingProfile}>{savingProfile ? t('ui.9c27c381dd8b') : t('ui.c134971e8f29')}</button>}
          </form>}
      </section>
    </div>
    <div id="settings-appearance" className="settings-panel" hidden={section !== 'appearance'}>
      <section className="settings-card">
        <div className="settings-card-title"><h2>{t('ui.1731619efa3a')}</h2><p>{t('ui.ec778bdf0deb')}</p></div>
        {preferencesFeedback}
        <div className="settings-form appearance-form">
          <div className="appearance-language-control"><span>{t('language.label')}</span><LanguageControl /></div>
          <Segmented legend={t('ui.682f961a0751')} value={preferences.theme} disabled={preferencesLoading || !preferencesReady} onChange={theme => changePreferences({ theme })}
            options={[['system', t('ui.29e4a4bd7a17')], ['light', t('ui.f0cd3a603372')], ['dark', t('ui.1eecfcaa7bdb')]]} />
          <Segmented legend={t('ui.be517dba6cd0')} value={preferences.fontScale} disabled={preferencesLoading || !preferencesReady} onChange={fontScale => changePreferences({ fontScale })}
            options={[[0, t('ui.8dca2f783130')], [0.9, '90%'], [1, '100%'], [1.15, '115%'], [1.3, '130%'], [1.5, '150%']]}
            hint={preferences.fontScale === 0 ? t('ui.e60fa06807e0') : t('ui.219e2b97e97a', { p0: Math.round(16 * preferences.fontScale) })} />
          <p className="appearance-preview">{t('ui.501b15dc7dc7')}<strong>{t('ui.9fd8a397265e')}</strong> <small>{t('ui.b77cc129c4cb')}</small></p>
          <p className={'appearance-status' + (prefsStatus === 'error' ? ' error' : '')} role="status">{prefsStatus === 'saving' ? t('ui.9c27c381dd8b') : prefsStatus === 'saved' ? t('ui.2fe8f2fd7243') : prefsStatus === 'error' ? t('ui.6d1e3f7c5f12') : t('ui.bb8cc125a08f')}</p>
        </div>
      </section>
    </div>
    <div id="settings-security" className="settings-panel" hidden={section !== 'security'}>
    {profileFeedback}
    {passwordCard}
    </div>
    <div id="settings-notifications" hidden={section !== 'notifications'}><NotificationSettings /></div>
    <div id="settings-keys" hidden={section !== 'keys'}>
    {!preferencesReady && preferencesFeedback}
    {preferencesLoading ? <p className="settings-muted">{t('ui.22a5d9112486')}</p> : preferencesReady && can(user, 'sessions.adb') && <AdbKeysPage user={user} embedded defaultAdbKeyId={preferences.defaultAdbKeyId} onDefaultKeyChanged={setDefaultKey} />}
    </div>
    <div id="settings-history" hidden={section !== 'history'}>
    <section className="settings-history" aria-labelledby="my-rentals-heading">
      <div className="account-section-heading"><div><h2 id="my-rentals-heading">{t('ui.d9603f333a4a')}</h2><p>{t('ui.96868b8c4fa1')}</p></div></div>
      {loadError(rentalsError, () => setRentalsRetry(value => value + 1))}
      <div className="settings-history-list">
        {rentalsLoading ? <div className="settings-history-empty">{t('ui.efb18c179df6')}</div> : rentals.length === 0 ? !rentalsError && <div className="settings-history-empty">{t('ui.74e2bc5eb86a')}</div> :
          rentals.map(rental => <article className="settings-rental" key={rental.id}>
            <div><strong>{rental.profileName}</strong><small>#{rental.sessionId.slice(0, 8)} · {rental.hostName}</small></div>
            <div><span>{t('ui.4e5f1288359e')}{dateLabel(rental.createdAt)}</span><small>{rental.endedAt ? t('ui.89b05059d036') + dateLabel(rental.endedAt) : t('ui.983ec1306814')}</small></div>
          </article>)}
      </div>
      {rentalCursor && <button className="button outline settings-more" type="button" onClick={() => void loadMoreRentals()} disabled={loadingMore}>{loadingMore ? t('ui.22a5d9112486') : t('ui.c6826c783794')}</button>}
    </section>
    </div>
    </div>
    </div>
  </div>;
}
