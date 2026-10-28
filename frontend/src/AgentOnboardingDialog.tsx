import examples from '../../shared/interface-examples.json';
import { TranslatedText } from './TranslatedText';
import { downloadFile } from './browser-files';
import { getLocale, localizeText, t } from './i18n';
import { useEffect, useRef, useState } from 'react';
import { api, type AgentBundleInfo, type Host } from './api';
import { Icon } from './icons';
import { NodeFreshness } from './NodeHealth';
import { useAdminDialog } from './useAdminDialog';
import './AgentOnboardingDialog.css';

const errorText = (cause: unknown) => cause instanceof Error ? cause.message : t('ui.8f9c4884b8f9');

function downloadConfiguration(content: string): void {
  downloadFile('.env.agent', content, { type: 'text/plain;charset=utf-8', revokeAfterMs: 1000 });
}

export function AgentOnboardingDialog({ existingHostId, onClose, onChanged }: { existingHostId?: string; onClose: () => void; onChanged: () => void }) {
  const [bundle, setBundle] = useState<AgentBundleInfo | null>(null);
  const [bundleError, setBundleError] = useState('');
  const farmUrl = window.location.origin;
  const downloadUrl = new URL('/api/downloads/agent', farmUrl).href;
  const [registeredId, setRegisteredId] = useState(existingHostId ?? '');
  const [token, setToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [saved, setSaved] = useState(false);
  const [closeConfirm, setCloseConfirm] = useState(false);
  const [connectedHost, setConnectedHost] = useState<Host | null>(null);
  const [pollError, setPollError] = useState('');
  const [checkedAt, setCheckedAt] = useState<Date | null>(null);
  const configRef = useRef<HTMLDivElement>(null);
  const changedRef = useRef(onChanged);
  changedRef.current = onChanged;
  const requestClose = () => {
    if (token && !saved) setCloseConfirm(true);
    else onClose();
  };
  const dialogRef = useAdminDialog(true, busy, requestClose);

  useEffect(() => {
    let active = true;
    void api.agentBundleInfo().then(result => { if (active) setBundle(result); })
      .catch(cause => { if (active) setBundleError(errorText(cause)); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!registeredId) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const check = async () => {
      try {
        const hosts = await api.hosts();
        if (!active) return;
        const host = hosts.find(item => item.id === registeredId) ?? null;
        setConnectedHost(host);
        setCheckedAt(new Date());
        setPollError('');
        if (host?.status === 'online') { changedRef.current(); return; }
      } catch (cause) {
        if (active) setPollError(errorText(cause));
      }
      if (active) timer = setTimeout(() => void check(), 5000);
    };
    void check();
    return () => { active = false; clearTimeout(timer); };
  }, [registeredId]);

  useEffect(() => {
    if (token) configRef.current?.scrollIntoView({ block: 'start' });
  }, [token]);

  useEffect(() => {
    if (!token || saved) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [token, saved]);

  const register = async () => {
    if (busy || registeredId) return;
    setBusy(true); setError('');
    try {
      const result = await api.createAgent();
      setToken(result.token);
      setRegisteredId(result.agent.hostId);
      changedRef.current();
    } catch (cause) { setError(errorText(cause)); }
    finally { setBusy(false); }
  };

  const configuration = [
    `AGENT_SERVER_URL=${farmUrl}`,
    `AGENT_TOKEN=${token ?? t('ui.7ea2e0c4db73')}`,
    ...(existingHostId ? [`AGENT_ID=${existingHostId}`] : []),
    'AGENT_SLOTS=1',
    '',
  ].join('\n');
  const copyDownloadLink = async () => {
    try { await navigator.clipboard.writeText(downloadUrl); setNotice(t('agentSetup.linkCopied')); }
    catch { setError(t('ui.3d4b33c438ab')); }
  };
  const copyToken = async () => {
    if (!token) return;
    try { await navigator.clipboard.writeText(token); setSaved(true); setNotice(t('ui.73a5a11de427')); }
    catch { setError(t('ui.3d4b33c438ab')); }
  };
  const filename = bundle && /^[A-Za-z0-9._-]+$/.test(bundle.filename) ? bundle.filename : 'rdf-linux-agent.tar.gz';

  return <div className="modal-backdrop agent-onboarding-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !busy) requestClose(); }}>
    <div className="modal agent-onboarding-dialog" ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="connect-node-title">
      <header className="agent-onboarding-header"><div><h2 id="connect-node-title">{existingHostId ? t('ui.d900c7fdaa1d', { p0: existingHostId }) : t('ui.6e43edf6aded')}</h2><p>{t('agentSetup.intro')}</p></div><button className="icon-button" type="button" aria-label={t('ui.a7a4033657e8')} disabled={busy} onClick={requestClose}><Icon name="close" size={20} /></button></header>
      <div className="agent-onboarding-body">
        <section className="agent-setup-step"><h3><span>1</span>{t('ui.ac2e9146dc33')}</h3><p>{t('ui.1eaa0da833ae')}</p>
          {bundle ? <><div className="agent-package-row"><a className="button outline" href="/api/downloads/agent" download={bundle.filename}><Icon name="download" size={17} />{t('ui.5287a2c242f7')}</a><button className="button outline" type="button" onClick={() => void copyDownloadLink()}><Icon name="copy" size={17}/>{t('agentSetup.copyLink')}</button><span><TranslatedText message="copy.AgentOnboardingDialog.6481ab8d" values={{ p0: bundle.version, p1: Math.ceil(bundle.sizeBytes / 1024).toLocaleString(getLocale()) }} /></span></div><p>{t('agentSetup.publicPackage')}</p><details className="agent-package-checksum"><summary>{t('ui.a143d93b062c')}</summary><code>{bundle.sha256}</code></details></> : <p role={bundleError ? 'alert' : undefined}>{bundleError || t('ui.44fb23157ebe')}</p>}
        </section>
        <section className="agent-setup-step"><h3><span>2</span>{registeredId ? t('ui.5924329463a3') : t('agentSetup.accessTitle')}</h3>
          <p>{t('agentSetup.accessHint')}</p>
          <div className="agent-server-address"><span>{t('agentSetup.serverAddress')}</span><code>{farmUrl}</code></div>
          {!registeredId && <button className="button primary" type="button" disabled={busy} onClick={() => void register()}>{busy ? t('ui.c2f23e83210c') : t('ui.35b68fbee053')}<Icon name="arrowRight" size={16}/></button>}
          {registeredId && <div className="agent-config-result" ref={configRef}>
            <p>{token ? t('agentSetup.configHint') : t('ui.2224a1de021b')}</p>
            <pre aria-label={t('ui.a0a2c790b24c')}>{configuration.replace(token || t('ui.7ea2e0c4db73'), token ? t('ui.cc23fba60154') : t('ui.7ea2e0c4db73'))}</pre>
            {token && <div className="agent-config-actions"><button className="button primary" type="button" onClick={() => { downloadConfiguration(configuration); setSaved(true); setNotice(t('ui.eb417f71e767')); }}><Icon name="download" size={17} />{t('ui.13517ae912b5')}</button><button className="button outline" type="button" onClick={() => void copyToken()}><Icon name="copy" size={17} />{t('ui.fd084afb592e')}</button></div>}
          </div>}
        </section>
        {registeredId && <>
          <section className="agent-setup-step"><h3><span>3</span>{t('ui.732a6e12799e')}</h3><p>{t('ui.9819b24de7f9')}</p><pre>{examples.agentStart.replace('{filename}', filename)}</pre><p className="agent-setup-hint"><TranslatedText message="copy.AgentOnboardingDialog.b39ee5c5" values={{ p0: <code>{t('ui.2039ffd06dcf')}</code>, p1: <code>{t('ui.3bb171ff5c36')}</code> }} /></p></section>
          <section className={'agent-setup-step agent-connection-check' + (connectedHost?.status === 'online' ? ' connected' : '')} aria-live="polite"><h3><span>{connectedHost?.status === 'online' ? <Icon name="check" size={16} /> : '4'}</span>{connectedHost?.status === 'online' ? t('ui.04bfaff4f65e') : t('ui.e3c586aac759')}</h3>
            {connectedHost?.status === 'online' ? <><p>{connectedHost.name}{connectedHost.hostIp && ` · ${connectedHost.hostIp}`}</p><NodeFreshness lastSeenAt={connectedHost.lastSeenAt} /><a className="button outline" href={`#/admin/nodes?host=${encodeURIComponent(registeredId)}`} onClick={onClose}>{t('ui.d72a02dc6d33')}<Icon name="arrowRight" size={16} /></a></> : <><p><TranslatedText message="copy.AgentOnboardingDialog.f8ef48e6" values={{ p0: checkedAt && t('ui.5ed55195fce3', { p0: checkedAt.toLocaleTimeString(getLocale()) }) }} /></p>{pollError && <div className="inline-error" role="alert"><TranslatedText message="copy.AgentOnboardingDialog.458f511e" values={{ p0: localizeText(pollError) }} /></div>}<details className="agent-troubleshooting"><summary>{t('ui.d2dd10875e9e')}</summary><p>{t('ui.174fa0eb8eb4')}</p><pre>{t('ui.28c3124df71e')}</pre></details></>}
          </section>
        </>}
        {error && <div className="inline-error" role="alert">{localizeText(error)}</div>}
        {notice && <p className="agent-onboarding-notice" role="status"><Icon name="check" size={16} />{localizeText(notice)}</p>}
      </div>
      <footer className="agent-onboarding-footer">{closeConfirm ? <div className="agent-close-confirm" role="alert"><span>{t('ui.1cc0a498a45e')}</span><button className="button outline" type="button" onClick={() => setCloseConfirm(false)}>{t('ui.6c99e7d8fbd8')}</button><button className="button danger" type="button" onClick={onClose}>{t('ui.74f4e22caf07')}</button></div> : <>{registeredId && <small>{t('ui.b4e15f68ae8f')}</small>}<button className="button outline" type="button" disabled={busy} onClick={requestClose}>{t('ui.a7a4033657e8')}</button></>}</footer>
    </div>
  </div>;
}
