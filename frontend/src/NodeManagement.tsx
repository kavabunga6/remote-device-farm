import { useAccess } from './permissions';
import { getLocale, localizeText, t } from './i18n';
import { useEffect, useState, type FormEvent } from 'react';
import { api, type AgentCredential, type Host, type NodeOccupant, type NodeSettingsInput, type Profile } from './api';
import { Icon } from './icons';
import { useAdminDialog } from './useAdminDialog';
import './NodeManagement.css';
import './AdminAgents.css';
import { NodeDiagnostics, NodeFreshness } from './NodeHealth';
import { previewNodeCapacity, profilesExceedingSlot } from './node-capacity';
import { HostCard } from './HostCard';
import { AgentOnboardingDialog } from './AgentOnboardingDialog';
import { HeadingSlot } from './HeadingSlot';
import { hostSupportsGpu } from './launch-readiness';
import { slotOccupancyLevel } from './host-availability';
import './slot-occupancy.css';

const errorText = (error: unknown) => error instanceof Error ? error.message : t('ui.8f9c4884b8f9');
function NodeDialog({ host, profiles, onClose, onRefresh }: { host: Host; profiles: Profile[]; onClose: () => void; onRefresh: () => void }) {
  const can = useAccess();
  const [form, setForm] = useState<Omit<NodeSettingsInput, 'disabled'>>({
    displayName: host.displayName, slotMode: host.slotMode, manualSlots: host.manualSlots,
    slotCpu: host.slotCpu, slotMemoryMb: host.slotMemoryMb,
  });
  const [disabled, setDisabled] = useState(host.disabled);
  const [credential, setCredential] = useState<AgentCredential | null>(null);
  const [revokeAsk, setRevokeAsk] = useState(false);
  useEffect(() => { if (!can('nodes.credentials')) return; let alive = true; api.agents().then(list => { if (alive) setCredential(list.find(item => item.hostId === host.id) ?? null); }).catch(() => {}); return () => { alive = false; }; }, [host.id]);
  const revokeToken = async () => {
    setOperation('availability'); setError(''); setNotice('');
    try { await api.revokeAgent(host.id); setCredential(null); setRevokeAsk(false); setNotice(t('ui.b6f32b19e1d4')); onRefresh(); }
    catch (cause) { setError(errorText(cause)); }
    finally { setOperation(null); }
  };
  const [occupants, setOccupants] = useState<NodeOccupant[]>([]);
  const [occupancyError, setOccupancyError] = useState('');
  const [occupancyLoading, setOccupancyLoading] = useState(true);
  const [operation, setOperation] = useState<'settings' | 'availability' | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const busy = operation !== null;
  const dialogRef = useAdminDialog(true, busy, onClose);
  useEffect(() => setDisabled(host.disabled), [host.disabled]);
  useEffect(() => {
    let active = true;
    setOccupancyLoading(true); setOccupancyError('');
    void api.hostOccupants(host.id).then(items => { if (active) setOccupants(items); })
      .catch(cause => { if (active) setOccupancyError(errorText(cause)); })
      .finally(() => { if (active) setOccupancyLoading(false); });
    return () => { active = false; };
  }, [host.id, host.activeSessions]);
  const set = <K extends keyof typeof form>(key: K, value: typeof form[K]) =>
    setForm(previous => ({ ...previous, [key]: value }));
  const save = async (event: FormEvent) => {
    event.preventDefault(); if (busy) return;
    setOperation('settings'); setError(''); setNotice('');
    try {
      const result = await api.updateHostSettings(host.id, { ...form, displayName: form.displayName?.trim() || null });
      setNotice(result.policyError || t('ui.463fb930fe0b'));
      onRefresh();
    } catch (cause) { setError(errorText(cause)); }
    finally { setOperation(null); }
  };
  const toggleAvailability = async () => {
    if (busy) return;
    setOperation('availability'); setError(''); setNotice('');
    try {
      const result = await api.updateHostSettings(host.id, { disabled: !disabled });
      setDisabled(result.host.disabled);
      setNotice(result.policyError || (result.host.disabled ? t('ui.8ccb85717747') : t('ui.43548cdee404')));
      onRefresh();
    } catch (cause) { setError(errorText(cause)); }
    finally { setOperation(null); }
  };
  const active = Math.max(host.activeSessions, occupants.length);
  const capacity = previewNodeCapacity(host, { ...form, disabled });
  const incompatible = profilesExceedingSlot(profiles, form.slotCpu, form.slotMemoryMb);
  const stateLabels = { starting: t('ui.a207dbeaf97a'), running: t('ui.0232a305412b'), stopping: t('ui.75adfadd9b91'), stopped: t('ui.d0dd0cfdf601'), error: t('ui.bf22dfeeba8b') };
  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <div ref={dialogRef} tabIndex={-1} className="modal node-dialog" role="dialog" aria-modal="true" aria-labelledby="node-dialog-title">
      <header className="modal-top node-dialog-header">
        <div>
          <h2 id="node-dialog-title">{host.name}</h2>
          <p className="node-dialog-subtitle"><span>{t('ui.bd8ca542a9bc')}</span><span aria-hidden="true">·</span><span>{host.hostIp || t('ui.d5c7cab0b14d')}</span><code>{host.id}</code></p>
        </div>
        <button type="button" className="icon-button" onClick={onClose} aria-label={t('ui.a7a4033657e8')} disabled={busy}><Icon name="close" size={19} /></button>
      </header>
      <div className="node-dialog-body">
        <div className="node-dialog-layout">
          <form id="node-settings-form" className="node-dialog-form" onSubmit={event => void save(event)}>
            <div className="node-name-field">
              <label className="node-field" htmlFor="node-display-name"><span>{t('ui.9174a54d0bfb')}</span>
                <input id="node-display-name" aria-describedby="node-name-hint" value={form.displayName ?? ''} onChange={event => set('displayName', event.target.value)} placeholder={host.agentName} maxLength={120} disabled={busy} />
              </label>
              <p id="node-name-hint" className="node-field-note">{t('ui.1f0939baf917')}</p>
            </div>
            <section className="node-settings-section" aria-labelledby="node-slots-title">
              <div className="node-section-heading"><h3 id="node-slots-title">{t('ui.ce0106333bfa')}</h3><p>{t('ui.8f66283db52d')}</p></div>
              <div className="node-slot-mode" role="group" aria-label={t('ui.78df45cee088')}>
                <label className={form.slotMode === 'manual' ? 'selected' : ''}>
                  <input type="radio" name="slotMode" checked={form.slotMode === 'manual'} onChange={() => set('slotMode', 'manual')} disabled={busy} />
                  <span><strong>{t('ui.3e17d77fcc6d')}</strong><small>{t('ui.165e38e377e3')}</small></span>
                </label>
                <label className={form.slotMode === 'dynamic' ? 'selected' : ''}>
                  <input type="radio" name="slotMode" checked={form.slotMode === 'dynamic'} onChange={() => set('slotMode', 'dynamic')} disabled={!host.policySupported || busy} />
                  <span><strong>{t('ui.353cf589e95b')}</strong><small>{host.policySupported ? t('ui.9a0e888cf6ed') : t('ui.3306b4a11546')}</small></span>
                </label>
              </div>
              {form.slotMode === 'manual' && <div className="node-manual-slots">
                <label className="node-field" htmlFor="node-manual-slots"><span>{t('ui.0afb107fad6c')}</span><input id="node-manual-slots" type="number" min={0} max={32} value={form.manualSlots} onChange={event => set('manualSlots', Number(event.target.value))} required disabled={busy} /></label>
                <p className="node-field-note">{t('ui.b96f119888f0')}</p>
              </div>}
            </section>
            <section className="node-settings-section" aria-labelledby="node-resources-title">
              <div className="node-section-heading"><h3 id="node-resources-title">{t('ui.cb0911aadd37')}</h3></div>
              <div className="node-limit-grid">
                <label className="node-field" htmlFor="node-slot-cpu"><span>{t('ui.4a0adb625a69')}</span><input id="node-slot-cpu" type="number" min={1} max={16} value={form.slotCpu} onChange={event => set('slotCpu', Number(event.target.value))} required disabled={busy} /></label>
                <label className="node-field" htmlFor="node-slot-memory"><span>{t('ui.0560101c6a19')}</span><input id="node-slot-memory" type="number" min={1024} max={65536} step={256} value={form.slotMemoryMb} onChange={event => set('slotMemoryMb', Number(event.target.value))} required disabled={busy} /></label>
              </div>
              {!!incompatible.length ? <details className="node-profile-fit">
                <summary>{t('ui.ff216ade8ff3')}{incompatible.length}</summary>
                <ul>{incompatible.map(({ profile, reasons }) => <li key={profile.id}><span>{profile.name}</span><small>{reasons.join(' · ')}</small></li>)}</ul>
              </details> : capacity && profiles.length > 0 && <p className="node-field-note node-profile-compatible"><Icon name="check" size={15} />{t('ui.8658603e0a79')}</p>}
            </section>
            <section className="node-capacity-preview" aria-label={t('ui.3f5a228d7f39')}>
              <div className="node-capacity-result" aria-live="polite">
                <h3>{t('ui.60320b58a2f1')}</h3>
                {capacity ? <>
                  <dl className="node-capacity-stats"><div><dt>{t('ui.b2daabc8bfe9')}</dt><dd>{capacity.slots}</dd></div><div><dt>{t('ui.2fdd1b255ecf')}</dt><dd>{capacity.free}</dd></div><div><dt>{t('ui.c4b638cf68ad')}</dt><dd>{active}</dd></div></dl>
                  {capacity.disabled ? <p>{t('ui.48e636cbd905')}{capacity.capacity}.</p> : host.status !== 'online' ? <p>{t('ui.3a3dc00b7274')}</p> : null}
                </> : <p>{t('ui.7ee78b3580de')}</p>}
              </div>
              {capacity?.dynamic && <details className="node-capacity-details">
                <summary>{t('ui.98b4eedc5eb2')}</summary>
                <p>{t('ui.a7418a533422')}{capacity.limit.join(', ')}.</p>
                <dl><div><dt>{t('ui.64de5bc5d912')}</dt><dd>{capacity.cpuBudget} {t('ui.0afb1c2a3da3')}{capacity.cpuSlots} {t('ui.46d980c9a8d0')}</dd></div><div><dt>{t('ui.be4c791fb09c')}</dt><dd>{(capacity.memoryBudgetMb / 1024).toLocaleString(getLocale(), { maximumFractionDigits: 2 })} {t('ui.35b00143d254')}{capacity.memorySlots} {t('ui.46d980c9a8d0')}</dd></div></dl>
              </details>}
              {capacity && !host.policySupported && <p className="node-field-note">{t('ui.f16ca1aad770')}{Math.min(host.reportedSlots, host.slotCap ?? host.reportedSlots)} {t('ui.49b6715c0129')}</p>}
            </section>
            {!host.policySupported && <div className="inline-warning">{t('ui.c52da62f79fd')}</div>}
            {host.policyPending && <div className="inline-warning">{t('ui.cdb80d7563b3')}</div>}
          </form>
          <aside className="node-dialog-side" aria-label={t('ui.cc55d1a1c3d8')}>
            <section className="node-availability">
              <div className="node-side-heading"><h3>{t('ui.5ffafe1ca535')}</h3><span className={'node-state ' + (disabled ? 'off' : host.status === 'online' ? 'online' : 'offline')}>{disabled ? t('ui.a3fbed94428e') : host.status === 'online' ? t('ui.dabf46d05e58') : t('ui.624ac1030b6e')}</span></div>
              <NodeFreshness lastSeenAt={host.lastSeenAt} />
              <strong>{disabled ? t('ui.882cfa197c1a') : host.status === 'online' ? t('ui.03fa921fb628') : t('ui.3cb13b63ae6e')}</strong>
              <p>{disabled ? t('ui.67234a94be0a') : t('ui.eae22ceba9f8')}</p>
              <button type="button" className={'button ' + (disabled ? 'primary' : 'outline')} onClick={() => void toggleAvailability()} disabled={busy}><Icon name={disabled ? 'play' : 'pause'} size={17} />{operation === 'availability' ? t('ui.b001f5d8019b') : disabled ? t('ui.522b4d723dfd') : t('ui.55afd02c0436')}</button>
              <p className="node-action-note">{t('ui.67a8e140bc84')}</p>
            </section>
            <section className="node-occupancy">
              <div className="node-side-heading"><h3>{t('ui.80384178a7df')}</h3><span className="count-pill">{active}</span></div>
              {occupancyError && <p className="inline-error" role="alert">{localizeText(occupancyError)}</p>}
              {occupancyLoading ? <p>{t('ui.f416ed081b69')}</p> : occupants.length ? <ul>{occupants.map(item => <li className="interactive-card" key={item.slotIndex}>
                <span>#{item.slotIndex + 1}</span><div><strong><a className="card-primary-action" href={'#/session/' + encodeURIComponent(item.sessionId)} aria-label={t('ui.442b925f50d7') + item.profileName} onClick={event => { if (!event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey) onClose(); }}>{item.profileName}</a></strong><small>{item.ownerName} · {stateLabels[item.state]}</small></div>
              </li>)}</ul> : !occupancyError && <p>{active > 0 ? t('ui.254edcbcdd2a') : t('ui.4d0a2d856df5')}</p>}
            </section>
            <NodeDiagnostics host={host} />
            {credential && credential.source !== 'environment' && credential.canRevoke !== false && <section className="node-token">
              <details><summary>{t('ui.ea7ba3379efe')}</summary><div className="node-token-body">
                <p>{t('ui.a17072a9f4da')}{new Date(credential.createdAt).toLocaleDateString(getLocale())}{t('ui.2e3915e0f29a')}</p>
                {can('nodes.credentials') && (revokeAsk ? <div className="token-confirm"><span>{t('ui.14db8088262d')}</span><button type="button" className="text-button danger-text" onClick={() => void revokeToken()} disabled={busy}>{t('ui.bc744ce9e1a8')}</button><button type="button" className="text-button" onClick={() => setRevokeAsk(false)} disabled={busy}>{t('ui.8fbe9b75cbdf')}</button></div> : <button type="button" className="text-button danger-text" onClick={() => setRevokeAsk(true)} disabled={busy}>{t('ui.c723810d8222')}</button>)}
              </div></details>
            </section>}
            {credential?.source === 'environment' && <p className="node-token-note">{t('ui.c3b5617b0bb6')}</p>}
          </aside>
        </div>
      </div>
      <footer className="node-dialog-footer">
        {error && <div className="inline-error node-dialog-feedback" role="alert">{localizeText(error)}</div>}{notice && <div className="node-notice node-dialog-feedback" role="status">{localizeText(notice)}</div>}
        <div className="node-dialog-footer-row"><p>{t('ui.e917b5455771')}</p><div className="modal-actions node-dialog-actions">
          <button type="button" className="button outline" onClick={onClose} disabled={busy}>{t('ui.a7a4033657e8')}</button>
          <button form="node-settings-form" className="button primary" type="submit" disabled={busy}>{operation === 'settings' ? t('ui.9c27c381dd8b') : t('ui.d3257f0c9ba3')}</button>
        </div></div>
      </footer>
    </div>
  </div>;
}


function NodePoolSummary({ hosts }: { hosts: Host[] }) {
  const online = hosts.filter(host => host.status === 'online' && !host.disabled);
  const disabled = hosts.filter(host => host.disabled).length;
  const totalSlots = online.reduce((sum, host) => sum + host.maxSessions, 0);
  const busySlots = online.reduce((sum, host) => sum + Math.min(host.activeSessions, host.maxSessions), 0);
  const cuda = online.filter(host => hostSupportsGpu(host, 'cuda')).length;
  const plain = online.filter(host => hostSupportsGpu(host, 'gpu')).length;
  return <div className="node-pool-summary" aria-label={t('ui.5e90eda56e75')}>
    <div className="node-pool-card"><span className="cap">{t('ui.5e90eda56e75')}</span><strong>{online.length} {t('ui.803a0dc0c70d')}</strong><small>{disabled} {t('ui.eef3a9f50e41')}{hosts.length} {t('ui.7df1979c2188')}</small></div>
    <div className="node-pool-card slot-occupancy" data-occupancy={slotOccupancyLevel(busySlots, totalSlots)}><span className="cap">{t('ui.43ad61e9ff10')}</span><strong>{totalSlots - busySlots} / {totalSlots}</strong><small>{totalSlots ? Math.round((totalSlots - busySlots) / totalSlots * 100) + t('ui.d041472ab23e') : t('ui.563932f8be14')}</small></div>
    <div className="node-pool-card"><span className="cap">{t('ui.ea49523d744c')}</span><strong className={cuda + plain ? 'accent' : ''}>{cuda ? 'CUDA' : plain ? 'GPU' : t('ui.43e5ab70f691')}</strong><small>{cuda || plain ? [cuda ? t('ui.cd8a16c2ff42') + cuda : '', plain ? t('ui.eff26e0f2f4c') + plain : ''].filter(Boolean).join(' · ') : t('ui.efe166566939')}</small></div>
  </div>;
}

const selectedHostFromHash = () => {
  const [path, query] = window.location.hash.split('?');
  return path === '#/admin/nodes' ? new URLSearchParams(query).get('host') : null;
};

export function NodeManagement({ hosts, profiles = [], onRefresh }: { hosts: Host[]; profiles?: Profile[]; onRefresh: () => void }) {
  const can = useAccess();
  const [selectedId, setSelectedId] = useState<string | null>(selectedHostFromHash);
  useEffect(() => { const update = () => setSelectedId(selectedHostFromHash()); window.addEventListener('hashchange', update); return () => window.removeEventListener('hashchange', update); }, []);
  const closeNode = () => {
    setSelectedId(null);
    if (selectedHostFromHash()) { window.history.replaceState(null, '', '#/admin/nodes'); window.dispatchEvent(new HashChangeEvent('hashchange')); }
  };
  const [connectOpen, setConnectOpen] = useState(() => new URLSearchParams(window.location.hash.split('?')[1] ?? '').get('connect') === '1');
  const [nodeQuery, setNodeQuery] = useState('');
  const nodeNeedle = nodeQuery.trim().toLowerCase();
  const visibleHosts = nodeNeedle ? hosts.filter(host => [host.name, host.displayName, host.agentName, host.hostIp, host.id].some(value => (value ?? '').toLowerCase().includes(nodeNeedle))) : hosts;
  const selected = hosts.find(host => host.id === selectedId);
  return <section id="adm-nodes" className="content-section admin-tools"><div className="section-heading"><div><h2>{t('ui.f3a46c2f2b5c')}</h2><p>{t('ui.ba757a7d2c9d')}</p></div><HeadingSlot slot="actions">{can('nodes.credentials') && <button className="button primary small" type="button" onClick={() => setConnectOpen(true)}><Icon name="plus" size={16} />{t('ui.6e43edf6aded')}</button>}</HeadingSlot></div>
    {hosts.length > 0 && <NodePoolSummary hosts={hosts} />}
    {hosts.length > 1 && <div className="admin-filter-bar"><label className="admin-search"><Icon name="search" size={18} /><input aria-label={t('ui.f211301b5e9a')} value={nodeQuery} onChange={event => setNodeQuery(event.target.value)} placeholder={t('ui.621fad681f19')} /></label>{nodeNeedle && <button type="button" className="button outline small" onClick={() => setNodeQuery('')}>{t('ui.407f871778d3')}</button>}</div>}
    {hosts.length && !visibleHosts.length ? <p className="agent-empty">{t('ui.1766b97ee90b')}</p> : null}
    {hosts.length ? <div className="node-overview-grid">{visibleHosts.map(host =>
      <HostCard key={host.id} host={host} canManage={can('nodes.manage')} className="node-overview" />
    )}</div> : <p className="agent-empty">{t('ui.6bfe8c2f019e')}</p>}


    {can('nodes.manage') && selected && <NodeDialog key={selected.id} host={selected} profiles={profiles} onClose={closeNode} onRefresh={onRefresh} />}
    {selectedId && !selected && <p className="inline-warning">{t('ui.c8092b965a4c')}{selectedId} {t('ui.06e86425ae4c')}</p>}
  {connectOpen && <AgentOnboardingDialog onClose={() => setConnectOpen(false)} onChanged={onRefresh} />}</section>;
}