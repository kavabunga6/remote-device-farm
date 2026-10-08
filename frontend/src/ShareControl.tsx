import { getLocale, localizeText, t } from './i18n';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { DeviceSession, User } from './api';
import { Icon } from './icons';
import { shareApi, shareLink, type ShareMode } from './share-api';
import type { SessionAudienceController } from './useSessionAudience';
import { audienceDescription } from './session-audience';
import './Share.css';

function durations(): Array<[number, string]> { return [[15, t('ui.c4c2c59efde6')], [60, t('ui.5dfb17673057')], [120, t('ui.f2b422a49937')], [240, t('ui.b4c02e440cdb')], [480, t('ui.f9748dc85d5a')]]; }
const MODE_LABEL: Record<ShareMode, string> = { get view() { return t('ui.f1163738deb5'); }, get control() { return t('ui.a4bba03c40fd'); } };

const errorText = (error: unknown) => error instanceof Error ? error.message : t('ui.8f9c4884b8f9');
const timeLabel = (iso: string) => new Date(iso).toLocaleTimeString(getLocale(), { hour: '2-digit', minute: '2-digit' });

// Share a running session with a colleague (view-only or control, with an expiry). Owner only.
export function ShareControl({ session, user, audience }: { session: DeviceSession | null; user: User; audience: SessionAudienceController }) {
  const sessionId = session?.id;
  const active = !!session && session.ownerId === user.id && (session.status === 'running' || session.status === 'starting');
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<ShareMode>('view');
  const [recipientMode, setRecipientMode] = useState<'single' | 'multiple'>('single');
  const [recipientLimit, setRecipientLimit] = useState(5);
  const [ttl, setTtl] = useState(60);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [link, setLink] = useState('');
  const [copied, setCopied] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => {
    if (busy) return;
    setOpen(false); setLink(''); setCopied(false);
  }, [busy]);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent) => { if (!rootRef.current?.contains(event.target as Node)) close(); };
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') close(); };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('pointerdown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open, close]);

  if (!active || !sessionId) return null;
  const shares = audience.shares;
  const known = audience.status === 'ready';
  const connected = known ? audience.connected : 0;

  const create = async () => {
    setBusy(true); setError(''); setCopied(false);
    try {
      const result = await shareApi.create(sessionId, mode, ttl, recipientMode === 'single' ? 1 : recipientLimit);
      setLink(shareLink(result.token));
      await audience.refresh();
    } catch (e) { setError(errorText(e)); }
    finally { setBusy(false); }
  };
  const revoke = async (action: () => Promise<unknown>, onRevoked: () => void) => {
    setError(''); setBusy(true);
    try { await action(); onRevoked(); await audience.refresh(); } catch (e) { setError(errorText(e)); }
    finally { setBusy(false); }
  };
  const copy = async () => {
    try { await navigator.clipboard.writeText(link); setCopied(true); }
    catch { setError(t('ui.9b5519d7c922')); }
  };

  return <div className="share-control" ref={rootRef}>
    <button type="button" className="button outline share-button" aria-expanded={open} aria-haspopup="dialog" onClick={() => { if (open) close(); else { setOpen(true); void audience.refresh(); } }}>
      <Icon name="user" size={17} />{t('ui.dc120821c212')}{known && (connected > 0 || audience.activeLinks > 0) && <span className="share-count" title={audienceDescription(audience)}>{connected > 0 ? t('ui.6bfac468e8a5') + connected : t('ui.c1500d1211e4') + audience.activeLinks}</span>}{!known && <span className="share-status-unknown" title={audienceDescription(audience)} aria-label={audienceDescription(audience)}>{audience.status === 'loading' ? '…' : '?'}</span>}
    </button>
    {open && <div className="share-popover" role="dialog" aria-label={t('ui.c61ec5a31b0d')}>
      <div className="share-head">
        <div><strong>{t('ui.2f9b62797fb3')}</strong><p>{t('ui.84765be25f80')}</p></div>
        <button type="button" className="icon-button" aria-label={t('ui.a7a4033657e8')} onClick={close} disabled={busy}><Icon name="close" size={16} /></button>
      </div>
      {link ? <div className="share-link-box">
        <input readOnly value={link} aria-label={t('ui.ad4145b4c7b2')} onFocus={event => event.currentTarget.select()} />
        <p>{t('ui.de441ee2544a')}</p>
        <div><button type="button" className="button primary small" onClick={() => void copy()}><Icon name={copied ? 'check' : 'copy'} size={15} />{copied ? t('ui.d2d08c715ee6') : t('ui.1ecddf40bfeb')}</button>{' '}
          <button type="button" className="text-button" onClick={() => { setLink(''); setCopied(false); }}>{t('ui.ef05d57959cf')}</button></div>
      </div> : <form className="share-form" onSubmit={event => { event.preventDefault(); void create(); }}>
        <fieldset>
          <legend>{t('ui.07aa3a1f550f')}</legend>
          <label className="share-choice"><input type="radio" name="share-mode" checked={mode === 'view'} onChange={() => setMode('view')} /><span>{t('ui.f2eb6be2e503')}<small>{t('ui.287971fff85f')}</small></span></label>
          <label className="share-choice"><input type="radio" name="share-mode" checked={mode === 'control'} onChange={() => setMode('control')} /><span>{t('ui.ead64f5915d3')}<small>{t('ui.8f058c226402')}</small></span></label>
        </fieldset>
        <fieldset>
          <legend>{t('ui.11f5ed36cd60')}</legend>
          <label className="share-choice"><input type="radio" name="share-recipients" checked={recipientMode === 'single'} onChange={() => setRecipientMode('single')} /><span>{t('ui.dad7c0857e1b')}<small>{t('ui.7c3c3256d58d')}</small></span></label>
          <label className="share-choice"><input type="radio" name="share-recipients" checked={recipientMode === 'multiple'} onChange={() => setRecipientMode('multiple')} /><span>{t('ui.f6cc568b1357')}<small>{t('ui.e822976c32e3')}</small></span></label>
        </fieldset>
        {recipientMode === 'multiple' && <label className="share-limit">{t('ui.137e09f236c8')}<input type="number" min={2} max={10} step={1} required value={recipientLimit} onChange={event => setRecipientLimit(Number(event.target.value))} />
          <small>{t('ui.56dc4056467d')}</small>
        </label>}
        <label>{t('ui.451ee95a4225')}<select value={ttl} onChange={event => setTtl(Number(event.target.value))}>{durations().map(([minutes, label]) => <option key={minutes} value={minutes}>{label}</option>)}</select></label>
        <button type="submit" className="button primary" disabled={busy || (recipientMode === 'multiple' && (!Number.isInteger(recipientLimit) || recipientLimit < 2 || recipientLimit > 10))}>{busy ? t('ui.c2f23e83210c') : t('ui.3e09674f8b2c')}</button>
      </form>}
      {error && <p className="share-error" role="alert">{localizeText(error)}</p>}
      <div>
        <strong>{t('ui.899798fc541f')}</strong><p className="share-audience-status" role="status">{audienceDescription(audience)}</p>
        {!known ? <div className="share-empty">{audience.error && <p>{audience.error}</p>}<button type="button" className="text-button" onClick={() => void audience.refresh()}>{t('ui.492dbf155f39')}</button></div> : shares.length === 0 ? null : <ul className="share-list">
          {shares.map(share => <li className="share-item" key={share.id}>
            <div className="share-item-head"><span>{MODE_LABEL[share.mode]} · {(share.maxRecipients ?? 1) > 1 ? t('ui.f6cc568b1357') : t('ui.dad7c0857e1b')} <small>{t('ui.6193c9a62e65')}{share.recipientsUsed ?? share.redeemers.length} {t('ui.e029cc4b39ce')}{share.maxRecipients ?? 1} {t('ui.0afb1c2a3da3')}{timeLabel(share.expiresAt)}</small></span>
              <button type="button" className="text-button danger-text" disabled={busy} onClick={() => void revoke(() => shareApi.revoke(sessionId, share.id), () => audience.forgetShare(share.id))}>{t('ui.b66927e0fc8e')}</button></div>
            {share.redeemers.length === 0 ? <p className="share-empty">{share.recipientsUsed > 0 ? t('ui.43cf28ae016c') : t('ui.464f749b308c')}</p> : <ul className="share-people">
              {share.redeemers.map(person => <li key={person.grantId}>
                <span><span className={'share-dot' + (person.connected ? ' online' : '')} />{person.name}<small>{MODE_LABEL[person.mode]} · {person.connected ? t('ui.4dbb1e2b2e81') : t('ui.a9440e271c4b')}</small></span>
                <button type="button" className="text-button danger-text" disabled={busy} onClick={() => void revoke(() => shareApi.revokeGrant(sessionId, share.id, person.grantId), () => audience.forgetGrant(share.id, person.grantId))}>{t('ui.de1aec86abbf')}</button>
              </li>)}
            </ul>}
          </li>)}
        </ul>}
      </div>
    </div>}
  </div>;
}

// Opens #/shared/<token>: redeems the link and moves to the session.
export function SharedRedeemPage({ token, onOpen, onCancel }: { token: string; onOpen: (sessionId: string) => void; onCancel: () => void }) {
  const [error, setError] = useState('');
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    // The token must not stay in the address bar or the history.
    window.history.replaceState(null, '', window.location.pathname + '#/overview');
    shareApi.redeem(token).then(result => onOpen(result.sessionId)).catch(e => setError(errorText(e)));
  }, [token, onOpen]);
  return <div className="shared-page">
    <h1>{t('ui.c61ec5a31b0d')}</h1>
    {error
      ? <><p className="share-error" role="alert">{localizeText(error)}</p><button type="button" className="button primary" onClick={onCancel}>{t('ui.2ee5c8fac080')}</button></>
      : <p role="status">{t('ui.c5cfd3ef587c')}</p>}
  </div>;
}

export function SharedBanner({ ownerName, mode }: { ownerName?: string; mode: ShareMode }) {
  const owner = ownerName || t('ui.84742a5dd8b3');
  return <div className="shared-banner" role="status"><Icon name="info" size={17} />
    <span>{mode === 'view' ? t('ui.53ceea22bec5', { p0: owner }) : t('ui.eead445575ec', { p0: owner })}</span></div>;
}
