import type { DeviceDescriptor, DevicePlatform, PhysicalDeviceKind, DeviceAvailability } from './generated/device-contract';
import { withRequestDeadline, RequestTimeoutError } from './request-deadline';
import { knownErrorMessages, errorMessage, t } from './i18n';
import { physicalDevices } from './devices';

export type AuthMethod = 'local' | 'ldap' | 'oidc' | 'none';

export interface SessionLimits { maxSessionsPerUser: number; idleTimeoutMinutes: number; maxSessionHours: number }

export interface AppConfig {
  authMethods: AuthMethod[];
  oidcLoginUrl?: string;
  limits?: SessionLimits;
}

export interface User {
  id: string;
  username: string;
  displayName?: string;
  role: 'admin' | 'user';
  roleId?: string;
  roleName?: string;
  roleBuiltin?: 'admin' | 'user' | null;
  permissions?: string[];
}

export interface NavigationCounts {
  sessions: number;
  tokens: number;
  allSessions?: number;
  nodes?: number;
  profiles?: number;
  users?: number;
}

export interface GpuTelemetry {
  index: number;
  utilizationPercent?: number;
  memoryUsedMb?: number;
  memoryTotalMb?: number;
}

export interface LiveHostTelemetry {
  agentVersion?: string;
  agentBuild?: string;
  metricsSampledAt?: string;
  cpuUsagePercent?: number;
  cpuSampleSeconds?: number;
  gpuTelemetry?: GpuTelemetry[];
}

export type DeviceKind = PhysicalDeviceKind;
export type DeviceState = DeviceAvailability | string;
export type HostDevice = DeviceDescriptor;

export interface Host extends LiveHostTelemetry {
  privilegedEmulatorsAllowed?: boolean;
  devices: HostDevice[];
  id: string;
  name: string;
  status: 'online' | 'offline';
  cpuCores: number;
  cpuPhysicalCores?: number;
  cpuThreads?: number;
  cpuModel?: string;
  memoryMb: number;
  freeMemoryMb?: number;
  availableMemoryMb?: number;
  gpuPresent?: boolean;
  gpuModel?: string;
  gpuVendor?: string;
  environmentType?: 'bare-metal' | 'virtual-machine' | 'kubernetes-pod' | 'unknown';
  virtualizationType?: string;
  agentRuntime?: 'kubernetes-pod' | 'container' | 'process';
  hostIp?: string;
  diskTotalGb?: number;
  diskFreeGb?: number;
  cpuAllocatableCores?: number;
  memoryAllocatableMb?: number;
  agentCpuLimitCores?: number;
  agentMemoryLimitMb?: number;
  slotMode: 'manual' | 'dynamic';
  manualSlots: number;
  slotCpu: number;
  slotMemoryMb: number;
  disabled: boolean;
  policySupported: boolean;
  policyPending: boolean;
  /** This node builds farm emulator images and pushes them to the registry. */
  imageBuilder?: boolean;
  maxSessions: number;
  reportedSlots: number;
  slotCap: number | null;
  agentName: string;
  displayName: string | null;
  activeSessions: number;
  architecture?: string;
  gpuCapabilities?: ('cuda' | 'gpu')[];
  nvidiaGpuAvailable?: boolean;
  driGpuAvailable?: boolean;
  lastSeenAt?: string;
}

interface HostPayload {
  devices?: unknown;
  id: string;
  name: string;
  agentName: string;
  displayName: string | null;
  status: Host['status'];
  slots: number;
  slotMode: 'manual' | 'dynamic';
  manualSlots: number;
  slotCpu: number;
  slotMemoryMb: number;
  disabled: boolean;
  policySupported: boolean;
  policyPending: boolean;
  imageBuilder?: boolean;
  reportedSlots: number;
  slotCap: number | null;
  usedSlots: number;
  metrics?: LiveHostTelemetry & {
    privilegedEmulatorsAllowed?: boolean;
    cpuCores?: number;
    cpuAllocatableCores?: number;
    agentCpuLimitCores?: number;
    agentMemoryLimitMb?: number;
    memoryAllocatableMb?: number;
    diskTotalGb?: number;
    diskFreeGb?: number;
    hostIp?: string;
    cpuPhysicalCores?: number;
    cpuThreads?: number;
    cpuModel?: string;
    memoryTotalMb?: number;
    memoryFreeMb?: number;
    memoryAvailableMb?: number;
    gpuPresent?: boolean;
    gpuModel?: string;
    gpuVendor?: string;
    gpuCapabilities?: ('cuda' | 'gpu')[];
    nvidiaGpuAvailable?: boolean;
    driGpuAvailable?: boolean;
    architecture?: string;
    environmentType?: Host['environmentType'];
    virtualizationType?: string;
    agentRuntime?: Host['agentRuntime'];
  };
  lastSeenAt?: string;
}

function hostFromPayload(host: HostPayload): Host {
  return {
    id: host.id, name: host.name, agentName: host.agentName, devices: physicalDevices(host.devices),
    displayName: host.displayName, status: host.status,
    cpuCores: host.metrics?.cpuCores ?? 0,
    cpuPhysicalCores: host.metrics?.cpuPhysicalCores, cpuThreads: host.metrics?.cpuThreads,
    cpuModel: host.metrics?.cpuModel,
    agentVersion: host.metrics?.agentVersion, agentBuild: host.metrics?.agentBuild,
    metricsSampledAt: host.metrics?.metricsSampledAt, cpuUsagePercent: host.metrics?.cpuUsagePercent,
    cpuSampleSeconds: host.metrics?.cpuSampleSeconds, gpuTelemetry: host.metrics?.gpuTelemetry,
    memoryMb: host.metrics?.memoryTotalMb ?? 0,
    freeMemoryMb: host.metrics?.memoryFreeMb,
    availableMemoryMb: host.metrics?.memoryAvailableMb,
    gpuPresent: host.metrics?.gpuPresent, gpuModel: host.metrics?.gpuModel,
    gpuVendor: host.metrics?.gpuVendor,
    environmentType: host.metrics?.environmentType,
    virtualizationType: host.metrics?.virtualizationType,
    agentRuntime: host.metrics?.agentRuntime,
    hostIp: host.metrics?.hostIp,
    privilegedEmulatorsAllowed: host.metrics?.privilegedEmulatorsAllowed === true,
    diskTotalGb: host.metrics?.diskTotalGb, diskFreeGb: host.metrics?.diskFreeGb,
    cpuAllocatableCores: host.metrics?.cpuAllocatableCores,
    agentCpuLimitCores: host.metrics?.agentCpuLimitCores, agentMemoryLimitMb: host.metrics?.agentMemoryLimitMb,
    memoryAllocatableMb: host.metrics?.memoryAllocatableMb,
    slotMode: host.slotMode, manualSlots: host.manualSlots, slotCpu: host.slotCpu,
    slotMemoryMb: host.slotMemoryMb, disabled: host.disabled, imageBuilder: host.imageBuilder === true,
    policySupported: host.policySupported, policyPending: host.policyPending,
    maxSessions: host.slots,
    reportedSlots: host.reportedSlots, slotCap: host.slotCap,
    activeSessions: host.usedSlots, architecture: host.metrics?.architecture,
    gpuCapabilities: host.metrics?.gpuCapabilities,
    nvidiaGpuAvailable: host.metrics?.nvidiaGpuAvailable, driGpuAvailable: host.metrics?.driGpuAvailable, lastSeenAt: host.lastSeenAt,
  };
}

export interface NodeOccupant {
  slotIndex: number;
  sessionId: string;
  state: SessionStatus;
  startedAt: string | null;
  ownerId: string;
  ownerName: string;
  profileName: string;
}

export interface AgentBundleInfo {
  version: string;
  filename: string;
  sha256: string;
  sizeBytes: number;
}

export interface NodeSettingsInput {
  displayName: string | null;
  slotMode: 'manual' | 'dynamic';
  manualSlots: number;
  slotCpu: number;
  slotMemoryMb: number;
  disabled: boolean;
}

export interface SessionLaunchOptions {
  /** Container limits for this launch; omitted inherits the profile. */
  cpu?: number;
  memoryMb?: number;
  /** Android resources; null keeps the image default, omitted inherits the profile. */
  guestCores?: number | null;
  guestMemoryMb?: number | null;
  /** Administrator only; also requires the agent policy to permit this. */
  privileged?: boolean;
  /** Android userdata size in GiB, not a quota for the Docker writable layer. */
  diskGb?: number;
  /** Omitted: image default; zero: no SD card; otherwise MiB. */
  sdCardMb?: number;
  /** Replaces the profile's extra emulator arguments; empty clears them. */
  emulatorParams?: string;
}

export interface Profile {
  /** Server-verified recipe. Missing on older servers; never infer from an image name. */
  id: string;
  name: string;
  androidVersion?: string;
  image?: string;
  cpu?: number;
  memoryMb?: number;
  guestMemoryMb?: number | null;
  guestCores?: number | null;
  diskGb?: number;
  /** Upper bound a user may pick for the data partition (defaults to diskGb). */
  diskMaxGb?: number | null;
  sdcardGb?: number | null;
  sdcardMaxGb?: number | null;
  emulatorParams?: string;
  /** Only in administrator responses. */
  /** Variable names only: values are stored encrypted and never returned (null stands for "stored"). */
  containerEnv?: Record<string, string | null>;
  dockerOptions?: Record<string, unknown>;
  imageTag?: string | null;
  deviceType?: 'mobile' | 'tv' | 'wear' | 'automotive' | 'desktop' | null;
  recommended?: boolean;
  /** null inherits the farm default; the resolved flag is provided by the server. */
  allowLaunchOverrides?: boolean | null;
  launchOverridesAllowed?: boolean;
  imageFlavor?: 'aosp' | 'google_apis' | 'google_play' | null;
  enabled?: boolean;
  /** Descriptive image metadata, not emulator launch parameters. */
  apiLevel?: number | null;
  abi?: string | null;
  deviceModel?: string | null;
  resolution?: string | null;
}

export type ProfileInput = Required<Pick<Profile, 'id' | 'name' | 'androidVersion' | 'image' | 'cpu' | 'memoryMb' | 'guestMemoryMb' | 'guestCores' | 'diskGb' | 'emulatorParams'>> & Partial<Pick<Profile, 'apiLevel' | 'abi' | 'deviceModel' | 'resolution' | 'imageFlavor' | 'deviceType' | 'imageTag' | 'recommended' | 'allowLaunchOverrides' | 'containerEnv' | 'dockerOptions' | 'diskMaxGb' | 'sdcardGb' | 'sdcardMaxGb'>>;

export interface AgentCredential {
  hostId: string;
  createdAt: string;
  name?: string;
  status?: string;
  lastSeenAt?: string | null;
  source?: 'environment' | 'registered';
  canRevoke?: boolean;
}

export interface AdminUser extends User {
  company?: string | null;
  jobTitle?: string | null;
  provider: string;
  createdAt?: string;
}

export type SessionStatus = 'starting' | 'running' | 'stopping' | 'stopped' | 'error';

export interface StartupProgress {
  stage: 'checking_image' | 'waiting_image' | 'downloading' | 'creating' | 'booting' | 'ready';
  currentBytes?: number;
  totalBytes?: number;
  percent?: number;
  updatedAt?: string;
}

export type ProfileManifest = { version: number; profiles: unknown[] };
export interface ProfileImportResult {
  applied: boolean;
  issues: Array<{ path: string; message: string }>;
  results: Array<{ id: string; name: string; action: 'create' | 'update' | 'skip' | 'invalid'; issues: Array<{ path: string; message: string }>; warnings: string[] }>;
}

export interface DeviceSession {
  platform?: DevicePlatform;
  /** Effective launch settings retained for recreating the same session. */
  launchOptions?: SessionLaunchOptions;
  gpuMode?: 'software' | 'nvidia';
  startupProgress?: StartupProgress | null;
  id: string;
  ownerId: string;
  ownerName?: string;
  hostId: string;
  hostName?: string;
  profileId: string;
  profileName?: string;
  adbKeyId?: string | null;
  deviceKind?: 'emulator' | DeviceKind;
  deviceId?: string | null;
  /** What the device can do; null/absent means everything (emulators). */
  capabilities?: string[] | null;
  status: SessionStatus;
  orientation?: 'portrait' | 'landscape';
  audioEnabled?: boolean;
  networkEnabled?: boolean;
  createdAt: string;
  error?: string | null;
  adminAccess?: { username: string; at: string } | null;
  label?: string | null;
  lastActivityAt?: string;
  idleExpiresAt?: string | null;
  expiresAt?: string | null;
}

export interface AdbResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface AdbPortAccess {
  host: string;
  port: number;
  expiresAt: string | null;
  fingerprint: string;
  sessionId: string;
}

export interface AdbPublicKey {
  id: string;
  name: string;
  fingerprint: string;
  createdAt: string;
}

export interface AdbUserKey {
  fingerprint: string;
  createdAt: string;
}

export interface NewAdbUserKey extends AdbUserKey {
  privateKey: string;
  publicKey: string;
}

export interface ApiToken {
  id: string;
  name: string;
  kind: 'personal' | 'system';
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
}

export type LogLevel = 'V' | 'D' | 'I' | 'W' | 'E' | 'F';

export interface LogEntry {
  ts: string;
  pid: number;
  tid: number;
  level: LogLevel;
  tag: string;
  message: string;
}

export interface LogCursor { since: string; skip: number }
export interface LogcatPage { entries: LogEntry[]; cursor: LogCursor | null }
export interface LogcatQuery { lines?: number; level?: LogLevel; buffers?: string[]; since?: string; skip?: number }

export interface DeviceInfo {
  collectedAt: string;
  device: { manufacturer: string | null; brand: string | null; model: string | null; name: string | null; codename: string | null; hardware: string | null; board: string | null; abi: string | null; abis: string[]; serial: string | null };
  android: { release: string | null; sdk: number | null; securityPatch: string | null; buildId: string | null; incremental: string | null; buildType: string | null; tags: string | null; fingerprint: string | null; debuggable: boolean; rooted: boolean };
  display: { physical: { width: number; height: number } | null; override: { width: number; height: number } | null; density: number | null; overrideDensity: number | null };
  system: { kernel: string | null; uptimeSeconds: number | null; timezone: string | null; locale: string | null };
  memory: { totalKb: number | null; availableKb: number | null };
  storage: { totalKb: number | null; usedKb: number | null; availableKb: number | null } | null;
  battery: { level?: number | null; status?: string; acPowered?: boolean; usbPowered?: boolean } | null;
  network: { addresses: Array<{ interface: string; address: string }> };
  graphics: { openGl: string | null; egl: string | null; vulkan: string | null };
  chrome: string | null;
  apps: Array<{ package: string; versionCode: number | null }>;
  session: { id: string; hostName: string | null; createdAt: string; startedAt: string | null; orientation: string; networkEnabled: boolean; audioEnabled: boolean };
  profile: { id: string; name: string; image: string; androidVersion: string; cpu: number; memoryMb: number; guestMemoryMb: number | null; guestCores: number | null; diskGb: number; sdCardMb?: number | null; gpuMode: string; emulatorParams: string } | null;
}

export class ApiError extends Error {
  constructor(message: string, public status: number, public rawMessage?: string) {
    super(message);
    this.name = 'ApiError';
  }
}

const API_BASE = '/api';

// Server messages are English; people see these instead for the cases they can act on.
export const KNOWN_ERRORS: Record<string, string> = knownErrorMessages();

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  try {
    return await withRequestDeadline(async signal => {
      const response = await fetch(`${API_BASE}${path}`, {
        credentials: 'include',
        cache: 'no-store',
        ...options,
        signal,
        headers: {
          ...(options.body && !(options.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
          ...options.headers,
        },
      });
      const contentType = response.headers.get('Content-Type') ?? '';
      const body: unknown = contentType.includes('application/json')
        ? await response.json()
        : await response.text();

      if (!response.ok) {
        if (response.status === 401 && path !== '/login' && path !== '/me') {
          window.dispatchEvent(new Event('rdf:unauthorized'));
        }
        const code = typeof body === 'object' && body !== null && 'error' in body && typeof body.error === 'object' && body.error !== null && 'code' in body.error
          ? String(body.error.code) : '';
        const message = KNOWN_ERRORS[code] ?? (typeof body === 'object' && body !== null && 'error' in body
          ? (typeof body.error === 'object' && body.error !== null && 'message' in body.error ? String(body.error.message) : String(body.error))
          : typeof body === 'object' && body !== null && 'message' in body
            ? String(body.message)
            : typeof body === 'string' && body.trim() && !body.trim().startsWith('<')
              ? body.trim()
              : t('ui.d68415ca6873', { p0: response.status }));
        throw new ApiError(KNOWN_ERRORS[code] || errorMessage(response.status, message), response.status, message);
      }

      return body as T;
    }, { signal: options.signal });
  } catch (cause) {
    if (cause instanceof RequestTimeoutError) throw new ApiError(t('error.timeout'), 408);
    throw cause;
  }
}

// Feature modules (queue, sharing, apps...) call the API through these instead of editing this file.
export const apiRequest = <T,>(path: string, options: RequestInit = {}): Promise<T> => request<T>(path, options);
export const jsonBody = (value: unknown): string => JSON.stringify(value);

function json(value: unknown): string {
  return JSON.stringify(value);
}

export const api = {
  async navigationCounts(): Promise<NavigationCounts> {
    return (await request<{ counts: NavigationCounts }>('/navigation-counts')).counts;
  },
  async config(): Promise<AppConfig> {
    const result = await request<Partial<AppConfig> & { authMode?: AuthMethod | 'keycloak'; authRequired?: boolean; oidcEnabled?: boolean; enabledAuthMethods?: AuthMethod[] }>('/config');
    const modes: AuthMethod[] = result.authMethods ?? result.enabledAuthMethods ?? (result.authRequired === false ? ['none'] : result.authMode === 'keycloak' ? ['oidc'] : result.authMode ? [result.authMode] : ['local']);
    if (result.oidcEnabled && !modes.includes('oidc')) modes.push('oidc');
    return {
      authMethods: modes,
      oidcLoginUrl: result.oidcLoginUrl,
      limits: result.limits,
    };
  },
  async me(): Promise<User | null> {
    const result = await request<{ user: User | null }>('/me');
    return result.user;
  },
  async login(username: string, password: string, provider: 'local' | 'ldap'): Promise<User> {
    const result = await request<{ user: User }>('/login', { method: 'POST', body: json({ username, password, provider }) });
    return result.user;
  },
  logout: () => request<void>('/logout', { method: 'POST' }),
  async hosts(): Promise<Host[]> {
    const result = await request<{ hosts: HostPayload[] }>('/hosts');
    return result.hosts.map(hostFromPayload);
  },
  async profiles(): Promise<Profile[]> {
    const result = await request<{ profiles: Profile[] }>('/profiles');
    return result.profiles;
  },
  async adminProfiles(): Promise<Profile[]> {
    const result = await request<{ profiles: Profile[] }>('/admin/profiles');
    return result.profiles;
  },
  async sessions(): Promise<DeviceSession[]> {
    const result = await request<{ sessions: Array<Omit<DeviceSession, 'status'> & { state: DeviceSession['status'] | 'failed' }> }>('/sessions');
    return result.sessions.map(session => ({ ...session, status: session.state === 'failed' ? 'error' : session.state }));
  },
  async session(id: string): Promise<DeviceSession> {
    const result = await request<{ session: Omit<DeviceSession, 'status'> & { state: DeviceSession['status'] | 'failed' } }>(`/sessions/${encodeURIComponent(id)}`);
    return { ...result.session, status: result.session.state === 'failed' ? 'error' : result.session.state };
  },
  async createSession(hostId: string, profileId: string, adbKeyId: string | null = null, gpuMode?: 'software' | 'nvidia', storage: { diskGb?: number; sdcardGb?: number } = {}, launchOptions?: SessionLaunchOptions): Promise<DeviceSession> {
    const result = await request<{ session: Omit<DeviceSession, 'status'> & { state: DeviceSession['status'] | 'failed' } }>('/sessions', { method: 'POST', body: json({ hostId, profileId, adbKeyId, gpuMode, ...storage, launchOptions }) });
    return { ...result.session, status: result.session.state === 'failed' ? 'error' : result.session.state };
  },
  async rentDevice(hostId: string, deviceKind: DeviceKind, deviceId: string): Promise<DeviceSession> {
    const result = await request<{ session: Omit<DeviceSession, 'status'> & { state: DeviceSession['status'] | 'failed' } }>('/sessions', { method: 'POST', body: json({ hostId, deviceKind, deviceId }) });
    return { ...result.session, status: result.session.state === 'failed' ? 'error' : result.session.state };
  },
  sanitizeDevice: (hostId: string, kind: DeviceKind, deviceId: string) =>
    request<{ clean: boolean }>('/admin/hosts/' + encodeURIComponent(hostId) + '/devices/sanitize', { method: 'POST', body: json({ kind, deviceId }) }),
  releaseSession: (id: string) => request<{ ok: boolean; released?: boolean }>(`/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  killSession: (id: string) => request<{ ok: boolean; released?: boolean }>(`/sessions/${encodeURIComponent(id)}/kill`, { method: 'POST' }),
  async rotate(id: string, orientation: 'portrait' | 'landscape'): Promise<DeviceSession> {
    const result = await request<{ session: Omit<DeviceSession, 'status'> & { state: DeviceSession['status'] | 'failed' } }>(`/sessions/${encodeURIComponent(id)}/rotate`, { method: 'POST', body: json({ orientation }) });
    return { ...result.session, status: result.session.state === 'failed' ? 'error' : result.session.state };
  },
  async setAudio(id: string, enabled: boolean): Promise<DeviceSession> {
    const result = await request<{ session: Omit<DeviceSession, 'status'> & { state: DeviceSession['status'] | 'failed' } }>(`/sessions/${encodeURIComponent(id)}/audio`, { method: 'POST', body: json({ enabled }) });
    return { ...result.session, status: result.session.state === 'failed' ? 'error' : result.session.state };
  },
  async setNetwork(id: string, enabled: boolean): Promise<DeviceSession> {
    const result = await request<{ session: Omit<DeviceSession, 'status'> & { state: DeviceSession['status'] | 'failed' } }>(`/sessions/${encodeURIComponent(id)}/network`, { method: 'POST', body: json({ enabled }) });
    return { ...result.session, status: result.session.state === 'failed' ? 'error' : result.session.state };
  },
  uploadFile: (id: string, file: File) => {
    const body = new FormData();
    body.append('file', file);
    return request<{ path?: string }>(`/sessions/${encodeURIComponent(id)}/files`, { method: 'POST', body });
  },
  adb: (id: string, argv: string[]) =>
    request<AdbResult>(`/sessions/${encodeURIComponent(id)}/adb`, {
      method: 'POST', body: json({ argv }),
    }),
  logcat: (id: string, query: LogcatQuery = {}) => {
    const params = new URLSearchParams();
    if (query.lines) params.set('lines', String(query.lines));
    if (query.level) params.set('level', query.level);
    if (query.buffers?.length) params.set('buffers', query.buffers.join(','));
    if (query.since) { params.set('since', query.since); params.set('skip', String(query.skip ?? 0)); }
    return request<LogcatPage>(`/sessions/${encodeURIComponent(id)}/logcat?${params}`);
  },
  keepAlive: async (id: string): Promise<DeviceSession> => {
    const result = await request<{ session: Omit<DeviceSession, 'status'> & { state: DeviceSession['status'] | 'failed' } }>(`/sessions/${encodeURIComponent(id)}/keepalive`, { method: 'POST' });
    return { ...result.session, status: result.session.state === 'failed' ? 'error' : result.session.state };
  },
  renameSession: async (id: string, label: string | null): Promise<DeviceSession> => {
    const result = await request<{ session: Omit<DeviceSession, 'status'> & { state: DeviceSession['status'] | 'failed' } }>(`/sessions/${encodeURIComponent(id)}`, { method: 'PATCH', body: json({ label }) });
    return { ...result.session, status: result.session.state === 'failed' ? 'error' : result.session.state };
  },
  clearLogcat: (id: string) => request<{ ok: boolean }>(`/sessions/${encodeURIComponent(id)}/logcat/clear`, { method: 'POST' }),
  deviceInfo: (id: string) => request<DeviceInfo>(`/sessions/${encodeURIComponent(id)}/device-info`),
  adbPortAccess: (id: string) =>
    request<{ access: AdbPortAccess | null }>(`/sessions/${encodeURIComponent(id)}/adb-port-access`),
  createAdbPortAccess: (id: string, publicKey?: string) =>
    request<AdbPortAccess>(`/sessions/${encodeURIComponent(id)}/adb-port-access`, { method: 'POST', body: json(publicKey ? { publicKey } : {}) }),
  revokeAdbPortAccess: (id: string) =>
    request<{ ok: boolean }>(`/sessions/${encodeURIComponent(id)}/adb-port-access`, { method: 'DELETE' }),
  async listAdbPublicKeys(): Promise<AdbPublicKey[]> {
    const result = await request<{ keys: AdbPublicKey[] }>('/me/adb-public-keys');
    return result.keys;
  },
  async addAdbPublicKey(name: string, publicKey: string): Promise<AdbPublicKey> {
    const result = await request<{ key: AdbPublicKey }>('/me/adb-public-keys',
      { method: 'POST', body: json({ name, publicKey }) });
    return result.key;
  },
  async renameAdbPublicKey(id: string, name: string): Promise<AdbPublicKey> {
    const result = await request<{ key: AdbPublicKey }>(`/me/adb-public-keys/${encodeURIComponent(id)}`,
      { method: 'PATCH', body: json({ name }) });
    return result.key;
  },
  deleteAdbPublicKey: (id: string) =>
    request<{ ok: boolean }>(`/me/adb-public-keys/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  adbUserKey: () => request<{ key: AdbUserKey | null }>('/me/adb-key'),
  createAdbUserKey: () => request<NewAdbUserKey>('/me/adb-key', { method: 'POST' }),
  rotateAdbUserKey: () => request<NewAdbUserKey>('/me/adb-key/rotate', { method: 'POST' }),
  input: (id: string, payload: Record<string, unknown>) =>
    request<void>(`/sessions/${encodeURIComponent(id)}/input`, { method: 'POST', body: json({ type: 'input', ...payload }) }),
  launchSettings: () => request<{ allowLaunchOverrides: boolean }>('/admin/launch-settings'),
  updateLaunchSettings: (allowLaunchOverrides: boolean) => request<{ allowLaunchOverrides: boolean }>('/admin/launch-settings', { method: 'PATCH', body: json({ allowLaunchOverrides }) }),
  createProfile: (profile: ProfileInput) => request<{ profile: Profile }>('/admin/profiles', { method: 'POST', body: json(profile) }),
  updateProfile: (id: string, profile: Partial<ProfileInput> & { enabled?: boolean }) => request<{ profile: Profile }>(`/admin/profiles/${encodeURIComponent(id)}`, { method: 'PATCH', body: json(profile) }),
  disableProfile: (id: string) => request<void>(`/admin/profiles/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  exportProfiles: () => request<ProfileManifest>('/admin/profiles/export'),
  importProfiles: (manifest: unknown, options: { apply: boolean; update: boolean }) =>
    request<ProfileImportResult>('/admin/profiles/import', { method: 'POST', body: json({ manifest, ...options }) }),
  deleteProfile: (id: string) => request<void>(`/admin/profiles/${encodeURIComponent(id)}/permanent`, { method: 'DELETE' }),
  async updateHostSettings(id: string, settings: Partial<NodeSettingsInput>): Promise<{ host: Host; policyError: string | null }> {
    const result = await request<{ host: HostPayload; policyError: string | null }>('/admin/hosts/' + encodeURIComponent(id) + '/settings', { method: 'PATCH', body: json(settings) });
    return { host: hostFromPayload(result.host), policyError: result.policyError };
  },
  async hostOccupants(id: string): Promise<NodeOccupant[]> {
    const result = await request<{ occupants: NodeOccupant[] }>(`/admin/hosts/${encodeURIComponent(id)}/slots`);
    return result.occupants;
  },
  async agentBundleInfo(): Promise<AgentBundleInfo> {
    return request<AgentBundleInfo>('/admin/agent-bundle/info');
  },
  async agents(): Promise<AgentCredential[]> {
    const result = await request<{ agents: AgentCredential[] }>('/admin/agents');
    return result.agents;
  },
  createAgent: (hostId: string) => request<{ token: string; agent: AgentCredential }>('/admin/agents', { method: 'POST', body: json({ hostId }) }),
  revokeAgent: (hostId: string) => request<void>(`/admin/agents/${encodeURIComponent(hostId)}`, { method: 'DELETE' }),
  async users(): Promise<AdminUser[]> {
    const result = await request<{ users: AdminUser[] }>('/admin/users');
    return result.users;
  },
  createUser: (input: { username: string; displayName: string; company: string; jobTitle: string; password: string; role: 'admin' | 'user'; roleId?: string }) =>
    request<{ user: AdminUser }>('/admin/users', { method: 'POST', body: json(input) }),
  updateUser: (id: string, input: { displayName: string; company: string; jobTitle: string }) =>
    request<{ user: AdminUser }>(`/admin/users/${encodeURIComponent(id)}`, { method: 'PATCH', body: json(input) }),
  deleteUser: (id: string) =>
    request<{ ok: true }>(`/admin/users/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  resetUserPassword: (id: string, newPassword: string) =>
    request<{ ok: true }>(`/admin/users/${encodeURIComponent(id)}/password`, { method: 'POST', body: json({ newPassword }) }),
  async tokens(): Promise<ApiToken[]> {
    const result = await request<{ tokens: ApiToken[] }>('/tokens');
    return result.tokens;
  },
  createToken: (name: string, expiresInDays: number | null) =>
    request<{ token: string; item: ApiToken }>('/tokens', { method: 'POST', body: json({ name, expiresInDays }) }),
  revokeToken: (id: string) => request<void>(`/tokens/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  async systemTokens(): Promise<ApiToken[]> {
    const result = await request<{ tokens: ApiToken[] }>('/admin/tokens');
    return result.tokens;
  },
  createSystemToken: (name: string, expiresInDays: number | null) =>
    request<{ token: string; item: ApiToken }>('/admin/tokens', { method: 'POST', body: json({ name, expiresInDays }) }),
  revokeSystemToken: (id: string) => request<void>(`/admin/tokens/${encodeURIComponent(id)}`, { method: 'DELETE' }),
};

export function sessionSocketUrl(id: string): string {
  const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${scheme}//${window.location.host}${API_BASE}/sessions/${encodeURIComponent(id)}/stream`;
}
