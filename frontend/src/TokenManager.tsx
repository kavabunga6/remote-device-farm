import { TranslatedText } from './TranslatedText';
import { can } from './permissions';
import { getLocale, localizeText, t } from './i18n';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type ApiToken, type User } from './api';
import { Icon } from './icons';
import './TokenManager.css';

type TokenKind = ApiToken['kind'];

function dateLabel(value: string | null): string {
  if (!value) return t('ui.28c54755b53e');
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : new Intl.DateTimeFormat(getLocale(), { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function tokenError(error: unknown): string {
  return error instanceof Error ? error.message : t('ui.8f9c4884b8f9');
}

function TokenSection({ kind, onChanged }: { kind: TokenKind; onChanged?: () => void }) {
  const system = kind === 'system';
  const [tokens, setTokens] = useState<ApiToken[]>([]);
  const [name, setName] = useState('');
  const [expiry, setExpiry] = useState('30');
  const [oneTimeToken, setOneTimeToken] = useState<string | null>(null);
  const [pendingRevoke, setPendingRevoke] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const nameInput = useRef<HTMLInputElement>(null);

  const openCreate = () => {
    if (createOpen) nameInput.current?.focus();
    else setCreateOpen(true);
  };

  useEffect(() => { if (createOpen) nameInput.current?.focus(); }, [createOpen]);

  const load = useCallback(async () => {
    try {
      setTokens(system ? await api.systemTokens() : await api.tokens());
      setError('');
    } catch (cause) { setError(tokenError(cause)); }
    finally { setLoading(false); }
  }, [system]);

  useEffect(() => { void load(); }, [load]);

  const create = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const cleanName = name.trim();
    if (!cleanName || busy || oneTimeToken) return;
    setBusy(true); setError(''); setOneTimeToken(null); setCopied(false);
    try {
      const days = expiry === 'never' ? null : Number(expiry);
      const result = system ? await api.createSystemToken(cleanName, days) : await api.createToken(cleanName, days);
      setTokens(previous => [result.item, ...previous]);
      setOneTimeToken(result.token);
      setName(''); onChanged?.();
    } catch (cause) { setError(tokenError(cause)); }
    finally { setBusy(false); }
  };

  const revoke = async (id: string) => {
    if (busy) return;
    setBusy(true); setError('');
    try {
      if (system) await api.revokeSystemToken(id);
      else await api.revokeToken(id);
      setTokens(previous => previous.filter(token => token.id !== id));
      setPendingRevoke(null); onChanged?.();
    } catch (cause) { setError(tokenError(cause)); }
    finally { setBusy(false); }
  };

  const copy = async () => {
    if (!oneTimeToken) return;
    try {
      await navigator.clipboard.writeText(oneTimeToken);
      setCopied(true);
    } catch (cause) { setError(t('ui.61624f00ebab', { p0: tokenError(cause) })); }
  };

  return <section className="content-section token-section">
    <div className="section-heading"><div><h2 className="heading-with-count"><span>{system ? t('ui.aa3bc0899e14') : t('ui.21af8da84436')}</span><span className="count-pill">{tokens.length}</span></h2><p>{system ? t('ui.383902f93b5d') : t('ui.6dcc7039d9d7')}</p></div><div className="token-heading-actions"><button type="button" className={`button ${createOpen ? 'outline' : 'primary'}`} aria-expanded={createOpen} aria-controls={`token-create-${kind}`} onClick={() => setCreateOpen(value => !value)} disabled={busy || Boolean(oneTimeToken)}><Icon name={createOpen ? 'close' : 'plus'} size={16} />{createOpen ? t('ui.8fbe9b75cbdf') : t('ui.3daa5af70841')}</button></div></div>
    <div className="token-grid token-workspace">
      <div className={`token-list${!loading && !tokens.length ? ' interactive-card' : ''}`}>
        {loading ? <p className="token-empty">{t('ui.11424745768b')}</p> : tokens.length ? tokens.map(token => {
          const expired = Boolean(token.expiresAt && new Date(token.expiresAt).getTime() <= Date.now());
          return <div className="token-row" key={token.id}>
            <span className="token-row-icon"><Icon name="key" size={18} /></span>
            <div className="token-row-main"><strong>{token.name}</strong><small><TranslatedText message="copy.TokenManager.49254e2d" values={{ p0: dateLabel(token.createdAt), p1: <span className="middle-dot">·</span>, p2: expired ? t('ui.85d3fd5f95a2') : token.expiresAt ? t('ui.f0964d893455', { p0: dateLabel(token.expiresAt) }) : t('ui.28c54755b53e') }} /></small><small><TranslatedText message="copy.TokenManager.5dab447b" values={{ p0: token.lastUsedAt ? dateLabel(token.lastUsedAt) : t('ui.8b13ad14be5f') }} /></small></div>
            {pendingRevoke === token.id ? <div className="token-confirm"><span>{t('ui.5bba006de84c')}</span><button type="button" className="text-button danger-text" onClick={() => void revoke(token.id)} disabled={busy}>{t('ui.93e6073f9005')}</button><button type="button" className="text-button" onClick={() => setPendingRevoke(null)} disabled={busy}>{t('ui.43e5ab70f691')}</button></div> : <button type="button" className="text-button danger-text" onClick={() => setPendingRevoke(token.id)}>{t('ui.b66927e0fc8e')}</button>}
          </div>;
        }) : <div className="token-empty"><span className="token-row-icon"><Icon name="key" size={22} /></span><div><strong><button type="button" className="card-primary-action" aria-label={system ? t('ui.187b776acda5') : t('ui.82b82d5e9d6b')} aria-describedby={`token-empty-${kind}`} aria-expanded={createOpen} aria-controls={`token-create-${kind}`} onClick={openCreate} disabled={busy || Boolean(oneTimeToken)}>{t('ui.687c3849229b')}</button></strong><span id={`token-empty-${kind}`}>{t('ui.97b70fc769cc')}</span></div><Icon name="arrowRight" size={20} className="token-empty-arrow" /></div>}
      </div>
      <form id={`token-create-${kind}`} hidden={!createOpen} className="token-create" onSubmit={event => void create(event)}><div className="token-create-intro"><h3>{t('ui.3daa5af70841')}</h3><p>{system ? t('ui.e2207431a1cd') : t('ui.9f22286f3b25')}</p></div><label>{t('ui.0918b4ba9268')}<input ref={nameInput} value={name} onChange={event => setName(event.target.value)} maxLength={100} required placeholder={system ? t('ui.651aa52f8b26') : t('ui.4727f0365766')} /></label><label>{t('ui.ab57d211c97b')}<select value={expiry} onChange={event => setExpiry(event.target.value)}><option value="7">{t('ui.7867a2095f60')}</option><option value="30">{t('ui.254d55672b1d')}</option><option value="90">{t('ui.add2e2fe3047')}</option><option value="365">{t('ui.3f9ab002f842')}</option><option value="never">{t('ui.28c54755b53e')}</option></select></label><button className="button primary" type="submit" disabled={busy || !name.trim() || Boolean(oneTimeToken)}>{busy ? t('ui.9c27c381dd8b') : t('ui.28b05b44b8d4')}<Icon name="arrowRight" size={16} /></button>
        {oneTimeToken && <div className="token-secret" role="status"><strong>{t('ui.2ec01eb68487')}</strong><p>{t('ui.d658925005d8')}</p><div><code>{oneTimeToken}</code><button type="button" onClick={() => void copy()} title={t('ui.d681df9302e6')} aria-label={t('ui.d681df9302e6')}><Icon name={copied ? 'check' : 'copy'} size={17} /></button></div>{copied && <small>{t('ui.d2d08c715ee6')}</small>}<button type="button" className="button outline token-secret-done" onClick={() => { setOneTimeToken(null); setCreateOpen(false); }}>{t('ui.8ac219f79ab7')}</button></div>}
      </form>
    </div>
    {error && <div className="inline-error token-error" role="alert"><Icon name="alert" size={16} />{localizeText(error)}<button type="button" onClick={() => void load()}>{t('ui.5189135a6110')}</button></div>}
  </section>;
}

export function TokenManager({ user, onChanged }: { user: User; onChanged?: () => void }) {
  return <div className="token-page"><div className="page-heading"><div><div className="breadcrumbs">{t('ui.3ef4a346c6df')}<span>/</span> {t('ui.90c524b3399b')}</div><h1>{t('ui.daaf8ccbab69')}</h1><p>{t('ui.5d6cc98f8743')}</p></div></div><TokenSection kind="personal" onChanged={onChanged} />{can(user, 'tokens.system') && <TokenSection kind="system" onChanged={onChanged} />}</div>;
}
