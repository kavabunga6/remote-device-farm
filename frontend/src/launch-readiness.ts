import { t } from './i18n';
import type { Host, Profile, SessionLaunchOptions } from './api';
import { effectiveLaunchProfile, launchResourceError } from './launch-options';
import { effectiveProfileMemory } from './profile-catalog';
import { memoryLabel } from './profile-metadata';

export type LaunchMode = 'software' | 'nvidia';
export type LaunchIssue = { code: string; message: string; remedy: string; href?: string; action?: string };
export type LaunchReadiness = {
  state: 'ready' | 'busy' | 'blocked';
  issues: LaunchIssue[];
  host?: Host;
  nodes: Array<{ host: Host; issues: LaunchIssue[] }>;
};

export const profileSettingsHref = (id: string): string =>
  '#/admin/profiles?profile=' + encodeURIComponent(id);
const nodeSettingsHref = (id: string): string => '#/admin/nodes?host=' + encodeURIComponent(id);
const hasImage = (image: string | null | undefined): boolean => Boolean(image?.trim());
export const hostSupportsGpu = (host: Host, support: 'cuda' | 'gpu'): boolean => host.gpuCapabilities
  ? host.gpuCapabilities.includes(support)
  : support === 'cuda' ? host.nvidiaGpuAvailable === true : host.driGpuAvailable === true;
export const hostGpuBackend = (host: Host): 'cuda' | 'gpu' | null =>
  hostSupportsGpu(host, 'cuda') ? 'cuda' : hostSupportsGpu(host, 'gpu') ? 'gpu' : null;
const freeSlots = (host: Host): number => Math.max(0, host.maxSessions - host.activeSessions);
const nodeIssue = (host: Host, code: string, message: string, remedy: string): LaunchIssue =>
  ({ code, message, remedy, href: nodeSettingsHref(host.id), get action() { return t('ui.d72a02dc6d33'); } });
const named = (host: Host, issue: LaunchIssue): LaunchIssue => ({ ...issue, message: host.name + ': ' + issue.message });

export function profileLaunchIssues(profile: Profile | undefined, mode: LaunchMode, options: SessionLaunchOptions = {}): LaunchIssue[] {
  if (!profile) return [{ code: 'profile_missing', message: t('ui.ec94bd140d72'), remedy: t('ui.da553d61a88a') }];
  const issues: LaunchIssue[] = [];
  const issue = (code: string, message: string, remedy: string): LaunchIssue =>
    ({ code, message, remedy, href: profileSettingsHref(profile.id), action: t('ui.bb491331425a') });
  if (profile.enabled === false) issues.push(issue('profile_disabled', t('ui.49cd221882bd'),
    t('ui.8e3cfbea6fb8')));
  if (!hasImage(profile.image)) issues.push(issue('profile_image_missing',
    t('ui.6121d4951101'),
    t('ui.531013f899d7')));
  const effective = effectiveLaunchProfile(profile, options);
  const memory = effectiveProfileMemory(effective, mode);
  if (!Number.isInteger(effective.cpu) || Number(effective.cpu) < 1 || Number(effective.cpu) > 16 ||
      !Number.isInteger(memory) || Number(memory) < 1024 || Number(memory) > 65536) issues.push(issue('profile_resources_invalid',
    t('ui.3fcee739ef45'),
    t('ui.9ab933f6d811')));
  const resourceError = launchResourceError(profile, options, true);
  if (resourceError) issues.push(issue('launch_resources_invalid', resourceError, t('ui.4b179cc33c5b')));
  return issues;
}

// Match assertProfileHostArchitecture on the server. Empty legacy metadata does not invent a restriction.
function architectureMatches(profile: Profile, host: Host): boolean {
  const architecture = host.architecture?.toLowerCase() ?? '';
  const accepted = ['x64', 'x86_64', 'amd64'].includes(architecture) ? ['x86', 'x86_64']
    : ['arm64', 'aarch64'].includes(architecture) ? ['arm64-v8a'] : null;
  const abis = profile.abi?.split(',').map(value => value.trim()).filter(Boolean) ?? [];
  return !accepted || !abis.length || abis.some(abi => accepted.includes(abi));
}

/** Compatibility and availability; occupied slots are handled separately so a valid request can queue. */
export function hostLaunchIssues(profile: Profile | undefined, host: Host, mode: LaunchMode, privileged = false, options: SessionLaunchOptions = {}): LaunchIssue[] {
  const issues: LaunchIssue[] = [];
  if (host.providers?.some(provider => provider.kind === 'emulator' && provider.status === 'unavailable')) {
    issues.push(nodeIssue(host, 'provider_unavailable', t('api.provider_unavailable'), t('providers.unavailableHint')));
  }
  if (host.disabled) issues.push(nodeIssue(host, 'host_disabled', t('ui.da96a62f49ba'),
    t('ui.6c3bb15db73e')));
  if (host.status !== 'online') issues.push(nodeIssue(host, 'host_offline', t('ui.e97506a30a79'),
    t('ui.3e3a7539d9bf')));
  // Older inventories may omit the timestamp. The server always checks freshness and the live connection.
  else if (host.lastSeenAt) {
    const heartbeat = Date.parse(host.lastSeenAt);
    if (!Number.isFinite(heartbeat) || Date.now() - heartbeat > 45_000) issues.push(nodeIssue(host, 'host_stale',
      t('ui.c60b86dd667f'), t('ui.2c7a71467af3')));
  }
  if (host.status === 'online' && !host.disabled && host.maxSessions <= 0) issues.push(nodeIssue(host, 'host_no_capacity',
    t('ui.c9ea189dc21c'), t('ui.04657fbe0f52')));
  if (profile && !architectureMatches(profile, host)) issues.push(nodeIssue(host, 'host_architecture',
    'ABI ' + profile.abi + t('ui.5505b34233f8') + host.architecture + '.',
    t('ui.532ef516e6e1')));
  if (mode === 'nvidia' && !hostGpuBackend(host)) issues.push(nodeIssue(host, 'host_gpu_unavailable',
    t('ui.b50c5958d488'),
    t('ui.ebc7be492d72')));
  if (profile) {
    const effective = effectiveLaunchProfile(profile, options);
    const memory = effectiveProfileMemory(effective, mode);
    if ((effective.cpu != null && effective.cpu > host.slotCpu) || (memory != null && memory > host.slotMemoryMb)) {
      issues.push(nodeIssue(host, 'host_resources',
        t('ui.58a6a639ad19', { p0: mode === 'nvidia' ? t('ui.47cac4fd3319') : '', p1: effective.cpu ?? '—', p2: memoryLabel(memory), p3: host.slotCpu, p4: memoryLabel(host.slotMemoryMb) }),
        t('ui.cd2862dea854')));
    }
  }
  if (privileged && host.privilegedEmulatorsAllowed !== true) issues.push(nodeIssue(host, 'host_privileged_unavailable',
    t('ui.7323446f47d6'),
    t('ui.bfd5b7899496')));
  // policyPending alone is not a server admission failure: continue using the reported effective slots.
  return issues;
}

const busyIssue = (host: Host): LaunchIssue => ({ code: 'slots_busy', get message() { return t('ui.5293ac418993'); },
  get remedy() { return t('ui.1f0e24903ccc'); }, href: nodeSettingsHref(host.id), get action() { return t('ui.d72a02dc6d33'); } });

export function launchReadiness(profile: Profile | undefined, hosts: Host[], mode: LaunchMode,
  hostId = '', privileged = false, options: SessionLaunchOptions = {}): LaunchReadiness {
  const profileIssues = profileLaunchIssues(profile, mode, options);
  const evaluated = hosts.map(host => ({ host, issues: hostLaunchIssues(profile, host, mode, privileged, options) }));
  const nodes = evaluated.map(entry => ({ host: entry.host,
    issues: (entry.issues.length || freeSlots(entry.host) > 0 ? entry.issues : [busyIssue(entry.host)]).map(issue => named(entry.host, issue)) }));
  const candidates = hostId ? evaluated.filter(entry => entry.host.id === hostId) : evaluated;
  if (!candidates.length) {
    const issue: LaunchIssue = hostId
      ? { code: 'host_missing', message: t('ui.d3b726d16fb7'), remedy: t('ui.a0d0a90f90d5'), href: '#/admin/nodes', action: t('ui.1331496bcf5d') }
      : { code: 'hosts_missing', message: t('ui.44b27e4b1942'), remedy: t('ui.056f460bb0fc'), href: '#/admin/nodes', action: t('ui.1331496bcf5d') };
    return { state: 'blocked', issues: [...profileIssues, issue], nodes };
  }
  const compatible = candidates.filter(entry => !entry.issues.length);
  const ready = compatible.find(entry => freeSlots(entry.host) > 0);
  if (!profileIssues.length && ready) return { state: 'ready', issues: [], host: ready.host, nodes };
  const waiting = compatible[0];
  if (!profileIssues.length && waiting) return { state: 'busy', issues: [named(waiting.host, busyIssue(waiting.host))], host: waiting.host, nodes };
  const gpuCandidates = mode === 'nvidia' ? candidates.filter(entry => hostGpuBackend(entry.host)) : [];
  const closest = (gpuCandidates.length ? gpuCandidates : candidates).reduce((best, entry) => entry.issues.length < best.issues.length ? entry : best);
  return { state: 'blocked', issues: [...profileIssues, ...closest.issues.map(issue => named(closest.host, issue))], host: closest.host, nodes };
}
