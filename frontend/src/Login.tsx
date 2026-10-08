import { useState } from 'react';
import { api, type AppConfig, type User } from './api';
import { localizeText, t } from './i18n';
import { LanguageControl } from './LanguageControl';
import { Brand } from './Brand';
import { Icon } from './icons';
import { ActivityIndicator } from './ActivityIndicator';

function oidcLoginHref(value: string | undefined): string {
  if (!value) return '/api/oidc/start';
  try {
    const url = new URL(value, window.location.origin);
    if (url.origin === window.location.origin && url.pathname.startsWith('/api/oidc/')) return url.href;
  } catch { /* Ignore an invalid URL from the configuration response. */ }
  return '/api/oidc/start';
}

function displayError(error: unknown) { return error instanceof Error ? error.message : t('ui.8f9c4884b8f9'); }

export function Login({ config, onLogin }: { config: AppConfig; onLogin: (user: User) => void }) {
  const [provider, setProvider] = useState<'local' | 'ldap'>(config.authMethods.includes('local') ? 'local' : 'ldap');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const passwordAuth = config.authMethods.includes('local') || config.authMethods.includes('ldap');

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      onLogin(await api.login(username, password, provider));
    } catch (cause) {
      setError(displayError(cause));
    } finally {
      setBusy(false);
    }
  };

  return <main className="login-page">
    <section className="login-card" aria-labelledby="login-title">
      <div className="login-brand-row"><Brand /><LanguageControl /></div>
      <div className="login-heading"><h1 id="login-title">{t('ui.933fc1d44b2c')}</h1><p>{t('ui.50bb4d99250f')}</p></div>
      {passwordAuth && <form onSubmit={submit} className="login-form" aria-busy={busy}>
        {config.authMethods.includes('local') && config.authMethods.includes('ldap') && <div className="segmented" role="group" aria-label={t('ui.14dc6236fa02')}><button type="button" className={provider === 'local' ? 'selected' : ''} aria-pressed={provider === 'local'} onClick={() => setProvider('local')}>{t('ui.6b722b8bfca8')}</button><button type="button" className={provider === 'ldap' ? 'selected' : ''} aria-pressed={provider === 'ldap'} onClick={() => setProvider('ldap')}>{t('ui.9018a328b298')}</button></div>}
        <label>{t('ui.5be12bfe49ea')}<input autoComplete="username" disabled={busy} value={username} onChange={event => setUsername(event.target.value)} placeholder={t('ui.57f0472d45bb')} required /></label>
        <label>{t('ui.cb1a2074b3a0')}<input type="password" autoComplete="current-password" disabled={busy} value={password} onChange={event => setPassword(event.target.value)} placeholder={t('ui.065cafb3b330')} required /></label>
        {error && <div className="inline-error" role="alert"><Icon name="alert" size={17} />{localizeText(error)}</div>}
        <button className="button primary login-submit" disabled={busy} type="submit">{busy ? t('ui.0d71e00507e1') : t('ui.8fc9ab2eeb38')}{busy ? <ActivityIndicator /> : <Icon name="arrowRight" size={18} />}</button>
      </form>}
      {config.authMethods.includes('oidc') && <a className={`button ${passwordAuth ? 'outline' : 'primary'} login-submit`} href={oidcLoginHref(config.oidcLoginUrl)}>{t('ui.c4eeb0ed88f0')}<Icon name="arrowRight" size={18} /></a>}
      {!passwordAuth && !config.authMethods.includes('oidc') && <div className="inline-error"><Icon name="alert" size={18} />{t('ui.6b0503953f0b')}</div>}
      <div className="login-footnote"><Icon name="shield" size={16} /> {t('ui.a255565ec137')}</div>
    </section>
  </main>;
}

