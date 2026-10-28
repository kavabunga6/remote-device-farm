import { TranslatedText } from './TranslatedText';
import { downloadFile as downloadKeyFile } from './browser-files';
import { roleLabel } from './permissions';
import { getLocale, localizeText, t } from './i18n';
import { useEffect, useRef, useState } from 'react';
import { api, ApiError, type AdbPublicKey, type AdbUserKey, type NewAdbUserKey, type User } from './api';
import { Icon } from './icons';
import { ActivityIndicator } from './ActivityIndicator';
import { CountBadge } from './CountBadge';
import { useAdminDialog } from './useAdminDialog';
import './AdbKeysPage.css';

const MAX_PUBLIC_KEY_FILE_BYTES = 2048;
const MAX_KEYS = 20;

function dateLabel(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' :
    new Intl.DateTimeFormat(getLocale(), { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : t('ui.8f9c4884b8f9');
}


export function AdbKeysPage({ user, embedded = false, defaultAdbKeyId = null, onDefaultKeyChanged, onKeysChanged }: { user: User; embedded?: boolean; defaultAdbKeyId?: string | null; onDefaultKeyChanged?: (id: string | null) => Promise<void>; onKeysChanged?: () => void }) {
  const [farmKey, setFarmKey] = useState<AdbUserKey | null>(null);
  const [keys, setKeys] = useState<AdbPublicKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [farmBusy, setFarmBusy] = useState(false);
  const [uploadBusy, setUploadBusy] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [editingKeyId, setEditingKeyId] = useState<string | null>(null);
  const [keyNameDraft, setKeyNameDraft] = useState('');
  const [renameBusy, setRenameBusy] = useState(false);
  const [renameError, setRenameError] = useState('');
  const [confirmRotate, setConfirmRotate] = useState(false);
  const [newKey, setNewKey] = useState<NewAdbUserKey | null>(null);
  const [privateDownloaded, setPrivateDownloaded] = useState(false);
  const [publicDownloaded, setPublicDownloaded] = useState(false);
  const [discardConfirm, setDiscardConfirm] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [fileName, setFileName] = useState('');
  const [setUploadedAsDefault, setSetUploadedAsDefault] = useState(false);
  const [publicKey, setPublicKey] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [defaultBusy, setDefaultBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const renameInput = useRef<HTMLInputElement>(null);
  const farmAction = useRef<HTMLButtonElement>(null);
  const discardCancel = useRef<HTMLButtonElement>(null);
  const dialogWasOpen = useRef(false);
  const keyDialog = useAdminDialog(Boolean(newKey), false, () => {
    if (privateDownloaded && publicDownloaded) finishKeySetup();
    else setDiscardConfirm(true);
  });

  useEffect(() => {
    if (!newKey && dialogWasOpen.current) farmAction.current?.focus();
    dialogWasOpen.current = Boolean(newKey);
  }, [newKey]);
  useEffect(() => { if (discardConfirm) discardCancel.current?.focus(); }, [discardConfirm]);

  useEffect(() => { if (uploadOpen) nameInput.current?.focus(); }, [uploadOpen]);
  useEffect(() => {
    if (editingKeyId) { renameInput.current?.focus(); renameInput.current?.select(); }
  }, [editingKeyId]);

  useEffect(() => {
    let active = true;
    void Promise.all([api.adbUserKey(), api.listAdbPublicKeys()]).then(([farm, uploaded]) => {
      if (!active) return;
      setFarmKey(farm.key);
      setKeys(uploaded);
    }).catch(cause => {
      if (active) setError(errorMessage(cause));
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!newKey || (privateDownloaded && publicDownloaded)) return;
    const warnOnLeave = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warnOnLeave);
    return () => window.removeEventListener('beforeunload', warnOnLeave);
  }, [newKey, privateDownloaded, publicDownloaded]);

  const chooseDefaultKey = async (id: string | null) => {
    if (!onDefaultKeyChanged || defaultBusy) return;
    setDefaultBusy(true);
    setError('');
    setNotice('');
    try {
      await onDefaultKeyChanged(id);
      setNotice(t('ui.6f9ab1004e82'));
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setDefaultBusy(false);
    }
  };

  const choosePublicKey = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    setError('');
    setNotice('');
    setFileName('');
    setPublicKey('');
    if (!file) return;
    if (!file.name.toLowerCase().endsWith('.pub')) {
      setError(t('ui.e6fbe4542ec5'));
      event.target.value = '';
      return;
    }
    if (file.size > MAX_PUBLIC_KEY_FILE_BYTES) {
      setError(t('ui.6a709826f9e3'));
      event.target.value = '';
      return;
    }
    try {
      const content = await file.text();
      if (!content.trim() || content.includes('PRIVATE KEY')) {
        throw new Error(t('ui.168c68310fae'));
      }
      setPublicKey(content);
      setFileName(file.name);
    } catch (cause) {
      setError(errorMessage(cause));
      event.target.value = '';
    }
  };

  const addKey = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (uploadBusy || keys.length >= MAX_KEYS) return;
    const cleanName = name.trim();
    if (!cleanName || !publicKey) {
      setError(t('ui.ed93467bfc0b'));
      return;
    }
    setUploadBusy(true);
    setError('');
    setNotice('');
    try {
      const key = await api.addAdbPublicKey(cleanName, publicKey);
      setKeys(previous => [key, ...previous]);
      onKeysChanged?.();
      if (setUploadedAsDefault) await onDefaultKeyChanged?.(key.id);
      setSetUploadedAsDefault(false);
      setName('');
      setFileName('');
      setPublicKey('');
      if (fileInput.current) fileInput.current.value = '';
      setUploadOpen(false);
      setNotice(t('ui.e5af75b78ca3'));
    } catch (cause) {
      setError(cause instanceof ApiError && cause.status === 409
        ? t('ui.e2acd177bec4')
        : errorMessage(cause));
    } finally {
      setUploadBusy(false);
    }
  };

  const closeRename = () => {
    const id = editingKeyId;
    setEditingKeyId(null);
    setRenameError('');
    window.requestAnimationFrame(() => { if (id) document.getElementById(`adb-key-rename-${id}`)?.focus(); });
  };

  const renameKey = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const key = keys.find(item => item.id === editingKeyId);
    const name = keyNameDraft.trim();
    if (renameBusy || !key || !name) return;
    if (name === key.name) { closeRename(); return; }
    setRenameBusy(true);
    setRenameError('');
    setNotice('');
    try {
      const updated = await api.renameAdbPublicKey(key.id, name);
      setKeys(previous => previous.map(item => item.id === updated.id ? updated : item));
      onKeysChanged?.();
      closeRename();
      setNotice(t('adbKeys.nameSaved'));
    } catch (cause) {
      setRenameError(errorMessage(cause));
    } finally {
      setRenameBusy(false);
    }
  };

  const removeKey = async (id: string) => {
    if (deletingId) return;
    setDeletingId(id);
    setError('');
    setNotice('');
    try {
      await api.deleteAdbPublicKey(id);
      setKeys(previous => previous.filter(key => key.id !== id));
      onKeysChanged?.();
      if (defaultAdbKeyId === id) await onDefaultKeyChanged?.(null);
      setConfirmDeleteId(null);
      setNotice(t('ui.8ecd4554f23e'));
    } catch (cause) {
      setError(cause instanceof ApiError && cause.status === 409
        ? t('ui.5e6743b7d565')
        : errorMessage(cause));
    } finally {
      setDeletingId(null);
    }
  };

  const createOrRotateFarmKey = async () => {
    if (farmBusy) return;
    if (farmKey && !confirmRotate) {
      setConfirmRotate(true);
      return;
    }
    setFarmBusy(true);
    setError('');
    setNotice('');
    try {
      const created = farmKey ? await api.rotateAdbUserKey() : await api.createAdbUserKey();
      setFarmKey({ fingerprint: created.fingerprint, createdAt: created.createdAt });
      setNewKey(created);
      setPrivateDownloaded(false);
      setPublicDownloaded(false);
      setDiscardConfirm(false);
      setConfirmRotate(false);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setFarmBusy(false);
    }
  };

  const finishKeySetup = () => {
    if (!privateDownloaded || !publicDownloaded) return;
    setNewKey(null);
    setNotice(t('ui.8ad6af517a59'));
  };

  return <div className="account-page">
    {!embedded && <div className="page-heading">
      <div>
        <div className="breadcrumbs">{t('ui.3ef4a346c6df')}<span>/</span> {t('ui.5ea628ee36fe')}</div>
        <h1>{t('ui.32fe3de56050')}</h1>
        <p>{t('ui.45b8f2221465')}</p>
      </div>
    </div>}

    {!embedded && <div className="account-identity">
      <span className="account-avatar">{(user.displayName || user.username).slice(0, 1).toUpperCase()}</span>
      <div><strong>{user.displayName || user.username}</strong><span>@{user.username}</span></div>
      <span className="account-role">{roleLabel(user)}</span>
    </div>}

    <div className="account-section-heading">
      <div><h2>{t('ui.cc48c41eb523')}</h2><p>{t('ui.9687a30da2d7')}</p></div>
    </div>

    <div className="account-section-heading account-upload-heading">
      <div><h3 className="heading-with-count"><span>{t('ui.3ed03b512517')}</span><CountBadge label={t('ui.dcfc4b51425f')} value={keys.length} total={MAX_KEYS} /></h3><p>{t('ui.5de42930f4e5')}</p></div>
      <div className="account-heading-actions"><button type="button" className={`button ${uploadOpen ? 'outline' : 'primary'}`} aria-expanded={uploadOpen} aria-controls="adb-upload-form" onClick={() => setUploadOpen(value => !value)} disabled={uploadBusy}><Icon name={uploadOpen ? 'close' : 'plus'} size={16} />{uploadOpen ? t('ui.8fbe9b75cbdf') : t('ui.8f9699f02cd6')}</button></div>
    </div>
    <div className="account-key-grid">
      <div className="account-key-list" aria-label={t('ui.c511cdd3ae2e')}>
        {loading ? <div className="account-key-empty" role="status"><ActivityIndicator />{t('ui.7cea14ee0b50')}</div> : keys.length ? keys.map(key =>
          <div className="account-key-row" key={key.id}>
            <span className="account-key-icon"><Icon name="key" size={17} /></span>
            <div className="account-key-main">
              {editingKeyId === key.id ? <form className="account-key-rename-form" aria-label={t('adbKeys.rename', { p0: key.name })} aria-busy={renameBusy} onSubmit={event => void renameKey(event)} onKeyDown={event => {
                if (event.key === 'Escape') { event.preventDefault(); if (!renameBusy) closeRename(); }
              }}>
                <input ref={renameInput} type="text" aria-label={t('ui.0918b4ba9268')} value={keyNameDraft} maxLength={80} required autoComplete="off" disabled={renameBusy} aria-invalid={Boolean(renameError)} aria-describedby={renameError ? `adb-key-rename-error-${key.id}` : undefined} onChange={event => { setKeyNameDraft(event.target.value); setRenameError(''); }} />
                <button type="submit" className="icon-button account-key-save" aria-label={t('adbKeys.saveName')} title={t('adbKeys.saveName')} disabled={renameBusy || !keyNameDraft.trim()}>{renameBusy ? <ActivityIndicator /> : <Icon name="check" size={17} />}</button>
                <button type="button" className="icon-button" aria-label={t('ui.8fbe9b75cbdf')} title={t('ui.8fbe9b75cbdf')} disabled={renameBusy} onClick={closeRename}><Icon name="close" size={17} /></button>
                {renameError && <span id={`adb-key-rename-error-${key.id}`} className="account-key-rename-error" role="alert">{localizeText(renameError)}</span>}
              </form> : <div className="account-key-title">
                <strong>{key.name}{defaultAdbKeyId === key.id && <span className="account-default-tag"><Icon name="check" size={14} />{t('ui.422f550c9cff')}</span>}</strong>
              </div>}
              <small><TranslatedText message="copy.AdbKeysPage.77a87e4a" values={{ p0: dateLabel(key.createdAt) }} /></small><code title={key.fingerprint}>{key.fingerprint}</code>
            </div>
            <div className="account-key-actions">
            {defaultAdbKeyId !== key.id && onDefaultKeyChanged && <button type="button" className="button outline small" disabled={defaultBusy || editingKeyId === key.id} onClick={() => void chooseDefaultKey(key.id)}>{t('ui.12606cfe703d')}</button>}
            {editingKeyId !== key.id && <button id={`adb-key-rename-${key.id}`} type="button" className="icon-button account-key-rename-trigger" aria-label={t('adbKeys.rename', { p0: key.name })} title={t('adbKeys.rename', { p0: key.name })} disabled={renameBusy || deletingId === key.id || confirmDeleteId === key.id} onClick={() => { setEditingKeyId(key.id); setKeyNameDraft(key.name); setRenameError(''); setError(''); setNotice(''); }}><Icon name="pencil" size={16} /></button>}
            {confirmDeleteId === key.id ? <div className="account-delete-confirm"><span>{t('ui.f3372b17dad6')}</span><button type="button" className="text-button danger-text" onClick={() => void removeKey(key.id)} disabled={deletingId === key.id}>{t('ui.93e6073f9005')}</button><button type="button" className="text-button" onClick={() => setConfirmDeleteId(null)} disabled={deletingId === key.id}>{t('ui.43e5ab70f691')}</button></div> :
              <button type="button" className="icon-button danger-icon" aria-label={t('ui.be99b1361201')} title={t('ui.be99b1361201')} disabled={editingKeyId === key.id} onClick={() => setConfirmDeleteId(key.id)}><Icon name="trash" size={17} /></button>}
            </div>
          </div>,
        ) : <div className="account-key-empty"><Icon name="key" size={25} /><strong>{t('ui.84206b4eb947')}</strong><span>{t(farmKey ? 'adbKeys.addAnotherDescription' : 'ui.c356245e18ce')}</span></div>}
      </div>
      <form id="adb-upload-form" hidden={!uploadOpen} className="account-upload-card" onSubmit={event => void addKey(event)}>
        <h3>{t('ui.c1398f200d1b')}</h3>
        <p><TranslatedText message="copy.AdbKeysPage.c6f3bf98" values={{ p0: <code>{t('ui.9702ab6bff62')}</code>, p1: <code>{t('ui.8694fc709bdb')}</code> }} /></p>
        <label>{t('ui.0918b4ba9268')}<input ref={nameInput} type="text" value={name} onChange={event => setName(event.target.value)} maxLength={80} placeholder={t('ui.ee4cb068f541')} required /></label>
        <label className="account-file-picker"><Icon name="upload" size={18} /><span>{fileName || t('ui.1196877c500f')}</span><input ref={fileInput} type="file" accept=".pub,text/plain" onChange={event => void choosePublicKey(event)} aria-label={t('ui.fa7a0d22887a')} /></label>
        {onDefaultKeyChanged && <label className="account-default-checkbox"><input type="checkbox" checked={setUploadedAsDefault} onChange={event => setSetUploadedAsDefault(event.target.checked)} />{t('ui.fe006bc68384')}</label>}
        <button className="button primary" type="submit" disabled={loading || uploadBusy || keys.length >= MAX_KEYS || !name.trim() || !publicKey}>{uploadBusy ? t('ui.5637cb987056') : t('ui.8f9699f02cd6')}<Icon name="arrowRight" size={17} /></button>
        {keys.length >= MAX_KEYS && <small className="account-limit-note">{t('ui.b3e6fd00f6c0')}</small>}
      </form>
    </div>
    {farmKey && <section className="account-farm-card" aria-labelledby="farm-key-heading">
      <div className="account-card-icon"><Icon name="key" size={21} /></div>
      <div className="account-farm-copy">
        <div className="account-farm-title"><h3 id="farm-key-heading">{t('ui.5ddca3970fa0')}</h3>{defaultAdbKeyId === null && <span className="account-default-tag"><Icon name="check" size={14} />{t('ui.422f550c9cff')}</span>}</div>
        <p>{t('ui.b309b919d81d')}</p>
        <div className="account-fingerprint"><span>{t('ui.0ed41b980db8')}</span><code>{farmKey.fingerprint}</code><small><TranslatedText message="copy.AdbKeysPage.30c82cc6" values={{ p0: dateLabel(farmKey.createdAt) }} /></small></div>
        {confirmRotate && <div className="account-confirm" role="alert"><Icon name="alert" size={17} /><span>{t('ui.72d260e08ec4')}</span><button type="button" className="text-button danger-text" onClick={() => void createOrRotateFarmKey()} disabled={farmBusy}>{t('ui.c20163fda193')}</button><button type="button" className="text-button" onClick={() => setConfirmRotate(false)} disabled={farmBusy}>{t('ui.8fbe9b75cbdf')}</button></div>}
      </div>
      <div className="account-farm-actions">
      {defaultAdbKeyId !== null && onDefaultKeyChanged && <button className="button outline" type="button" disabled={defaultBusy} onClick={() => void chooseDefaultKey(null)}>{t('ui.12606cfe703d')}</button>}
      <button ref={farmAction} className="button outline account-farm-action" type="button" onClick={() => void createOrRotateFarmKey()} disabled={loading || farmBusy || confirmRotate}>
        {farmBusy ? <ActivityIndicator /> : <Icon name="refresh" size={17} />}{farmBusy ? t('ui.7e4f3baf839f') : t('ui.e52c9dc94523')}
      </button>
      </div>
    </section>}

    {!loading && !farmKey && <section className="account-key-create" aria-labelledby="adb-key-create-heading">
      <div>
        <h3 id="adb-key-create-heading">{t('adbKeys.createTitle')}</h3>
        <p>{t('adbKeys.createDescription')}</p>
      </div>
      <button ref={farmAction} type="button" className="button primary" disabled={farmBusy} onClick={() => void createOrRotateFarmKey()}>
        {farmBusy ? <ActivityIndicator /> : <Icon name="download" size={17} />}{farmBusy ? t('ui.7e4f3baf839f') : t('ui.963fd386776f')}
      </button>
    </section>}

    {error && <div className="inline-error account-feedback" role="alert"><Icon name="alert" size={17} />{localizeText(error)}</div>}
    {notice && <div className="account-notice" role="status"><Icon name="check" size={17} />{localizeText(notice)}</div>}
    {newKey && <div className="account-key-backdrop">
      <div ref={keyDialog} className="account-key-dialog" role="dialog" aria-modal="true" aria-labelledby="account-key-ready-heading" aria-describedby="account-key-ready-description" tabIndex={-1}>
        <header className="account-key-dialog-header">
          <div className="account-key-dialog-title">
            <span className="account-key-ready-icon"><Icon name="key" size={21} /></span>
            <h2 id="account-key-ready-heading">{t('ui.69957a5e654e')}</h2>
          </div>
          <p id="account-key-ready-description">{t('ui.cb2cb32940d9')}</p>
        </header>
        <div className="account-key-dialog-body">
          <div className="account-key-downloads">
            <div className="account-key-file">
              <h3><code>{t('ui.8694fc709bdb')}</code></h3>
              <p>{t('adbKeys.privateFileDescription')}</p>
              <button type="button" className={`button account-key-file-download${privateDownloaded ? ' downloaded' : ''}`} onClick={() => {
                downloadKeyFile('adbkey', newKey.privateKey);
                setPrivateDownloaded(true);
              }}><Icon name={privateDownloaded ? 'check' : 'download'} size={17} />{privateDownloaded ? t('ui.9f0fe20e39c8') : t('ui.e5324bf11872')}</button>
            </div>
            <div className="account-key-file">
              <h3><code>{t('ui.9702ab6bff62')}</code></h3>
              <p>{t('adbKeys.publicFileDescription')}</p>
              <button type="button" className={`button account-key-file-download${publicDownloaded ? ' downloaded' : ''}`} onClick={() => {
                downloadKeyFile('adbkey.pub', newKey.publicKey);
                setPublicDownloaded(true);
              }}><Icon name={publicDownloaded ? 'check' : 'download'} size={17} />{publicDownloaded ? t('ui.c3869d7ed2b5') : t('ui.49a05eedd8f1')}</button>
            </div>
          </div>
          <p className={`account-key-download-status${privateDownloaded && publicDownloaded ? ' complete' : ''}`} role="status"><Icon name={privateDownloaded && publicDownloaded ? 'check' : 'info'} size={17} /><span>{privateDownloaded && publicDownloaded ? t('ui.39414dcebf98') : privateDownloaded ? t('ui.0875dbd88096') : publicDownloaded ? t('ui.5069a75ea1b8') : t('ui.fc127f06243c')}</span></p>
          <section className="account-key-installation" aria-labelledby="account-key-save-heading">
            <h3 id="account-key-save-heading">{t('adbKeys.saveFilesTitle')}</h3>
            <dl className="account-key-folders">
              <div><dt>{t('adbKeys.windows')}</dt><dd><code>{t('ui.a14576083aa4')}</code></dd></div>
              <div><dt>{t('adbKeys.unix')}</dt><dd><code>{t('adbKeys.unixFolder')}</code></dd></div>
            </dl>
            <p>{t('adbKeys.backupExisting')}</p>
            <details className="account-key-custom-folder">
              <summary tabIndex={0}><span>{t('adbKeys.customFolderTitle')}</span><Icon name="chevronDown" size={16} /></summary>
              <p>{t('adbKeys.customFolderDescription')}</p>
            </details>
          </section>
          {discardConfirm && !(privateDownloaded && publicDownloaded) && <div className="account-key-discard" role="alert">
            <strong>{t('ui.0e12324ee6a9')}</strong>
            <p>{t('adbKeys.discardDescription')}</p>
            <div>
              <button type="button" className="button outline danger-text" onClick={() => {
                setNewKey(null);
                setDiscardConfirm(false);
                setNotice(t('ui.47787a5b0eda'));
              }}>{t('ui.6e703a57e182')}</button>
              <button ref={discardCancel} type="button" className="button outline" onClick={() => setDiscardConfirm(false)}>{t('ui.8fbe9b75cbdf')}</button>
            </div>
          </div>}
        </div>
        <footer className="account-key-dialog-actions">
          {!(privateDownloaded && publicDownloaded) && !discardConfirm && <button type="button" className="text-button danger-text" onClick={() => setDiscardConfirm(true)}>{t('ui.74f4e22caf07')}</button>}
          <button type="button" className="button primary" onClick={finishKeySetup} disabled={!privateDownloaded || !publicDownloaded}><Icon name="check" size={17} />{t('ui.ef05d57959cf')}</button>
        </footer>
      </div>
    </div>}
  </div>;
}
