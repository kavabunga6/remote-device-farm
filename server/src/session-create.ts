import { normalizeDeviceMetadata } from './generated/device-contract.js';
import { assertPermission, roleForUser } from './permissions.js';
import { uiMessage } from './messages.js';
import { assertUserActive } from './user-removal.js';
import { sessionLog } from './service-log.js';
import { redactLog } from './application-log.js';
import { assertLaunchOverridesAllowed } from './launch-permissions.js';
import { hostGpuBackend } from './gpu-modes.js';
import { assertHostLaunchOptions, assertLaunchOptionsAccess, normalizeProfileResources, mergeLaunchStorage, resolveLaunchOptions, type LaunchOptions } from './launch-options.js';
import { getSecretBox, openEnv } from './secrets.js';
import { registryAuthFor } from './registry.js';
import { initializeSessionLease, parseLeaseTtlSeconds } from './session-lease.js';
import { assertProfileHostArchitecture } from './profile-host.js';
import { randomUUID } from 'node:crypto';
import { allocateAdbPortAccess } from './adb-access.js';
import { transaction } from './db.js';
import { ApiError } from './http-common.js';
import type { ServerContext } from './server-context.js';
import { assertProfileAllowed, sessionLimitFor } from './session-policy.js';
import { parseRequestedGpuMode, resolveProfileLaunch, type GpuMode } from './profile-launch.js';
import { STANDARD_START_TIMEOUT_MS, START_CANCEL_TIMEOUT_MS, startupFailureMessage } from './startup-progress.js';
import { notifySessionReady, notifyUser } from './notifications.js';
import { type StorageRequest } from './storage.js';
import { selectedAdbKey } from './user-adb-keys.js';

export type NewSession = {
  hostId: string;
  profileId: string;
  gpuMode?: GpuMode;
  launchOptions?: LaunchOptions;
  // undefined: use the owner's default; null: use the personal farm key if it exists
  adbKeyId?: string | null;
  label?: string | null;
  storage?: StorageRequest;
  leaseTtlSeconds?: number;
  // Internal queue idempotency key; never taken from a request body.
  sessionId?: string;
};

// Reserves a slot and starts the emulator. Returns once the session row exists in state "starting";
// the emulator start continues in the background. Used by the API and by the waiting-list dispatcher.
export async function createSession(
  context: Pick<ServerContext, 'pool' | 'hub' | 'config'>,
  user: { id: string; role: string },
  input: NewSession,
): Promise<string> {
  const { pool, hub, config } = context;
  const { hostId, profileId } = input;
  const leaseTtlSeconds = parseLeaseTtlSeconds(input.leaseTtlSeconds);
  const requestedGpuMode = parseRequestedGpuMode(input.gpuMode);
  const requestedLaunchOptions = mergeLaunchStorage(input.launchOptions, input.storage);
  const id = input.sessionId ?? randomUUID();
  if (input.sessionId) {
    const existing = await pool.query('SELECT owner_user_id,profile_id,gpu_mode,launch_options FROM sessions WHERE id=$1', [id]);
    if (existing.rows[0]) {
      if (existing.rows[0].owner_user_id !== user.id || existing.rows[0].profile_id !== profileId ||
          (requestedGpuMode !== undefined && existing.rows[0].gpu_mode != null && existing.rows[0].gpu_mode !== requestedGpuMode) ||
          Object.entries(requestedLaunchOptions).some(([key, value]) => existing.rows[0].launch_options?.[key] !== value)) {
        throw new ApiError(409, 'session_conflict', uiMessage('ui.24c83821db84', {}, 'en'));
      }
      return id;
    }
  }
  if (!hub.hasAgent(hostId)) throw new ApiError(503, 'agent_offline', uiMessage('ui.75aecf4c8ac3', {}, 'en'));
  const profile = await transaction(pool, async client => {
    await assertUserActive(client, user.id);
    const role = await roleForUser(client, user.id);
    if (!role) throw new ApiError(403, 'permission_denied', uiMessage('roles.permissionDenied'));
    user = { ...user, role: role.roleBuiltin === 'admin' ? 'admin' : 'user', ...role };
    assertPermission(user, 'sessions.create');
    assertLaunchOptionsAccess(requestedLaunchOptions, user);
    // One lock per user keeps two parallel requests from slipping past the limit.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['sessions:' + user.id]);
    const limit = await sessionLimitFor(client, user, config);
    if (limit > 0) {
      const active = await client.query(
        "SELECT count(*)::integer AS total FROM sessions WHERE owner_user_id=$1 AND state IN ('starting','running','stopping')",
        [user.id],
      );
      if (Number(active.rows[0]?.total || 0) >= limit) {
        throw new ApiError(409, 'session_limit', uiMessage('ui.13f8925bc580', { p0: limit }, 'en'));
      }
    }
    await assertProfileAllowed(client, user, profileId);
    const host = await client.query(`SELECT * FROM hosts WHERE id=$1 FOR UPDATE`, [hostId]);
    if (!host.rows[0] || host.rows[0].status !== 'online' ||
        !host.rows[0].last_seen_at || Date.now() - new Date(host.rows[0].last_seen_at).getTime() > 45_000) {
      throw new ApiError(503, 'agent_offline', uiMessage('ui.75aecf4c8ac3', {}, 'en'));
    }
    if (host.rows[0].disabled || host.rows[0].removed_at) {
      throw new ApiError(409, 'host_unavailable', uiMessage('ui.1276b6393eea', {}, 'en'));
    }
    const profileResult = await client.query(`SELECT * FROM profiles WHERE id=$1 AND enabled=true FOR SHARE`, [profileId]);
    if (!profileResult.rows[0]) throw new ApiError(404, 'profile_not_found', uiMessage('ui.999930725d06', {}, 'en'));
    profileResult.rows[0] = normalizeProfileResources(profileResult.rows[0]);
    assertProfileHostArchitecture(profileResult.rows[0], host.rows[0].metrics ?? {});
    await assertLaunchOverridesAllowed(client, user, profileResult.rows[0], requestedLaunchOptions);
    const launchOptions = resolveLaunchOptions(profileResult.rows[0], requestedLaunchOptions, user);
    assertHostLaunchOptions(launchOptions, host.rows[0].metrics ?? {});
    const launch = resolveProfileLaunch({ ...profileResult.rows[0], memory_mb: launchOptions.memoryMb }, requestedGpuMode);
    const gpuBackend = launch.gpuMode === 'nvidia' ? hostGpuBackend(host.rows[0].metrics) : null;
    if (launch.gpuMode === 'nvidia' && !gpuBackend) {
      throw new ApiError(409, 'gpu_unavailable', uiMessage('ui.f6db63e49d3b', {}, 'en'));
    }
    if (launchOptions.cpu > Number(host.rows[0].slot_cpu) ||
        launch.memoryMb > Number(host.rows[0].slot_memory_mb)) {
      throw new ApiError(409, 'profile_too_large', uiMessage('ui.5ae180683b19', {}, 'en'));
    }
    const slots = Number(host.rows[0].slots);
    const capacity = hub.supportsNodePolicy?.(hostId) ? slots : Math.min(slots,
      host.rows[0].slot_cap == null ? slots : Number(host.rows[0].slot_cap),
      Number(host.rows[0].manual_slots));
    const occupied = await client.query(
      'SELECT count(*)::integer AS used FROM host_slots WHERE host_id=$1 AND session_id IS NOT NULL', [hostId],
    );
    // Count occupied high-index slots after a capacity shrink too.
    if (Number(occupied.rows[0]?.used || 0) >= capacity) {
      throw new ApiError(409, 'no_free_slots', uiMessage('ui.2b36b3fce00d', {}, 'en'));
    }
    const slot = await client.query(
      `SELECT slot_index FROM host_slots WHERE host_id=$1 AND slot_index<$2 AND session_id IS NULL
       ORDER BY slot_index LIMIT 1 FOR UPDATE SKIP LOCKED`,
      [hostId, capacity],
    );
    if (!slot.rows[0]) throw new ApiError(409, 'no_free_slots', uiMessage('ui.2b36b3fce00d', {}, 'en'));
    const timeoutMs = STANDARD_START_TIMEOUT_MS;
    const preferred = input.adbKeyId === undefined
      ? await client.query('SELECT default_adb_key_id FROM user_preferences WHERE user_id=$1', [user.id])
      : null;
    const adbKeyId = input.adbKeyId === undefined
      ? (preferred?.rows[0]?.default_adb_key_id as string | undefined) ?? null
      : input.adbKeyId;
    const selectedKey = await selectedAdbKey(client, user.id, adbKeyId);
    await client.query(
      `INSERT INTO sessions(id,owner_user_id,host_id,profile_id,adb_key_id,label,gpu_mode,launch_image,launch_memory_mb,launch_options,launch_disk_gb,launch_sdcard_gb,startup_deadline_at,startup_progress,state) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$12,$13,$14,now()+make_interval(secs => $10::integer),$11,'starting')`,
      [id, user.id, hostId, profileId, adbKeyId, input.label ?? null, launch.gpuMode, launch.image, launch.memoryMb, timeoutMs / 1000, { stage: 'checking_image', updatedAt: new Date().toISOString() }, launchOptions, launchOptions.diskGb, launchOptions.sdCardMb / 1024],
    );
    await initializeSessionLease(client, id, leaseTtlSeconds);
    await client.query(`UPDATE host_slots SET session_id=$3 WHERE host_id=$1 AND slot_index=$2`, [hostId, slot.rows[0].slot_index, id]);
    if (config.adbPorts && selectedKey) {
      await allocateAdbPortAccess(client, config, id, user.id, selectedKey, null);
    }
    return { ...profileResult.rows[0], image: launch.image, gpu_mode: launch.gpuMode, gpuBackend, memory_mb: launch.memoryMb, launchOptions, timeoutMs };
  });
  await sessionLog(pool, hostId, id, 'session.reserved', uiMessage('ui.03ec908e4216') + profileId);
  try {
    const box = await getSecretBox(pool, config.secretsKey);
    // Images of the farm registry or the company registry are pulled with credentials valid for this start only.
    const registryAuth = await registryAuthFor(pool, box, String(profile.image), 'pull', hostId);
    launchSession(context, id, hostId, {
      profile: {
        id: profile.id, name: profile.name, image: profile.image,
        androidVersion: profile.android_version, deviceType: profile.device_type ?? null, resolution: profile.resolution ?? null, cpu: profile.launchOptions.cpu,
        memoryMb: profile.launchOptions.memoryMb, guestMemoryMb: profile.launchOptions.guestMemoryMb, guestCores: profile.launchOptions.guestCores, diskGb: profile.launchOptions.diskGb, sdCardMb: profile.launchOptions.sdCardMb,
        ...(profile.launchOptions.privileged === true ? { privileged: true } : {}),
        ...(registryAuth ? { registryAuth } : {}),
        emulatorParams: profile.launchOptions.emulatorParams, containerEnv: openEnv(box, profile.container_env), dockerOptions: profile.docker_options || {}, gpuBackend: profile.gpuBackend, gpuMode: profile.gpu_mode || 'software',
      },
    }, profile.timeoutMs);
  } catch (error) {
    await sessionLog(pool, hostId, id, 'session.prepare_failed', error instanceof Error ? error.message : String(error), 'error');
    await pool.query("UPDATE sessions SET state='stopping',error=$2 WHERE id=$1", [id, uiMessage('ui.539c73c2be32')]);
    hub.stopSession(hostId, id, true);
    throw error;
  }
  return id;
}

// Sends `start` to the agent and settles the session row when it answers. Shared by emulator and physical devices:
// what differs is only `params` (an emulator profile or a device to lease).
export function launchSession(
  context: Pick<ServerContext, 'pool' | 'hub'>, id: string, hostId: string, params: Record<string, unknown>, timeoutMs = STANDARD_START_TIMEOUT_MS,
): Promise<void> {
  const { pool, hub } = context;
  const profile = params.profile as Record<string, unknown> | undefined;
  const safeProfile = profile ? Object.fromEntries(['id', 'name', 'image', 'deviceType', 'resolution', 'cpu', 'memoryMb',
    'guestMemoryMb', 'guestCores', 'diskGb', 'sdCardMb', 'gpuMode', 'gpuBackend', 'emulatorParams'].map(key => [key, profile[key]])) : { kind: params.kind };
  const secrets = profile ? [...Object.values(profile.containerEnv as Record<string, string> || {}),
    String((profile.registryAuth as Record<string, unknown> | undefined)?.password || '')] : [];
  const requestedLog = sessionLog(pool, hostId, id, 'session.start_requested', uiMessage('ui.8be4fa5ae2d0') + timeoutMs / 1000 + uiMessage('ui.882b30a2cad2') + redactLog(JSON.stringify(safeProfile), secrets))
;
  const start = (async () => {
    const owner = (await pool.query('SELECT owner_user_id FROM sessions WHERE id=$1', [id])).rows[0];
    if (!owner) throw new ApiError(409, 'session_inactive', uiMessage('ui.9fa6e8e66b25', {}, 'en'));
    let command!: Promise<Record<string, unknown>>;
    await transaction(pool, async client => {
      // Preparation may outlive account deletion or an accepted stop. Lock in
      // allocation order and send start while removal cannot pass this check.
      await assertUserActive(client, String(owner.owner_user_id));
      const active = await client.query("SELECT id FROM sessions WHERE id=$1 AND state='starting' FOR SHARE", [id]);
      if (!active.rowCount) throw new ApiError(409, 'session_inactive', uiMessage('ui.9fa6e8e66b25', {}, 'en'));
      command = hub.command(hostId, id, 'start', params, timeoutMs);
      // Attach a rejection handler before committing; the RPC must not keep
      // transaction locks for the duration of Android startup.
      void command.catch(() => {});
    });
    return command;
  })();
  return start.then(async data => {
    await requestedLog;
    const details = normalizeDeviceMetadata(data);
    const updated = await pool.query(
      `UPDATE sessions SET state='running',container_id=$2,started_at=now(),last_activity_at=now(),startup_progress=$3,
       capabilities=COALESCE($4::text[],capabilities),device_metadata=COALESCE($5::jsonb,device_metadata)
       WHERE id=$1 AND state='starting' RETURNING id`, [id, data.containerId || null, { stage: 'ready', percent: 100, updatedAt: new Date().toISOString() }, details.capabilities ?? null, details.capabilities ? details : null],
    );
    if (updated.rowCount) {
      await notifySessionReady(pool, id);
      await sessionLog(pool, hostId, id, 'session.running', uiMessage('ui.915a714de612') + String(data.containerId || '—'));
      hub.refreshStream(id, hostId);
    }
    if (!updated.rowCount && hub.hasAgent(hostId)) {
      // Recovery or a concurrent heartbeat may have already completed this same
      // start. Do not tear down its ready container when the original RPC settles.
      const recovered = await pool.query(
        "SELECT id FROM sessions WHERE id=$1 AND host_id=$2 AND state='running' AND container_id IS NOT DISTINCT FROM $3",
        [id, hostId, data.containerId || null],
      );
      if (!recovered.rowCount) await hub.command(hostId, id, 'kill', {}, START_CANCEL_TIMEOUT_MS).catch(() => {});
    }
  }).catch(async (error) => {
    await requestedLog;
    await sessionLog(pool, hostId, id, 'session.start_failed', redactLog(error instanceof Error ? error.message : String(error), secrets), 'error');
    const previous = await pool.query('SELECT startup_progress FROM sessions WHERE id=$1', [id]).catch(() => ({ rows: [] }));
    const reason = startupFailureMessage(previous.rows[0]?.startup_progress, error);
    const updated = await pool.query(
      `UPDATE sessions SET state='stopping',error=$2 WHERE id=$1 AND state='starting' RETURNING owner_user_id`,
      [id, reason],
    ).catch(() => ({ rowCount: 0, rows: [] }));
    if (!updated.rowCount) return;
    await notifyUser(pool, String(updated.rows[0].owner_user_id), { kind: 'session.failed', title: uiMessage('ui.f70ff6228697'), body: reason, sessionId: id });
    try {
      await sessionLog(pool, hostId, id, 'session.failed_cleanup', uiMessage('ui.eebd211eebb0'));
      await hub.command(hostId, id, 'kill', {}, START_CANCEL_TIMEOUT_MS);
      await hub.releaseSession(id);
    } catch (cleanupError) {
      await sessionLog(pool, hostId, id, 'session.cleanup_deferred', String(cleanupError instanceof Error ? cleanupError.message : cleanupError), 'error');
      /* reconcile when agent returns */
    }
  });
}
