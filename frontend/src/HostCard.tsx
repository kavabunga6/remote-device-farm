import { getLocale, t } from './i18n';
import type { Host } from './api';
import { hostState, HOST_STATE_LABEL, slotOccupancyLevel } from './host-availability';
import { NodeFreshness, useNodeGpuState } from './NodeHealth';
import './HostCard.css';
import './slot-occupancy.css';

function formatMemory(megabytes: number | undefined): string {
  if (typeof megabytes !== 'number' || !Number.isFinite(megabytes) || megabytes <= 0) return '—';
  return new Intl.NumberFormat(getLocale(), { maximumFractionDigits: 1 }).format(megabytes / 1024) + t('ui.9fd219660ff0');
}

function percent(value: number | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100 ? Math.round(value) : null;
}

function Meter({ value, label }: { value: number; label: string }) {
  return <div className="host-meter" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={value}>
    <span style={{ width: value + '%' }}/></div>;
}

function hostEnvironment(host: Host): string {
  switch (host.environmentType) {
    case 'bare-metal': return t('ui.7d7ea6c1c1ab');
    case 'virtual-machine': return host.virtualizationType ? t('ui.186888d82a35') + host.virtualizationType : t('ui.5e71c9fa413a');
    case 'kubernetes-pod': return 'Pod Kubernetes';
    default: return t('ui.52cbb544cd1a');
  }
}

export function HostCard({ host, canManage = false, className = '', layout = 'card' }: { host: Host; canManage?: boolean; className?: string; layout?: 'card' | 'row' }) {
  const state = hostState(host);
  const stateLabel = HOST_STATE_LABEL[state];
  const slots = Math.max(0, host.maxSessions - host.activeSessions);
  const coreCount = host.cpuPhysicalCores && host.cpuPhysicalCores > 0 ? host.cpuPhysicalCores : undefined;
  const threadCount = host.cpuThreads && host.cpuThreads > 0 ? host.cpuThreads : host.cpuCores || undefined;
  const cpuTopology = coreCount && threadCount
    ? coreCount + t('ui.4dbc56cd9fbc') + threadCount + t('ui.5bbb12edd4dc')
    : threadCount ? threadCount + t('ui.2b526ea352f8') : t('ui.61115655263b');
  const availableMemory = host.availableMemoryMb ?? host.freeMemoryMb;
  const gpuName = host.gpuModel || host.gpuVendor ||
    (host.gpuPresent ? t('ui.35731beb667a') : host.gpuPresent === false ? t('ui.43687686a7cc') : t('ui.76848548e29c'));
  const gpu = useNodeGpuState(host);
  const cpuUsed = gpu.telemetryFresh ? percent(host.cpuUsagePercent) : null;
  const gpuLoads = gpu.samples.flatMap(sample => {
    const value = percent(sample.utilizationPercent);
    return value == null ? [] : [{ index: sample.index, value }];
  });
  const gpuAccess = gpu.ready ? t('ui.58f169c7db44') + gpu.modes.join(' · ') : gpu.status;
  const title = canManage ? <a className="card-primary-action" href={'#/admin/nodes?host=' + encodeURIComponent(host.id)} aria-label={t('ui.a86d83902a79') + host.name}>{host.name}</a> : host.name;
  const memoryUsed = host.memoryMb > 0 && availableMemory != null ? Math.round(Math.min(100, Math.max(0, (1 - availableMemory / host.memoryMb) * 100))) : null;
  const diskUsed = host.diskTotalGb && host.diskFreeGb != null ? Math.round(Math.min(100, Math.max(0, (1 - host.diskFreeGb / host.diskTotalGb) * 100))) : null;
  const slotChips = Array.from({ length: Math.min(host.maxSessions, 8) }, (_, index) => <span key={index} className="host-slot" data-busy={index < host.activeSessions || undefined}>{t('ui.912fcbbf9023')}{index + 1}: {index < host.activeSessions ? t('ui.3d37f280c2e3') : t('ui.4abcbdc9262b')}</span>);
  const footer = <div className="host-card-footer slot-occupancy" data-occupancy={state === 'online' ? slotOccupancyLevel(host.activeSessions, host.maxSessions) : 'unavailable'}><div className="host-capacity"><div><strong>{slots}</strong><span>{t('ui.2a87306438ca')}{host.maxSessions} {t('ui.46d980c9a8d0')}</span></div></div>{slotChips.length > 0 && <div className="host-slots" aria-label={t('ui.722dd5788da4')}>{slotChips}</div>}</div>;
  return <article className={['host-card host-status-card interactive-card', layout === 'card' ? 'host-card-compact' : '', className].filter(Boolean).join(' ')} data-state={state} aria-label={host.name + ' · ' + stateLabel} title={stateLabel}>
    <div className="host-card-heading host-status-indicator"><div className="host-card-identity"><div><h3>{title}</h3><span className="host-address">{host.hostIp || t('ui.158e01cb16d7')}</span><NodeFreshness lastSeenAt={host.lastSeenAt} /></div></div></div>
    <div className="host-environment"><span>{hostEnvironment(host)}</span>{host.agentRuntime === 'container' && host.environmentType !== 'kubernetes-pod' && <span>{t('ui.a003e711dbb2')}</span>}</div>
    <div className="host-specs">
      <div className="host-spec" data-resource="cpu"><span>{t('ui.db9a4c7d4c19')}{cpuUsed != null && <b aria-label={t('ui.c16b623ac8b7') + cpuUsed + '%'}>{cpuUsed}%</b>}</span><div><strong title={host.cpuModel}>{host.cpuModel || host.architecture || t('ui.76848548e29c')}</strong><small>{cpuTopology}</small></div><div className="host-meters">{cpuUsed != null && <Meter value={cpuUsed} label={t('ui.d2ea22920256')}/>}</div></div>
      <div className="host-spec" data-resource="memory"><span>{t('ui.397211640533')}{memoryUsed != null && <b title={t('ui.320e9251b4a6')} aria-label={t('ui.07a7d1206981') + memoryUsed + '%'}>{memoryUsed}%</b>}</span><div><strong>{formatMemory(host.memoryMb)}</strong><small>{availableMemory != null ? formatMemory(availableMemory) + t('ui.3697a3a02d05') : t('ui.8e73319d4562')}</small></div><div className="host-meters">{memoryUsed != null && <Meter value={memoryUsed} label={t('ui.320e9251b4a6')}/>}</div></div>
      <div className="host-spec" data-resource="gpu"><span>{t('ui.ea49523d744c')}{gpuLoads.length === 1 && <b aria-label={t('ui.48c67e11c97b') + gpuLoads[0].value + '%'}>{gpuLoads[0].value}%</b>}</span><div><strong title={gpuName}>{gpuName}</strong>{gpuAccess && <small className={'host-gpu-status' + (gpu.ready ? ' gpu-ready' : '')}>{gpuAccess}</small>}</div><div className="host-meters">{gpuLoads.map(sample => <div className="host-gpu-meter" key={sample.index}>{gpu.samples.length > 1 && <span>{t('ui.4bfdcdcaf180')}{sample.index}<b>{sample.value}%</b></span>}<Meter value={sample.value} label={gpu.samples.length > 1 ? t('ui.79b303de256c') + sample.index : t('ui.c3c62108cf2d')}/></div>)}</div></div>
      <div className="host-spec" data-resource="disk"><span>{t('ui.cd9bad6b5a92')}{diskUsed != null && <b title={t('ui.843bf7929e82')} aria-label={t('ui.12626578465e') + diskUsed + '%'}>{diskUsed}%</b>}</span><div><strong>{host.diskTotalGb == null ? t('ui.76848548e29c') : t('ui.38299421d537', { p0: host.diskTotalGb })}</strong><small>{host.diskFreeGb == null ? t('ui.ace019c5938b') : t('ui.78df6bb62418', { p0: host.diskFreeGb })}</small></div><div className="host-meters">{diskUsed != null && <Meter value={diskUsed} label={t('ui.843bf7929e82')}/>}</div></div>
    </div>
    {footer}
  </article>;
}

