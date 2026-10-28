import { t } from './i18n';
import type { Host, NodeSettingsInput, Profile } from './api';

const boundedInteger = (value: unknown, min: number, max: number) =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max ? value : null;

export function previewNodeCapacity(host: Host, settings: Partial<NodeSettingsInput>) {
  // Mirrors desiredNodePolicy on the server. Use total allocatable capacity,
  // not the changing free memory figure; existing sessions are never evicted.
  const cpu = boundedInteger(host.cpuAllocatableCores ?? host.cpuCores, 1, 4096) ?? 0;
  const memoryMb = boundedInteger(host.memoryAllocatableMb ?? host.memoryMb, 1024, 1_000_000_000) ?? 0;
  const cpuBudget = Math.max(0, cpu - Math.max(1, Math.ceil(cpu * .2)));
  const memoryBudgetMb = Math.max(0, memoryMb - Math.ceil(memoryMb * .2));
  const slotCpu = boundedInteger(settings.slotCpu ?? host.slotCpu, 1, 16);
  const slotMemoryMb = boundedInteger(settings.slotMemoryMb ?? host.slotMemoryMb, 1024, 65536);
  const manualSlots = boundedInteger(settings.manualSlots ?? host.manualSlots, 0, 32);
  const dynamic = (settings.slotMode ?? host.slotMode) === 'dynamic';
  if (slotCpu === null || slotMemoryMb === null || (!dynamic && manualSlots === null)) return null;
  const cpuSlots = Math.floor(cpuBudget / slotCpu);
  const memorySlots = Math.floor(memoryBudgetMb / slotMemoryMb);
  let slots = dynamic ? Math.min(cpuSlots, memorySlots, 32) : manualSlots!;
  const limit: string[] = dynamic
    ? [...(cpuSlots <= Math.min(memorySlots, 32) ? ['CPU'] : []), ...(memorySlots <= Math.min(cpuSlots, 32) ? [t('ui.63e0c823d377')] : []), ...(32 <= Math.min(cpuSlots, memorySlots) ? [t('ui.06bc36ec9298')] : [])]
    : [t('ui.79915b2878e8')];
  // Legacy agents cannot grow beyond their reported capacity or stored slot cap.
  if (!host.policySupported) {
    const cap = Math.max(0, Math.min(host.reportedSlots, host.slotCap ?? host.reportedSlots));
    if (cap < slots) limit.push(t('ui.e25fbadadc9a'));
    slots = Math.min(slots, cap);
  }
  const disabled = settings.disabled ?? host.disabled;
  return { slots: disabled ? 0 : slots, capacity: slots, cpuBudget, memoryBudgetMb,
    cpuSlots, memorySlots, limit, dynamic, disabled,
    free: host.status === 'online' && !disabled ? Math.max(0, slots - host.activeSessions) : 0 };
}

export function profilesExceedingSlot(profiles: Profile[], slotCpu: number, slotMemoryMb: number) {
  return profiles.filter(profile => profile.enabled !== false).flatMap(profile => {
    const reasons: string[] = [];
    if (profile.cpu != null && profile.cpu > slotCpu) reasons.push('CPU: ' + profile.cpu + ' > ' + slotCpu);
    if (profile.memoryMb != null && profile.memoryMb > slotMemoryMb) reasons.push(t('copy.node-capacity.7c4f5033', { p0: profile.memoryMb, p1: slotMemoryMb }));
    return reasons.length ? [{ profile, reasons }] : [];
  });
}

export function heartbeatAge(lastSeenAt: string | null | undefined, now = Date.now()) {
  const timestamp = lastSeenAt ? Date.parse(lastSeenAt) : NaN;
  if (!Number.isFinite(timestamp)) return { label: t('ui.ff5511447db5'), stale: true, timestamp: null };
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1000));
  const label = seconds < 60 ? t('copy.node-capacity.db46f868', { p0: seconds }) : seconds < 3600 ? t('copy.node-capacity.618d1529', { p0: Math.floor(seconds / 60) }) : seconds < 86400 ? t('copy.node-capacity.8221ea8c', { p0: Math.floor(seconds / 3600) }) : t('copy.node-capacity.b4a581de', { p0: Math.floor(seconds / 86400) });
  return { label: seconds < 5 ? t('ui.5e8dcd6b1ed9') : t('node.respondedAgo', { p0: label }), stale: seconds > 45, timestamp };
}
