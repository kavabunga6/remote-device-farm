import { getLocale, localizeText, t } from './i18n';
import { useEffect, useRef, useState } from 'react';
import { api, type AgentBundleInfo, type Host } from './api';
import { Icon } from './icons';
import { NodeFreshness } from './NodeHealth';
import { useAdminDialog } from './useAdminDialog';
import './AgentOnboardingDialog.css';

const safeHostId = /^[A-Za-z0-9_-]{1,64}$/;
const errorText = (cause: unknown) => cause instanceof Error ? cause.message : t('ui.8f9c4884b8f9');

function initialFarmUrl(): string {
  const url = new URL(window.location.href);
  return ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ? '' : url.origin;
}

function brokerAddress(value: string): string | null {
  try {
    const url = new URL(value.trim());
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') return null;
    if (['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return null;
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.pathname = '/agent/connect';
    return url.href;
  } catch { return null; }
}

function validHostIp(value: string): boolean {
  if (!value) return true;
  const ipv4 = (address: string) => {
    const octets = address.split('.');
    return octets.length === 4 && octets.every(octet => /^(0|[1-9][0-9]{0,2})$/.test(octet) && Number(octet) <= 255);
  };
  if (!value.includes(':')) return ipv4(value);
  const [address, zone, ...extra] = value.split('%');
  if (extra.length || (zone !== undefined && !/^[A-Za-z0-9.:-]+$/.test(zone))) return false;
  const halves = address.split('::');
  if (halves.length > 2) return false;
  const groups = halves.flatMap(half => half ? half.split(':') : []);
  let units = 0;
  for (const [index, group] of groups.entries()) {
    if (/^[0-9a-f]{1,4}$/i.test(group)) units++;
    else if (index === groups.length - 1 && address.endsWith(group) && ipv4(group)) units += 2;
    else return false;
  }
  return halves.length === 2 ? units < 8 : units === 8;
}

function downloadConfiguration(content: string): void {
  const url = URL.createObjectURL(new Blob([content], { type: 'text/plain;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = '.env.agent';
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function AgentOnboardingDialog({ existingHostId, onClose, onChanged }: { existingHostId?: string; onClose: () => void; onChanged: () => void }) {
  const [bundle, setBundle] = useState<AgentBundleInfo | null>(null);
  const [bundleError, setBundleError] = useState('');
  const [hostId, setHostId] = useState(existingHostId ?? '');
  const [farmUrl, setFarmUrl] = useState(initialFarmUrl);
  const [hostIp, setHostIp] = useState('');
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
  const broker = brokerAddress(farmUrl);
  const validIp = validHostIp(hostIp);
  const canCreate = safeHostId.test(hostId.trim()) && broker && validIp;

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

  const register = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!canCreate || busy || registeredId) return;
    setBusy(true); setError('');
    try {
      const existing = await api.agents();
      if (existing.some(agent => agent.hostId === hostId.trim())) throw new Error(t('ui.3bb4574513d5'));
      const result = await api.createAgent(hostId.trim());
      setToken(result.token);
      setRegisteredId(result.agent.hostId);
      changedRef.current();
    } catch (cause) { setError(errorText(cause)); }
    finally { setBusy(false); }
  };

  const configuration = [
    `AGENT_ID=${registeredId || hostId.trim()}`,
    `AGENT_NAME=${registeredId || hostId.trim()}`,
    `AGENT_TOKEN=${token ?? t('ui.7ea2e0c4db73')}`,
    `AGENT_BROKER_URL=${broker ?? t('ui.264fe88fbae3')}`,
    'AGENT_SLOTS=1',
    `AGENT_HOST_IP=${hostIp}`,
    '',
  ].join('\n');
  const copyToken = async () => {
    if (!token) return;
    try { await navigator.clipboard.writeText(token); setSaved(true); setNotice(t('ui.73a5a11de427')); }
    catch { setError(t('ui.3d4b33c438ab')); }
  };
  const filename = bundle && /^[A-Za-z0-9._-]+$/.test(bundle.filename) ? bundle.filename : 'rdf-linux-agent.tar.gz';

  return <div className="modal-backdrop agent-onboarding-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !busy) requestClose(); }}>
    <div className="modal agent-onboarding-dialog" ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="connect-node-title">
      <header className="agent-onboarding-header"><div><span className="eyebrow">{t('ui.ab45e28f5493')}</span><h2 id="connect-node-title">{existingHostId ? t('ui.d900c7fdaa1d', { p0: existingHostId }) : t('ui.6e43edf6aded')}</h2><p>{t('ui.e3a90249fc2e')}</p></div><button className="icon-button" type="button" aria-label={t('ui.a7a4033657e8')} disabled={busy} onClick={requestClose}><Icon name="close" size={20} /></button></header>
      <div className="agent-onboarding-body">
        <section className="agent-setup-step"><h3><span>1</span>{t('ui.ac2e9146dc33')}</h3><p>{t('ui.1eaa0da833ae')}</p>
          {bundle ? <><div className="agent-package-row"><a className="button outline" href="/api/admin/agent-bundle" download={bundle.filename}><Icon name="download" size={17} />{t('ui.5287a2c242f7')}</a><span>{t('ui.83c21cec4c45')}{bundle.version} · {Math.ceil(bundle.sizeBytes / 1024).toLocaleString(getLocale())} {t('ui.69a96a534531')}</span></div><details className="agent-package-checksum"><summary>{t('ui.a143d93b062c')}</summary><code>{bundle.sha256}</code></details></> : <p role={bundleError ? 'alert' : undefined}>{bundleError || t('ui.44fb23157ebe')}</p>}
        </section>
        <section className="agent-setup-step"><h3><span>2</span>{registeredId ? t('ui.5924329463a3') : t('ui.68035745711a')}</h3>
          <form className="agent-enrollment-form" onSubmit={event => void register(event)}>
            <label>{t('ui.6145a142f4d3')}<input value={hostId} onChange={event => setHostId(event.target.value)} disabled={!!registeredId || busy} maxLength={64} pattern="[A-Za-z0-9_-]{1,64}" placeholder={t('ui.cb4b425ed607')} required /><small>{t('ui.dfec3cce4ffe')}</small></label>
            <label><span>{t('ui.16ea4cfb24d8')}<span className="agent-optional">{t('ui.6b2bc9867c4a')}</span></span><input value={hostIp} onChange={event => { setHostIp(event.target.value.trim()); setSaved(false); }} disabled={busy} placeholder={t('ui.6c49454dcdd6')} maxLength={253} /><small>{t('ui.a2459bcd5004')}</small></label>
            <label className="agent-field-wide">{t('ui.7d893b2c819e')}<input type="url" value={farmUrl} onChange={event => { setFarmUrl(event.target.value); setSaved(false); }} disabled={busy} placeholder={t('ui.b490e21d112e')} required /><small>{broker ? t('ui.b6bed3184d10', { p0: broker }) : t('ui.1b8ec97cc903')}</small></label>
            {!validIp && <p className="inline-error agent-field-wide" role="alert">{t('ui.de4399dd3df7')}</p>}
            {!registeredId && <button className="button primary agent-field-wide" type="submit" disabled={!canCreate || busy}>{busy ? t('ui.c2f23e83210c') : t('ui.35b68fbee053')}<Icon name="arrowRight" size={16} /></button>}
          </form>
          {registeredId && <div className="agent-config-result" ref={configRef}>
            <p>{token ? t('ui.6e4857333960') : t('ui.2224a1de021b')}</p>
            <pre aria-label={t('ui.a0a2c790b24c')}>{configuration.replace(token || t('ui.7ea2e0c4db73'), token ? t('ui.cc23fba60154') : t('ui.7ea2e0c4db73'))}</pre>
            {token && <div className="agent-config-actions"><button className="button primary" type="button" disabled={!broker || !validIp} onClick={() => { downloadConfiguration(configuration); setSaved(true); setNotice(t('ui.eb417f71e767')); }}><Icon name="download" size={17} />{t('ui.13517ae912b5')}</button><button className="button outline" type="button" onClick={() => void copyToken()}><Icon name="copy" size={17} />{t('ui.fd084afb592e')}</button></div>}
          </div>}
        </section>
        {registeredId && <>
          <section className="agent-setup-step"><h3><span>3</span>{t('ui.732a6e12799e')}</h3><p>{t('ui.9819b24de7f9')}</p><pre>{`tar -xzf ${filename}\nchmod 600 .env.agent\ndocker compose --env-file .env.agent -f compose.agent.yaml up --build -d`}</pre><p className="agent-setup-hint">{t('ui.4b8081c4a9a8')}<code>{t('ui.2039ffd06dcf')}</code>{t('ui.84d145f594aa')}<code>{t('ui.3bb171ff5c36')}</code>.</p></section>
          <section className={'agent-setup-step agent-connection-check' + (connectedHost?.status === 'online' ? ' connected' : '')} aria-live="polite"><h3><span>{connectedHost?.status === 'online' ? <Icon name="check" size={16} /> : '4'}</span>{connectedHost?.status === 'online' ? t('ui.04bfaff4f65e') : t('ui.e3c586aac759')}</h3>
            {connectedHost?.status === 'online' ? <><p>{connectedHost.name}{connectedHost.hostIp && ` · ${connectedHost.hostIp}`}</p><NodeFreshness lastSeenAt={connectedHost.lastSeenAt} /><a className="button outline" href={`#/admin/nodes?host=${encodeURIComponent(registeredId)}`} onClick={onClose}>{t('ui.d72a02dc6d33')}<Icon name="arrowRight" size={16} /></a></> : <><p>{t('ui.2af138ed1ae1')}{checkedAt && t('ui.5ed55195fce3', { p0: checkedAt.toLocaleTimeString(getLocale()) })}</p>{pollError && <div className="inline-error" role="alert">{t('ui.c5cad3c3f176')}{localizeText(pollError)}</div>}<details className="agent-troubleshooting"><summary>{t('ui.d2dd10875e9e')}</summary><p>{t('ui.174fa0eb8eb4')}</p><pre>{t('ui.28c3124df71e')}</pre></details></>}
          </section>
        </>}
        {error && <div className="inline-error" role="alert">{localizeText(error)}</div>}
        {notice && <p className="agent-onboarding-notice" role="status"><Icon name="check" size={16} />{localizeText(notice)}</p>}
      </div>
      <footer className="agent-onboarding-footer">{closeConfirm ? <div className="agent-close-confirm" role="alert"><span>{t('ui.1cc0a498a45e')}</span><button className="button outline" type="button" onClick={() => setCloseConfirm(false)}>{t('ui.6c99e7d8fbd8')}</button><button className="button danger" type="button" onClick={onClose}>{t('ui.74f4e22caf07')}</button></div> : <><small>{registeredId ? t('ui.b4e15f68ae8f') : t('ui.a88216233030')}</small><button className="button outline" type="button" disabled={busy} onClick={requestClose}>{t('ui.a7a4033657e8')}</button></>}</footer>
    </div>
  </div>;
}
