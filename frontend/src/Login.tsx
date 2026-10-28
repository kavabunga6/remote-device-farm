import { useEffect, useState } from 'react';
import { api, type AppConfig, type User } from './api';
import { localizeText, t } from './i18n';
import { LanguageControl } from './LanguageControl';
import { Brand } from './Brand';
import { Icon } from './icons';
import { ActivityIndicator } from './ActivityIndicator';
import { registrationApi } from './registration-api';

function oidcLoginHref(value: string | undefined): string {
  if (!value) return '/api/oidc/start';
  try {
    const url = new URL(value, window.location.origin);
    if (url.origin === window.location.origin && url.pathname.startsWith('/api/oidc/')) return url.href;
  } catch { /* Invalid provider URL. */ }
  return '/api/oidc/start';
}
function displayError(error: unknown) { return error instanceof Error ? error.message : t('ui.8f9c4884b8f9'); }

export function Login({ config, onLogin }: { config: AppConfig; onLogin: (user: User) => void }) {
  const [provider, setProvider] = useState<'local' | 'ldap'>(config.authMethods.includes('local') ? 'local' : 'ldap');
  const [username, setUsername] = useState(''), [password, setPassword] = useState(''), [confirmPassword, setConfirmPassword] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [visible, setVisible] = useState(false);
  const [registrationEnabled, setRegistrationEnabled] = useState(config.registrationEnabled === true);
  const [registering, setRegistering] = useState(window.location.hash === '#/register' && registrationEnabled);
  const passwordAuth = config.authMethods.includes('local') || config.authMethods.includes('ldap');
  const canRegister = registrationEnabled && config.authMethods.includes('local');
  useEffect(() => {
    let active = true;
    // Refresh after logout as another administrator may have changed registration.
    void api.config().then(next => { if (active) setRegistrationEnabled(next.registrationEnabled === true); }).catch(() => {});
    return () => { active = false; };
  }, []);
  useEffect(() => {
    const changed = () => { setRegistering(window.location.hash === '#/register' && canRegister); setError(''); setPassword(''); setConfirmPassword(''); setVisible(false); };
    window.addEventListener('hashchange', changed);
    return () => window.removeEventListener('hashchange', changed);
  }, [canRegister]);
  const registration = registering && canRegister;
  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    setError('');
    if (registration && password !== confirmPassword) { setError(t('ui.aefb37b57125')); return; }
    setBusy(true);
    try {
      const user = registration ? await registrationApi.register(username.trim(), password) : await api.login(username.trim(), password, provider);
      setPassword(''); setConfirmPassword('');
      if (registration) window.location.hash = '';
      onLogin(user);
    } catch (cause) { setError(displayError(cause)); }
    finally { setBusy(false); }
  };
  return <main className="login-page">
    <section className="login-card" aria-labelledby="login-title">
      <div className="login-brand-row"><Brand tagline={false} /><LanguageControl /></div>
      <div className="login-heading"><h1 id="login-title">{registration ? t('auth.createTitle') : t('auth.signIn')}</h1></div>
      {(passwordAuth || registration) && <form onSubmit={event => void submit(event)} className="login-form" aria-busy={busy}>
        {!registration && config.authMethods.includes('local') && config.authMethods.includes('ldap') && <div className="segmented" role="group" aria-label={t('ui.14dc6236fa02')}><button type="button" className={provider === 'local' ? 'selected' : ''} aria-pressed={provider === 'local'} onClick={() => setProvider('local')}>{t('ui.6b722b8bfca8')}</button><button type="button" className={provider === 'ldap' ? 'selected' : ''} aria-pressed={provider === 'ldap'} onClick={() => setProvider('ldap')}>{t('ui.9018a328b298')}</button></div>}
        <label><span id="auth-username-label">{t('ui.5be12bfe49ea')}</span><input aria-labelledby="auth-username-label" autoComplete="username" autoCapitalize="none" spellCheck={false} disabled={busy} value={username} onChange={event => setUsername(event.target.value)} placeholder={t('auth.loginPlaceholder')} minLength={registration ? 3 : undefined} maxLength={150} pattern={registration ? '[A-Za-z0-9._@\\-]{3,150}' : undefined} aria-describedby={registration ? 'registration-login-hint' : undefined} required />{registration && <small id="registration-login-hint">{t('auth.loginHint')}</small>}</label>
        <label><span id="auth-password-label">{t('ui.cb1a2074b3a0')}</span><span className="login-password"><input aria-labelledby="auth-password-label" type={visible ? 'text' : 'password'} autoComplete={registration ? 'new-password' : 'current-password'} disabled={busy} value={password} onChange={event => setPassword(event.target.value)} placeholder={t('auth.passwordPlaceholder')} minLength={registration ? 12 : undefined} maxLength={2048} aria-describedby={registration ? 'registration-password-hint' : undefined} required /><button type="button" className="login-password-toggle" aria-label={visible ? t('auth.hidePassword') : t('auth.showPassword')} aria-pressed={visible} disabled={busy} onClick={() => setVisible(value => !value)}><Icon name={visible ? 'eyeOff' : 'eye'} size={18} /></button></span>{registration && <small id="registration-password-hint">{t('auth.passwordHint')}</small>}</label>
        {registration && <label>{t('auth.confirmPassword')}<input type={visible ? 'text' : 'password'} autoComplete="new-password" disabled={busy} value={confirmPassword} onChange={event => setConfirmPassword(event.target.value)} placeholder={t('auth.confirmPlaceholder')} minLength={12} maxLength={2048} required /></label>}
        {error && <div className="inline-error" role="alert">{localizeText(error)}</div>}
        <button className="button primary login-submit" disabled={busy} type="submit">{busy ? <><ActivityIndicator />{registration ? t('auth.creatingAccount') : t('ui.0d71e00507e1')}</> : registration ? t('auth.createAccount') : t('ui.8fc9ab2eeb38')}</button>
      </form>}
      {!registration && config.authMethods.includes('oidc') && <a className={`button ${passwordAuth ? 'outline' : 'primary'} login-submit`} href={oidcLoginHref(config.oidcLoginUrl)}>{t('ui.c4eeb0ed88f0')}</a>}
      {!passwordAuth && !config.authMethods.includes('oidc') && <div className="inline-error"><Icon name="alert" size={18} />{t('ui.6b0503953f0b')}</div>}
      {canRegister && <p className="login-alternate"><span>{registration ? t('auth.haveAccount') : t('auth.noAccount')}</span><a href={registration ? '#/login' : '#/register'} aria-disabled={busy} onClick={event => { if (busy) event.preventDefault(); }}>{registration ? t('ui.8fc9ab2eeb38') : t('auth.register')}</a></p>}
    </section>
  </main>;
}
