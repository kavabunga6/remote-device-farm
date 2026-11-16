import { useEffect, useState, type FormEvent } from 'react';
import examples from '../../shared/interface-examples.json';
import { localizeText, t } from './i18n';
import { useAccess } from './permissions';
import { ActivityIndicator } from './ActivityIndicator';
import { FormSaveActions } from './FormSaveActions';
import { outboundProxyApi, type ProxySettings } from './outbound-proxy-api';
import './RegistrationSettings.css';
import './ServerSettings.css';

export function ServerSettings() {
  const can = useAccess();
  const [saved, setSaved] = useState<ProxySettings | null>(null);
  const [draft, setDraft] = useState<ProxySettings | null>(null);
  const [password, setPassword] = useState<string | null>(null);
  const [busy, setBusy] = useState(false), [done, setDone] = useState(false);
  const [error, setError] = useState(''), [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const control = new AbortController(); setError('');
    void outboundProxyApi.read(control.signal).then(({ proxy }) => {
      if (!control.signal.aborted) { setSaved(proxy); setDraft(proxy); }
    }).catch(cause => { if (!control.signal.aborted) setError(cause.message); });
    return () => control.abort();
  }, [attempt]);
  const dirty = Boolean(draft && saved && (draft.enabled !== saved.enabled || draft.url !== saved.url || draft.username !== saved.username || draft.noProxy !== saved.noProxy || password !== null));
  const editable = can('server.settings') && !busy;
  const change = (value: Partial<ProxySettings>) => { setDraft(previous => previous && { ...previous, ...value }); setDone(false); };
  const reset = () => { setDraft(saved); setPassword(null); setError(''); setDone(false); };
  const save = async (event: FormEvent) => {
    event.preventDefault(); if (!draft || !dirty || !editable) return;
    setBusy(true); setError(''); setDone(false);
    try {
      const { proxy } = await outboundProxyApi.save({ enabled: draft.enabled, url: draft.url, username: draft.username, noProxy: draft.noProxy, ...(password !== null ? { password } : {}) });
      setSaved(proxy); setDraft(proxy); setPassword(null); setDone(true);
    } catch (cause) { setError(cause instanceof Error ? cause.message : t('ui.8f9c4884b8f9')); }
    finally { setBusy(false); }
  };
  return <section className="server-settings" aria-labelledby="outbound-proxy-heading">
    <header><h2 id="outbound-proxy-heading">{t('proxy.title')}</h2><p>{t('proxy.description')}</p></header>
    {!draft && !error && <p role="status"><ActivityIndicator />{t('ui.22a5d9112486')}</p>}
    {draft && <form id="outbound-proxy-form" onSubmit={event => void save(event)} aria-busy={busy}>
      <label className="registration-toggle"><span>{t('proxy.enable')}</span><input type="checkbox" role="switch" checked={draft.enabled} disabled={!editable} onChange={event => change({ enabled: event.target.checked })} /></label>
      <label className="proxy-field"><span>{t('proxy.address')}</span><input type="url" dir="ltr" value={draft.url} required={draft.enabled} disabled={!editable} autoComplete="off" placeholder="http://proxy.example:3128" onChange={event => change({ url: event.target.value })} /></label>
      <div className="proxy-field"><label htmlFor="proxy-bypass-input">{t('proxy.noProxy')}</label><input id="proxy-bypass-input" dir="ltr" value={draft.noProxy} maxLength={4096} disabled={!editable} autoComplete="off" placeholder={examples.noProxy} aria-describedby="proxy-bypass-hint" onChange={event => change({ noProxy: event.target.value })}/><small id="proxy-bypass-hint">{t('proxy.noProxyHelp')}</small></div>
      <div className="proxy-credentials">
        <label className="proxy-field"><span>{t('proxy.username')}</span><input dir="auto" value={draft.username} disabled={!editable} autoComplete="off" onChange={event => change({ username: event.target.value })} /></label>
        <label className="proxy-field"><span>{t('proxy.password')}</span><input type="password" value={password ?? ''} disabled={!editable} autoComplete="new-password" aria-describedby="proxy-password-hint" onChange={event => { setPassword(event.target.value || null); setDone(false); }} /></label>
      </div>
      <div className="proxy-password-state"><small id="proxy-password-hint">{t(password === '' ? 'proxy.passwordCleared' : saved?.passwordSet ? 'proxy.passwordKeep' : 'proxy.passwordOptional')}</small>{saved?.passwordSet && <button type="button" className="button outline" disabled={!editable || password === ''} onClick={() => { setPassword(''); setDone(false); }}>{t('proxy.clearPassword')}</button>}</div>
      <div className="proxy-scope"><p>{t('proxy.scope')}</p><p>{t('proxy.dockerNote')}</p><p>{t('proxy.pending')}</p></div>
      <div className="proxy-actions"><FormSaveActions formId="outbound-proxy-form" dirty={dirty} busy={busy} disabled={!editable} context={t('proxy.title')}/><button type="button" className="button outline" disabled={!dirty || busy} onClick={reset}>{t('proxy.reset')}</button></div>
    </form>}
    {error && <div className="inline-error" role="alert">{localizeText(error)}{!draft && <button type="button" className="button outline" onClick={() => setAttempt(value => value + 1)}>{t('ui.5189135a6110')}</button>}</div>}
    {done && <p className="proxy-saved" role="status">{t('proxy.saved')}</p>}
  </section>;
}
