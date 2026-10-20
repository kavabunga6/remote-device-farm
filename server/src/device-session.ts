import { PHYSICAL_DEVICE_KINDS, normalizeCapabilities, type PhysicalDeviceKind } from './generated/device-contract.js';
import { assertStoredPermission } from './permissions.js';
import { uiMessage } from './messages.js';
import { assertUserActive } from './user-removal.js';
import { initializeSessionLease, parseLeaseTtlSeconds } from './session-lease.js';
import { randomUUID } from 'node:crypto';
import { transaction } from './db.js';
import { ApiError } from './http-common.js';
import { launchSession } from './session-create.js';
import { STANDARD_START_TIMEOUT_MS } from './startup-progress.js';
import type { ServerContext } from './server-context.js';
import { assertProfileAllowed, sessionLimitFor } from './session-policy.js';

export const DEVICE_KINDS = PHYSICAL_DEVICE_KINDS;
export type DeviceKind = PhysicalDeviceKind;
export const devicePlaceholderProfile = (kind: DeviceKind): string => `device-${kind}`;

export type NewDeviceSession = { hostId: string; kind: DeviceKind; deviceId: string; label?: string | null; leaseTtlSeconds?: number };

export function parseDeviceKind(value: unknown): DeviceKind | null {
  if (value === undefined || value === null || value === 'emulator') return null;
  if (typeof value === 'string' && (DEVICE_KINDS as readonly string[]).includes(value)) return value as DeviceKind;
  throw new ApiError(400, 'invalid_request', uiMessage('ui.49af213a9722', {}, 'en'));
}

// Rents one physical phone. The agent only reports devices that are free (not leased, not being wiped, not
// quarantined); the unique index on (host, device) stops two users from taking the same one in a race.
export async function createDeviceSession(
  context: Pick<ServerContext, 'pool' | 'hub' | 'config'>,
  user: { id: string; role: string },
  input: NewDeviceSession,
): Promise<string> {
  const { pool, hub, config } = context;
  const { hostId, kind, deviceId } = input;
  const leaseTtlSeconds = parseLeaseTtlSeconds(input.leaseTtlSeconds);
  if (!hub.hasAgent(hostId)) throw new ApiError(503, 'agent_offline', uiMessage('ui.75aecf4c8ac3', {}, 'en'));
  const id = randomUUID();
  await transaction(pool, async client => {
    await assertUserActive(client, user.id);
    await assertStoredPermission(client, user.id, 'sessions.create');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['sessions:' + user.id]);
    const limit = await sessionLimitFor(client, user, config);
    if (limit > 0) {
      const active = await client.query(
        "SELECT count(*)::integer AS total FROM sessions WHERE owner_user_id=$1 AND state IN ('starting','running','stopping')", [user.id]);
      if (Number(active.rows[0]?.total || 0) >= limit) {
        throw new ApiError(409, 'session_limit', uiMessage('ui.13f8925bc580', { p0: limit }, 'en'));
      }
    }
    await assertProfileAllowed(client, user, devicePlaceholderProfile(kind));
    // Disabled, so it never shows up in emulator profile pickers; teams may still allow/deny it by id.
    await client.query(
      `INSERT INTO profiles(id,name,android_version,image,cpu,memory_mb,disk_gb,enabled) VALUES($1,$2,'device','',1,1,1,false)
       ON CONFLICT (id) DO NOTHING`, [devicePlaceholderProfile(kind), 'USB Android device']);
    const host = await client.query('SELECT * FROM hosts WHERE id=$1 FOR UPDATE', [hostId]);
    const row = host.rows[0];
    if (!row || row.status !== 'online' || !row.last_seen_at || Date.now() - new Date(row.last_seen_at).getTime() > 45_000) {
      throw new ApiError(503, 'agent_offline', uiMessage('ui.75aecf4c8ac3', {}, 'en'));
    }
    if (row.disabled || row.removed_at) throw new ApiError(409, 'host_unavailable', uiMessage('ui.1276b6393eea', {}, 'en'));
    const devices: Array<Record<string, unknown>> = Array.isArray(row.devices) ? row.devices : [];
    const device = devices.find(item => item.kind === kind && item.id === deviceId);
    if (!device) throw new ApiError(404, 'device_not_found', uiMessage('ui.9b7b0a1e3a84', {}, 'en'));
    if (device.state !== 'free') throw new ApiError(409, 'device_unavailable', uiMessage('ui.3ee4153300d6', { p0: String(device.state) }, 'en'));
    const available = normalizeCapabilities((row.provider_capabilities as Record<string, string[]> | null)?.[kind]);
    const capabilities = normalizeCapabilities(device.capabilities).filter(capability => available.includes(capability));
    try {
      await client.query(
        `INSERT INTO sessions(id,owner_user_id,host_id,profile_id,label,device_kind,device_id,capabilities,state,startup_deadline_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,'starting',now()+make_interval(secs => $9::integer))`,
        [id, user.id, hostId, devicePlaceholderProfile(kind), input.label ?? null, kind, deviceId, capabilities, STANDARD_START_TIMEOUT_MS / 1000],
      );
      await initializeSessionLease(client, id, leaseTtlSeconds);
    } catch (error) {
      if ((error as { code?: string }).code === '23505') throw new ApiError(409, 'device_unavailable', uiMessage('ui.6afc7bfc54b3', {}, 'en'));
      throw error;
    }
  });
  launchSession(context, id, hostId, { kind, deviceSerial: deviceId });
  return id;
}
