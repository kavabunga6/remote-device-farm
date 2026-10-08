import { getLocale, t } from './i18n';
import { useEffect, useState } from 'react';
import type { Host } from './api';
import { heartbeatAge } from './node-capacity';
import { hostSupportsGpu } from './launch-readiness';
import './NodeHealth.css';

export function NodeFreshness({ lastSeenAt }: { lastSeenAt?: string | null }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 10_000); return () => window.clearInterval(timer); }, []);
  const age = heartbeatAge(lastSeenAt, now);
  return <span className={'node-freshness' + (age.stale ? ' stale' : '')} title={age.timestamp == null ? t('ui.1c465c50fc24') : t('ui.1c5737e3fdee') + new Date(age.timestamp).toLocaleString(getLocale())}>
    {age.timestamp == null ? age.label : <time dateTime={lastSeenAt!}>{age.label}</time>}{age.stale && age.timestamp != null && <span> {t('ui.f8762914d8cd')}</span>}
  </span>;
}

const gb = (mb: number | undefined) => mb == null ? t('ui.76848548e29c') : (mb / 1024).toLocaleString(getLocale(), { maximumFractionDigits: 1 }) + t('ui.9fd219660ff0');
const disk = (value: number | undefined) => value == null ? t('ui.76848548e29c') : value.toLocaleString(getLocale()) + t('ui.9fd219660ff0');

export function useNodeGpuState(host: Host) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 10_000); return () => window.clearInterval(timer); }, []);
  const stale = heartbeatAge(host.lastSeenAt, now).stale;
  const modes = (['cuda', 'gpu'] as const).filter(kind => hostSupportsGpu(host, kind));
  const ready = host.status === 'online' && !host.disabled && !stale && modes.length > 0;
  const knownSupport = host.gpuCapabilities != null || host.nvidiaGpuAvailable != null || host.driGpuAvailable != null;
  const status = host.disabled ? t('ui.4ab1c66357c0') : host.status !== 'online' ? t('ui.6a25a71df7a0')
    : stale ? t('ui.81155bf59706') : ready ? t('ui.19b769e6199d') + modes.join(' / ').toUpperCase()
    : host.gpuPresent === false ? t('ui.43687686a7cc') : knownSupport ? t('ui.8899a27ef6c1') : t('ui.76848548e29c');
  const telemetryFresh = host.status === 'online' && !host.disabled && !stale &&
    (!host.metricsSampledAt || !heartbeatAge(host.metricsSampledAt, now).stale);
  const samples = telemetryFresh ? host.gpuTelemetry ?? [] : [];
  return { ready, status, samples, modes, telemetryFresh };
}

export function NodeGpuSummary({ host }: { host: Host }) {
  const { ready, status, samples } = useNodeGpuState(host);
  const number = (value: number | undefined) => value == null ? '—' : value.toLocaleString(getLocale(), { maximumFractionDigits: 1 });
  const memory = (used: number | undefined, total: number | undefined) => used == null && total == null ? t('ui.76848548e29c') : t('ui.0577496921ac', { p0: number(used), p1: number(total) });
  const displaySamples = samples.length ? samples : [{ index: 0 }];
  return <section className="node-gpu-summary" aria-label={t('ui.0625bacc72ad')}>
    <div className="node-gpu-heading"><strong>{t('ui.ea49523d744c')}</strong><span className="node-gpu-status" data-ready={ready}>{status}</span></div>
    <p className="node-gpu-model">{host.gpuModel || host.gpuVendor || t('ui.13876d820b45')}</p>
    <dl className="node-gpu-stats">{displaySamples.map(gpu => <div className="node-gpu-device" key={gpu.index}>
      <div><dt>{samples.length > 1 ? t('ui.e852ec0f9fd7', { p0: gpu.index }) : t('ui.c3c62108cf2d')}</dt><dd>{gpu.utilizationPercent == null ? t('ui.76848548e29c') : number(gpu.utilizationPercent) + '%'}</dd></div>
      <div><dt>{samples.length > 1 ? t('ui.bd87ea962cdf', { p0: gpu.index }) : t('ui.6b088449f998')}</dt><dd>{memory(gpu.memoryUsedMb, gpu.memoryTotalMb)}</dd></div>
    </div>)}</dl>
  </section>;
}

export function NodeDiagnostics({ host }: { host: Host }) {
  const available = host.availableMemoryMb;
  const usedMemory = host.memoryMb > 0 && available != null && available <= host.memoryMb ? host.memoryMb - available : undefined;
  const usedDisk = host.diskTotalGb != null && host.diskFreeGb != null && host.diskFreeGb <= host.diskTotalGb ? host.diskTotalGb - host.diskFreeGb : undefined;
  return <section className="node-diagnostics">
    <details>
      <summary>{t('ui.6f30534b8e4f')}</summary>
      <div className="node-diagnostics-body">
        <NodeFreshness lastSeenAt={host.lastSeenAt} />
        {host.metricsSampledAt && <p className="node-diagnostics-note">{t('ui.e34ff00a6859')}<time dateTime={host.metricsSampledAt}>{new Date(host.metricsSampledAt).toLocaleString(getLocale())}</time></p>}
        <dl>
          <div><dt>{t('ui.db9a4c7d4c19')}</dt><dd>{host.cpuModel || t('ui.76848548e29c')}<small>{host.cpuThreads ?? host.cpuCores} {t('ui.0eea0abefebe')}{host.cpuAllocatableCores ?? host.cpuCores} {t('ui.0e1969d095c8')}</small></dd></div>
          <div><dt>{t('ui.d2ea22920256')}</dt><dd>{host.cpuUsagePercent == null ? t('ui.76848548e29c') : host.cpuUsagePercent.toLocaleString(getLocale()) + '%'}<small>{host.cpuUsagePercent == null ? t('ui.d232c914bd55') : t('ui.b6859c41c53c') + (host.cpuSampleSeconds == null ? '' : t('ui.f288b4634295') + host.cpuSampleSeconds.toLocaleString(getLocale()) + t('ui.ddae8eb8bf21'))}</small></dd></div>
          <div><dt>{t('ui.397211640533')}</dt><dd>{usedMemory == null ? t('ui.657c678d1ce1') : gb(usedMemory) + t('ui.6a9be1e0d6ec')}<small>{gb(available)} {t('ui.793b498949a0')}{host.memoryMb > 0 ? gb(host.memoryMb) : t('ui.24007c1536f5')}</small></dd></div>
          <div><dt>{t('ui.bde0aff1af78')}</dt><dd>{usedDisk == null ? t('ui.657c678d1ce1') : disk(usedDisk) + t('ui.6a9be1e0d6ec')}<small>{disk(host.diskFreeGb)} {t('ui.0132217719e1')}{disk(host.diskTotalGb)}</small></dd></div>
          <div><dt>{t('ui.37f517249285')}</dt><dd>{host.agentVersion || t('ui.76848548e29c')}<small>{host.agentBuild ? <>{t('ui.580afcf7cc89')}<code title={host.agentBuild}>{host.agentBuild.slice(0, 12)}</code></> : host.agentVersion ? t('ui.2f0d0537f92f') : t('ui.d152f97cab26')}</small></dd></div>
          <div><dt>{t('ui.63ea7497db83')}</dt><dd>{host.agentCpuLimitCores == null ? t('ui.ccb166abc06b') : 'CPU: ' + (host.agentCpuLimitCores === 0 ? t('ui.cf2a13bd7f5b') : host.agentCpuLimitCores)}<small>{t('ui.e33333f36050')}{gb(host.agentMemoryLimitMb)}</small></dd></div>
        </dl>
        <NodeGpuSummary host={host} />
        <p className="node-diagnostics-note">{t('ui.cedb2bd92e75')}</p>
        <a className="text-button" href={'#/admin/journal?host=' + encodeURIComponent(host.id) + '&tab=logs'}>{t('ui.5a8c27196f52')}</a>
      </div>
    </details>
  </section>;
}
