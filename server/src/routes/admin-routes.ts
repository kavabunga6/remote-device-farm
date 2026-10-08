import { assertPermission, assertStoredPermission, hasPermission, roleForUser, allPermissions } from '../permissions.js';
import { registerRoleRoutes } from './role-routes.js';
import { uiMessage } from '../messages.js';
import { removeUser } from '../user-removal.js';
import { createHash, randomUUID } from 'node:crypto';
import { exportManifest, parseManifest, checkManifestProfile, type ManifestIssue } from '../profile-manifest.js';
import { getSecretBox, sealEnv } from '../secrets.js';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Express, Response } from 'express';
import { hashPassword, newToken, tokenHash } from '../auth.js';
import { profileField } from '../user-profile.js';
import { transaction } from '../db.js';
import { desiredNodePolicy, parseNodeSettings } from '../node-policy.js';
import { listAgentInventory } from '../agent-inventory.js';
import type { ServerContext } from '../server-context.js';
import { allowedProfileIds } from '../teams.js';
import { matchesSelector, parseProfileSelector } from '../profile-selector.js';
import { recordAuditEvent } from '../audit.js';
import { ApiError, boundedString, hostJson, isUuid, parseProfile, profileJson, route } from '../http-common.js';

function pickUserMetrics(metrics: Record<string, unknown>) {
  return { architecture: metrics.architecture, ...(Array.isArray(metrics.gpuCapabilities) ? { gpuCapabilities: metrics.gpuCapabilities.filter(value => value === 'cuda' || value === 'gpu') } : {}), nvidiaGpuAvailable: metrics.nvidiaGpuAvailable === true, driGpuAvailable: metrics.driGpuAvailable === true };
}

export function registerAdminRoutes(app: Express, context: ServerContext): void {
  const { pool, config, auth, hub, requireAuth, requireAdmin, current } = context;
  registerRoleRoutes(app, context);
  // Only scalar totals for navigation: no identities, token values or cross-user data for ordinary users.
  app.get('/api/navigation-counts', requireAuth, route(async (_req, res) => {
    const user = current(res).user;
    const admin = ['sessions.viewAll','nodes.view','profiles.view','users.view','tokens.system'].some(p => hasPermission(user,p));
    const { rows } = await pool.query(`SELECT
      (SELECT COUNT(*)::integer FROM sessions WHERE owner_user_id=$1 AND state IN ('starting','running','stopping')) AS sessions,
      (SELECT COUNT(*)::integer FROM api_tokens WHERE (kind='personal' AND owner_user_id=$1) OR ($2 AND kind='system')) AS tokens
      ${admin ? `,
      (SELECT COUNT(*)::integer FROM sessions WHERE state IN ('starting','running','stopping')) AS "allSessions",
      (SELECT COUNT(*)::integer FROM hosts WHERE removed_at IS NULL) AS nodes,
      (SELECT COUNT(*)::integer FROM profiles WHERE removed_at IS NULL AND id NOT LIKE 'device-%') AS profiles,
      (SELECT COUNT(*)::integer FROM users WHERE provider!='system' AND removed_at IS NULL) AS users` : ''}`, [user.id, hasPermission(user, 'tokens.system')]);
    const counts = rows[0];
    for (const [key, permission] of Object.entries({ allSessions: 'sessions.viewAll', nodes: 'nodes.view', profiles: 'profiles.view', users: 'users.view' })) if (!hasPermission(user, permission)) delete counts[key];
    res.json({ counts });
  }));
  async function assertAgentCredentialChangeAllowed(client: { query: typeof pool.query }, hostId: string): Promise<void> {
    const host = await client.query('SELECT removed_at FROM hosts WHERE id=$1 FOR UPDATE', [hostId]);
    if (host.rows[0]?.removed_at) throw new ApiError(409, 'node_removed', uiMessage('ui.bc5370279524', {}, 'en'));
    if (host.rowCount) {
      const active = await client.query(
        `SELECT 1 FROM sessions WHERE host_id=$1 AND state IN ('starting','running','stopping') LIMIT 1`, [hostId]);
      const occupied = await client.query('SELECT 1 FROM host_slots WHERE host_id=$1 AND session_id IS NOT NULL LIMIT 1', [hostId]);
      if (active.rowCount || occupied.rowCount) throw new ApiError(409, 'node_in_use', uiMessage('ui.338d03095bfd', {}, 'en'));
    }
  }
  app.get('/api/hosts', requireAuth, route(async (_req, res) => {
    const { rows } = await pool.query(
      `SELECT h.*,COUNT(hs.session_id)::integer AS used_slots FROM hosts h
       LEFT JOIN host_slots hs ON hs.host_id=h.id
       WHERE h.removed_at IS NULL GROUP BY h.id ORDER BY COALESCE(h.display_name,h.name)`,
    );
    // The agent's inventory can be up to one heartbeat old; a device with an active session is busy right now.
    const busy = await pool.query(
      "SELECT host_id,device_id FROM sessions WHERE device_id IS NOT NULL AND state IN ('starting','running','stopping')");
    const taken = new Set(busy.rows.map(row => `${row.host_id}\u0000${row.device_id}`));
    const isAdmin = hasPermission(current(res).user, 'nodes.view');
    // Users only see nodes that can take a session right now; offline and paused ones are an administrator's concern.
    const visible = isAdmin ? rows : rows.filter(row => row.status === 'online' && row.disabled !== true);
    res.json({ hosts: visible.map(row => {
      const full = hostJson(row);
      // Users only need what decides whether a profile fits; addresses, hardware and telemetry are for administrators.
      const host = isAdmin ? full : { ...full, metrics: pickUserMetrics(full.metrics as Record<string, unknown>),
        agentName: full.name, reportedSlots: full.slots, slotCap: null, manualSlots: full.slots };
      return { ...host, devices: host.devices.map(item => {
        const device = item as Record<string, unknown>;
        const state = taken.has(`${host.id}\u0000${device.id}`) && device.state === 'free' ? 'busy' : device.state;
        return isAdmin ? { ...device, state } : { ...device, state, reason: null };
      }) };
    }) });
  }));
  app.get('/api/admin/hosts/:id/slots', requireAuth, requireAdmin, route(async (req, res) => {
    const hostId = req.params.id!;
    const host = await pool.query('SELECT id FROM hosts WHERE id=$1 AND removed_at IS NULL', [hostId]);
    if (!host.rowCount) throw new ApiError(404, 'not_found', uiMessage('ui.aa0a65c4fcfd', {}, 'en'));
    const { rows } = await pool.query(
      `SELECT hs.slot_index AS "slotIndex",s.id AS "sessionId",s.state,s.started_at AS "startedAt",
              u.id AS "ownerId",u.display_name AS "ownerName",p.name AS "profileName"
       FROM host_slots hs JOIN sessions s ON s.id=hs.session_id
       JOIN users u ON u.id=s.owner_user_id JOIN profiles p ON p.id=s.profile_id
       WHERE hs.host_id=$1 AND s.state IN ('starting','running','stopping')
       ORDER BY hs.slot_index`, [hostId]);
    res.json({ occupants: rows });
  }));
  app.patch('/api/admin/hosts/:id/settings', requireAuth, requireAdmin, route(async (req, res) => {
    const hostId = req.params.id!;
    await transaction(pool, async client => {
      const existing = await client.query('SELECT * FROM hosts WHERE id=$1 AND removed_at IS NULL FOR UPDATE', [hostId]);
      if (!existing.rows[0]) throw new ApiError(404, 'not_found', uiMessage('ui.aa0a65c4fcfd', {}, 'en'));
      const settings = parseNodeSettings(req.body || {}, existing.rows[0]);
      if (Number(existing.rows[0].agent_policy_version) < 1 &&
          (settings.slotMode === 'dynamic' || settings.manualSlots > Number(existing.rows[0].slots))) {
        throw new ApiError(409, 'agent_upgrade_required', uiMessage('ui.d0ce9b3e8723', {}, 'en'));
      }
      const result = await client.query(
        `UPDATE hosts SET display_name=$2,slot_mode=$3,manual_slots=$4,slot_cpu=$5,
          slot_memory_mb=$6,disabled=$7,policy_revision=policy_revision+1,
          applied_policy_revision=-1 WHERE id=$1 RETURNING *`,
        [hostId, settings.displayName, settings.slotMode, settings.manualSlots,
         settings.slotCpu, settings.slotMemoryMb, settings.disabled]);
      const desired = desiredNodePolicy(result.rows[0]);
      await client.query('UPDATE hosts SET slots=LEAST(slots,$2) WHERE id=$1', [hostId, desired.slots]);
    });
    let policyError: string | null = null;
    if (hub.supportsNodePolicy(hostId)) {
      try { await hub.applyHostPolicy(hostId); }
      catch (error) { policyError = uiMessage('ui.735f9fe926a8'); }
    }
    const { rows } = await pool.query(
      `SELECT h.*,(SELECT COUNT(*)::integer FROM host_slots hs WHERE hs.host_id=h.id AND hs.session_id IS NOT NULL) AS used_slots
       FROM hosts h WHERE h.id=$1`, [hostId]);
    res.json({ host: hostJson(rows[0]), policyError });
  }));
  // Retry the wipe on a quarantined device. It returns to rotation only if the agent verifies it clean.
  app.post('/api/admin/hosts/:id/devices/sanitize', requireAuth, requireAdmin, route(async (req, res) => {
    const hostId = req.params.id!;
    const kind = boundedString(req.body?.kind, 32);
    const deviceId = boundedString(req.body?.deviceId, 100);
    if (!/^[a-z-]+$/.test(kind) || !deviceId) throw new ApiError(400, 'invalid_request', uiMessage('ui.e016f0268216', {}, 'en'));
    const host = await pool.query('SELECT id FROM hosts WHERE id=$1 AND removed_at IS NULL', [hostId]);
    if (!host.rowCount) throw new ApiError(404, 'not_found', uiMessage('ui.aa0a65c4fcfd', {}, 'en'));
    if (!hub.hasAgent(hostId)) throw new ApiError(409, 'agent_offline', uiMessage('ui.5d8d8846b76f', {}, 'en'));
    const result = await hub.command(hostId, hostId, 'device-sanitize', { kind, deviceId }, 40 * 60_000);
    await recordAuditEvent(pool, { action: 'admin.device_sanitized', actor: current(res).user, targetType: 'device',
      targetId: deviceId.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 100), outcome: result.clean === true ? 'success' : 'failed' }).catch(() => {});
    res.json({ clean: result.clean === true });
  }));
  app.delete('/api/admin/hosts/:id', requireAuth, requireAdmin, route(async (req, res) => {
    const hostId = req.params.id!;
    await transaction(pool, async client => {
      const host = await client.query('SELECT id FROM hosts WHERE id=$1 AND removed_at IS NULL FOR UPDATE', [hostId]);
      if (!host.rowCount) throw new ApiError(404, 'not_found', uiMessage('ui.aa0a65c4fcfd', {}, 'en'));
      const active = await client.query(
        `SELECT 1 FROM sessions WHERE host_id=$1 AND state IN ('starting','running','stopping') LIMIT 1`, [hostId]);
      const occupied = await client.query('SELECT 1 FROM host_slots WHERE host_id=$1 AND session_id IS NOT NULL LIMIT 1', [hostId]);
      if (active.rowCount || occupied.rowCount) throw new ApiError(409, 'node_in_use', uiMessage('ui.634ba71e7234', {}, 'en'));
      await client.query(
        `UPDATE hosts SET removed_at=now(),disabled=true,status='offline',slots=0,
         policy_revision=policy_revision+1,applied_policy_revision=-1 WHERE id=$1`, [hostId]);
      await client.query('DELETE FROM agent_credentials WHERE host_id=$1', [hostId]);
    });
    hub.disconnectHost(hostId);
    res.json({ ok: true });
  }));
  app.get('/api/admin/launch-settings', requireAuth, requireAdmin, route(async (_req, res) => {
    const { rows } = await pool.query('SELECT allow_launch_overrides FROM launch_settings WHERE id=true');
    res.json({ allowLaunchOverrides: rows[0]?.allow_launch_overrides === true });
  }));
  app.patch('/api/admin/launch-settings', requireAuth, requireAdmin, route(async (req, res) => {
    const body = req.body;
    if (!body || typeof body.allowLaunchOverrides !== 'boolean' || Object.keys(body).some(key => key !== 'allowLaunchOverrides')) {
      throw new ApiError(400, 'invalid_launch_settings', uiMessage('ui.263b42a58a10', {}, 'en'));
    }
    const { rows } = await pool.query('UPDATE launch_settings SET allow_launch_overrides=$1 WHERE id=true RETURNING allow_launch_overrides', [body.allowLaunchOverrides]);
    res.json({ allowLaunchOverrides: rows[0]!.allow_launch_overrides === true });
  }));
  app.get('/api/profiles', requireAuth, route(async (req, res) => {
    const { rows } = await pool.query(`SELECT p.*,COALESCE(p.allow_launch_overrides,s.allow_launch_overrides) AS launch_overrides_allowed FROM profiles p CROSS JOIN launch_settings s WHERE p.enabled=true AND p.removed_at IS NULL ORDER BY p.name`);
    const allowed = await allowedProfileIds(pool, current(res).user);
    // Same filter as the "profile" selector of POST /api/sessions and /api/queue, e.g. ?android=14&deviceType=tv.
    const query = Object.fromEntries(Object.entries(req.query).filter(([key, value]) => ['android', 'api', 'deviceType', 'form', 'flavor', 'abi'].includes(key) && typeof value === 'string'));
    const selector = Object.keys(query).length ? parseProfileSelector(query) : null;
    res.json({ profiles: rows.filter(row => (!allowed || allowed.includes(String(row.id))) && (!selector || matchesSelector(row, selector))).map(row => profileJson(row)) });
  }));
  app.get('/api/admin/profiles', requireAuth, requireAdmin, route(async (_req, res) => {
    const { rows } = await pool.query(`SELECT p.*,COALESCE(p.allow_launch_overrides,s.allow_launch_overrides) AS launch_overrides_allowed FROM profiles p CROSS JOIN launch_settings s WHERE p.removed_at IS NULL AND p.id NOT LIKE 'device-%' ORDER BY p.name`);
    res.json({ profiles: rows.map(row => profileJson(row, true)) });
  }));
  app.post('/api/admin/profiles', requireAuth, requireAdmin, route(async (req, res) => {
    const p = parseProfile(req.body || {});
    const sealedEnv = await sealEnv(await getSecretBox(pool, context.config.secretsKey), p.containerEnv);
    try {
      const { rows } = await pool.query(
        `INSERT INTO profiles(id,name,android_version,image,cpu,memory_mb,guest_memory_mb,guest_cores,disk_gb,emulator_params,api_level,abi,device_model,resolution,image_flavor,device_type,image_tag,recommended,container_env,disk_max_gb,sdcard_gb,sdcard_max_gb,docker_options,allow_launch_overrides)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24) RETURNING *`,
        [p.id, p.name, p.androidVersion, p.image, p.cpu, p.memoryMb, p.guestMemoryMb, p.guestCores, p.diskGb, p.emulatorParams, p.apiLevel, p.abi, p.deviceModel, p.resolution, p.imageFlavor, p.deviceType, p.imageTag, p.recommended, sealedEnv, p.diskMaxGb, p.sdcardGb, p.sdcardMaxGb, p.dockerOptions, p.allowLaunchOverrides],
      );
      res.status(201).json({ profile: profileJson(rows[0], true) });
    } catch (error) {
      if ((error as { code?: string }).code === '23505') throw new ApiError(409, 'profile_exists', uiMessage('ui.8eb3aeb82264', {}, 'en'));
      throw error;
    }
  }));
  app.patch('/api/admin/profiles/:id', requireAuth, requireAdmin, route(async (req, res) => {
    const existing = await pool.query('SELECT * FROM profiles WHERE id=$1 AND removed_at IS NULL', [req.params.id]);
    if (!existing.rows[0]) throw new ApiError(404, 'not_found', uiMessage('ui.999930725d06', {}, 'en'));
    const old = profileJson(existing.rows[0], true);
    const p = parseProfile({ ...old, ...req.body, id: req.params.id }, { allowKeepEnv: true });
    let sealedEnv: Record<string, string>;
    try { sealedEnv = await sealEnv(await getSecretBox(pool, context.config.secretsKey), p.containerEnv, existing.rows[0].container_env); }
    catch { throw new ApiError(400, 'invalid_profile', uiMessage('ui.d0bc4c437233', {}, 'en')); }
    const enabled = req.body?.enabled == null ? old.enabled : req.body.enabled === true;
    const { rows } = await pool.query(
      `UPDATE profiles SET name=$2,android_version=$3,image=$4,cpu=$5,memory_mb=$6,guest_memory_mb=$7,guest_cores=$8,disk_gb=$9,emulator_params=$10,api_level=$11,abi=$12,device_model=$13,resolution=$14,image_flavor=$15,device_type=$16,image_tag=$17,recommended=$18,container_env=$19,disk_max_gb=$20,sdcard_gb=$21,sdcard_max_gb=$22,docker_options=$23,allow_launch_overrides=$24,enabled=$25
       WHERE id=$1 AND removed_at IS NULL RETURNING *`,
      [p.id, p.name, p.androidVersion, p.image, p.cpu, p.memoryMb, p.guestMemoryMb, p.guestCores, p.diskGb, p.emulatorParams, p.apiLevel, p.abi, p.deviceModel, p.resolution, p.imageFlavor, p.deviceType, p.imageTag, p.recommended, sealedEnv, p.diskMaxGb, p.sdcardGb, p.sdcardMaxGb, p.dockerOptions, p.allowLaunchOverrides, enabled],
    );
    if (!rows[0]) throw new ApiError(404, 'not_found', uiMessage('ui.999930725d06', {}, 'en'));
    res.json({ profile: profileJson(rows[0], true) });
  }));
  // Profiles as a manifest (variable values are never exported) and import from one: preview first, then apply.
  app.get('/api/admin/profiles/export', requireAuth, requireAdmin, route(async (_req, res) => {
    const { rows } = await pool.query(`SELECT p.*,COALESCE(p.allow_launch_overrides,s.allow_launch_overrides) AS launch_overrides_allowed FROM profiles p CROSS JOIN launch_settings s WHERE p.removed_at IS NULL AND p.id NOT LIKE 'device-%' ORDER BY p.name`);
    res.json(exportManifest(rows));
  }));
  app.post('/api/admin/profiles/import', requireAuth, requireAdmin, route(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const apply = body.apply === true, update = body.update === true;
    const { profiles: items, issues: topIssues } = parseManifest(body.manifest);
    const box = await getSecretBox(pool, config.secretsKey);
    const results: Array<{ id: string; name: string; action: 'create' | 'update' | 'skip' | 'invalid'; issues: ManifestIssue[]; warnings: string[] }> = [];
    const plan: Array<{ action: 'create' | 'update'; parsed: ReturnType<typeof parseProfile>; existing?: Record<string, unknown> }> = [];
    const seen = new Set<string>();
    for (const item of items) {
      const id = typeof item.input.id === 'string' ? item.input.id : '';
      const result = { id, name: typeof item.input.name === 'string' ? item.input.name : '', action: 'invalid' as 'create' | 'update' | 'skip' | 'invalid', issues: [...item.issues], warnings: [...item.warnings] };
      results.push(result);
      if (id && seen.has(id)) result.issues.push({ path: `$.profiles[${item.index}].id`, message: 'duplicate id in the manifest' });
      seen.add(id);
      const existing = id ? (await pool.query('SELECT * FROM profiles WHERE id=$1 AND removed_at IS NULL', [id])).rows[0] : undefined;
      if (existing && !update) { result.action = 'skip'; result.warnings.push('A profile with this id exists; it is left unchanged (enable "update existing" to change it).'); continue; }
      const checked = checkManifestProfile(item, Boolean(existing));
      if (checked.issue) result.issues.push(checked.issue);
      if (checked.parsed && existing) {
        const stored = (existing.container_env && typeof existing.container_env === 'object' ? existing.container_env : {}) as Record<string, unknown>;
        for (const [name, value] of Object.entries(checked.parsed.containerEnv)) if (value === null && typeof stored[name] !== 'string') result.issues.push({ path: `$.profiles[${item.index}].container.env.${name}`, message: 'null keeps a stored value, but none is stored; give a value' });
      }
      if (!result.issues.length && checked.parsed) { result.action = existing ? 'update' : 'create'; plan.push({ action: result.action, parsed: checked.parsed, existing }); }
    }
    const blocked = topIssues.length > 0 || results.some(item => item.issues.length > 0);
    if (!apply || blocked) { res.json({ applied: false, issues: topIssues, results }); return; }
    await transaction(pool, async client => {
      for (const { action, parsed: p, existing } of plan) {
        const sealed = await sealEnv(box, p.containerEnv, existing ? (existing.container_env as Record<string, unknown>) : {});
        const values = [p.id, p.name, p.androidVersion, p.image, p.cpu, p.memoryMb, p.guestMemoryMb, p.guestCores, p.diskGb, p.emulatorParams, p.apiLevel, p.abi, p.deviceModel, p.resolution, p.imageFlavor, p.deviceType, p.imageTag, p.recommended, sealed, p.diskMaxGb, p.sdcardGb, p.sdcardMaxGb, p.dockerOptions, p.allowLaunchOverrides];
        if (action === 'create') {
          // Imported profiles remain disabled until an administrator enables them.
          await client.query(
            `INSERT INTO profiles(id,name,android_version,image,cpu,memory_mb,guest_memory_mb,guest_cores,disk_gb,emulator_params,api_level,abi,device_model,resolution,image_flavor,device_type,image_tag,recommended,container_env,disk_max_gb,sdcard_gb,sdcard_max_gb,docker_options,allow_launch_overrides,enabled)
             VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,false)`, values);
        } else {
          await client.query(
            `UPDATE profiles SET name=$2,android_version=$3,image=$4,cpu=$5,memory_mb=$6,guest_memory_mb=$7,guest_cores=$8,disk_gb=$9,emulator_params=$10,api_level=$11,abi=$12,device_model=$13,resolution=$14,image_flavor=$15,device_type=$16,image_tag=$17,recommended=$18,container_env=$19,disk_max_gb=$20,sdcard_gb=$21,sdcard_max_gb=$22,docker_options=$23,allow_launch_overrides=$24
             WHERE id=$1`, values);
        }
      }
    });
    // One audit entry per profile: the manifest itself (which may contain secrets) is never logged.
    for (const item of plan) await recordAuditEvent(pool, { action: item.action === 'create' ? 'profile.imported' : 'profile.updated_by_import', actor: current(res).user, targetType: 'profile', targetId: item.parsed.id }).catch(() => {});
    res.json({ applied: true, issues: [], results });
  }));
  app.delete('/api/admin/profiles/:id', requireAuth, requireAdmin, route(async (req, res) => {
    const result = await pool.query('UPDATE profiles SET enabled=false WHERE id=$1 AND removed_at IS NULL RETURNING id', [req.params.id]);
    if (!result.rowCount) throw new ApiError(404, 'not_found', uiMessage('ui.999930725d06', {}, 'en'));
    res.json({ ok: true });
  }));

  app.delete('/api/admin/profiles/:id/permanent', requireAuth, requireAdmin, route(async (req, res) => {
    const profileId = req.params.id!;
    await transaction(pool, async client => {
      // Launch and queue creation take FOR SHARE on this row. Whichever commits first
      // either reserves use of the profile or makes it unavailable to the next request.
      const profile = await client.query(
        "SELECT id FROM profiles WHERE id=$1 AND removed_at IS NULL AND id NOT LIKE 'device-%' FOR UPDATE", [profileId]);
      if (!profile.rowCount) throw new ApiError(404, 'not_found', uiMessage('ui.999930725d06', {}, 'en'));
      const active = await client.query(
        `SELECT 1 FROM sessions s WHERE s.profile_id=$1 AND
          (s.state IN ('starting','running','stopping') OR EXISTS
            (SELECT 1 FROM host_slots hs WHERE hs.session_id=s.id)) LIMIT 1`, [profileId]);
      const queued = await client.query(
        `SELECT 1 FROM queue_entries WHERE profile_id=$1 AND
          (state='waiting' OR (state='assigned' AND resolved_at IS NULL)) LIMIT 1`, [profileId]);
      if (active.rowCount || queued.rowCount) throw new ApiError(409, 'profile_in_use',
        uiMessage('ui.fb04ee6b8f6d', {}, 'en'));
      await client.query('UPDATE profiles SET removed_at=now(),enabled=false,recommended=false WHERE id=$1', [profileId]);
    });
    res.json({ ok: true });
  }));

  app.get('/api/admin/users', requireAuth, requireAdmin, route(async (_req, res) => {
    const { rows } = await pool.query(
      `SELECT id,provider,subject,username,display_name AS "displayName",company,job_title AS "jobTitle",role,access_role_id AS "roleId",(SELECT name FROM access_roles WHERE id=users.access_role_id) AS "roleName",(SELECT builtin FROM access_roles WHERE id=users.access_role_id) AS "roleBuiltin",created_at AS "createdAt"
       FROM users WHERE provider!='system' AND removed_at IS NULL ORDER BY lower(display_name),lower(username),id`,
    );
    res.json({ users: rows });
  }));
  app.post('/api/admin/users', requireAuth, requireAdmin, route(async (req, res) => {
    if (config.authMode !== 'local') throw new ApiError(409, 'unsupported', uiMessage('ui.16aa1ace98b8', {}, 'en'));
    const username = boundedString(req.body?.username, 150);
    const displayName = profileField(req.body?.displayName ?? null) || username;
    const company = profileField(req.body?.company ?? null);
    const jobTitle = profileField(req.body?.jobTitle ?? null);
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    const role = req.body?.role === 'admin' ? 'admin' : 'user';
    const roleId = req.body?.roleId === undefined ? (role === 'admin' ? '00000000-0000-4000-8000-000000000001' : '00000000-0000-4000-8000-000000000002') : String(req.body.roleId);
    if (!isUuid(roleId)) throw new ApiError(400, 'invalid_role', uiMessage('roles.invalid'));
    if (roleId !== '00000000-0000-4000-8000-000000000002') assertPermission(current(res).user, 'roles.manage');
    if (!/^[A-Za-z0-9._@-]{3,150}$/.test(username) || password.length < 12 || password.length > 2048) {
      throw new ApiError(400, 'invalid_user', uiMessage('ui.4dbf168d317f', {}, 'en'));
    }
    try {
      const { rows } = await transaction(pool, async client => {
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['access-roles']);
        await assertStoredPermission(client, current(res).user.id, 'users.manage');
        const actorRole = await roleForUser(client, current(res).user.id);
        if (roleId !== '00000000-0000-4000-8000-000000000002') await assertStoredPermission(client, current(res).user.id, 'roles.manage');
        const target = (await client.query('SELECT builtin,permissions FROM access_roles WHERE id=$1 FOR SHARE', [roleId])).rows[0];
        if (!target) throw new ApiError(400, 'invalid_role', uiMessage('roles.notFound'));
        const targetPermissions: string[] = target.builtin === 'admin' ? allPermissions : target.permissions;
        if (!actorRole?.permissions.includes('roles.manage') && targetPermissions.some(p => !actorRole?.permissions.includes(p))) throw new ApiError(403, 'permission_denied', uiMessage('roles.permissionDenied'));
        return client.query(
        `INSERT INTO users(id,provider,subject,username,display_name,password_hash,role,company,job_title,access_role_id)
         VALUES($1,'local',$2,$2,$3,$4,$5,$6,$7,$8) RETURNING id,provider,username,display_name AS "displayName",company,job_title AS "jobTitle",role,created_at AS "createdAt"`,
        [randomUUID(), username, displayName, await hashPassword(password), role, company, jobTitle, roleId],
        );
      });
      res.status(201).json({ user: rows[0] });
    } catch (error) {
      if ((error as { code?: string }).code === '23505') throw new ApiError(409, 'user_exists', uiMessage('ui.1f8d96843636', {}, 'en'));
      throw error;
    }
  }));

  app.patch('/api/admin/users/:id', requireAuth, requireAdmin, route(async (req, res) => {
    const userId = req.params.id!;
    if (!isUuid(userId)) throw new ApiError(400, 'invalid_user', uiMessage('ui.d443b8d06e43', {}, 'en'));
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body) || !Object.keys(body).length ||
        Object.keys(body).some(key => !['displayName', 'company', 'jobTitle'].includes(key))) {
      throw new ApiError(400, 'invalid_profile', uiMessage('ui.914bd6ced3cd', {}, 'en'));
    }
    const user = await transaction(pool, async client => {
      const existing = await client.query('SELECT * FROM users WHERE id=$1 AND removed_at IS NULL FOR UPDATE', [userId]);
      const previous = existing.rows[0];
      if (!previous || previous.provider === 'system') throw new ApiError(404, 'not_found', uiMessage('ui.4a1793e9900c', {}, 'en'));
      if (previous.provider !== 'local') {
        throw new ApiError(409, 'managed_profile', uiMessage('ui.fe0bd04ee13c', {}, 'en'));
      }
      const displayName = body.displayName === undefined ? previous.display_name : profileField(body.displayName);
      if (!displayName) throw new ApiError(400, 'invalid_profile', uiMessage('ui.cf2a4b885260', {}, 'en'));
      const company = body.company === undefined ? previous.company : profileField(body.company);
      const jobTitle = body.jobTitle === undefined ? previous.job_title : profileField(body.jobTitle);
      const { rows } = await client.query(
        'UPDATE users SET display_name=$2,company=$3,job_title=$4 WHERE id=$1 ' +
        'RETURNING id,provider,username,display_name AS "displayName",company,job_title AS "jobTitle",role,created_at AS "createdAt"',
        [userId, displayName, company, jobTitle],
      );
      return rows[0];
    });
    res.json({ user });
  }));

  app.delete('/api/admin/users/:id', requireAuth, requireAdmin, route(async (req, res) => {
    const userId = req.params.id!;
    if (!isUuid(userId)) throw new ApiError(400, 'invalid_user', uiMessage('ui.6674028f9de8'));
    await removeUser(pool, userId, current(res).user.id);
    res.json({ ok: true });
  }));

  app.post('/api/admin/users/:id/password', requireAuth, requireAdmin, route(async (req, res) => {
    const userId = req.params.id!;
    if (!isUuid(userId)) throw new ApiError(400, 'invalid_user', uiMessage('ui.6674028f9de8'));
    if (config.authMode !== 'local') {
      throw new ApiError(409, 'managed_password', uiMessage('ui.2d35f152f918'));
    }
    const body = req.body;
    const password = body?.newPassword;
    if (!body || typeof body !== 'object' || Array.isArray(body) ||
        Object.keys(body).some(key => key !== 'newPassword') ||
        typeof password !== 'string' || password.length < 12 || password.length > 2048) {
      throw new ApiError(400, 'invalid_password', uiMessage('ui.b2c4510d6212'));
    }
    await transaction(pool, async client => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['access-roles']);
      await assertStoredPermission(client, current(res).user.id, 'users.password');
      const actorRole = await roleForUser(client, current(res).user.id);
      const { rows } = await client.query('SELECT provider FROM users WHERE id=$1 AND removed_at IS NULL FOR UPDATE', [userId]);
      if (!rows[0] || rows[0].provider === 'system') throw new ApiError(404, 'not_found', uiMessage('ui.8ef54e373b98'));
      if (rows[0].provider !== 'local') {
        throw new ApiError(409, 'managed_password', uiMessage('ui.c23b76a51dd6'));
      }
      const targetRole = await roleForUser(client, userId);
      if (targetRole?.permissions.some(p => !actorRole?.permissions.includes(p)) && !actorRole?.permissions.includes('roles.manage')) throw new ApiError(403, 'permission_denied', uiMessage('roles.permissionDenied'));
      await client.query('UPDATE users SET password_hash=$2 WHERE id=$1', [userId, await hashPassword(password)]);
      await client.query('DELETE FROM browser_sessions WHERE user_id=$1', [userId]);
    });
    const actor = current(res);
    // As with self-service rotation, renew only the initiating browser's login.
    if (actor.user.id === userId && actor.via === 'cookie') await auth.createSession(userId, res);
    res.json({ ok: true });
  }));

  function tokenItem(row: Record<string, unknown>) {
    return {
      id: String(row.id), name: String(row.name), kind: String(row.kind),
      createdAt: new Date(String(row.created_at)).toISOString(),
      expiresAt: row.expires_at ? new Date(String(row.expires_at)).toISOString() : null,
      lastUsedAt: row.last_used_at ? new Date(String(row.last_used_at)).toISOString() : null,
    };
  }
  async function createApiToken(res: Response, body: Record<string, unknown>, kind: 'personal' | 'system') {
    const name = boundedString(body.name, 100);
    const days = body.expiresInDays == null ? null : Number(body.expiresInDays);
    if (!name || (days !== null && (!Number.isInteger(days) || days < 1 || days > 365))) throw new ApiError(400, 'invalid_token', uiMessage('ui.a95c350fb004', {}, 'en'));
    const raw = `rdf_${newToken()}`;
    const ownerId = kind === 'personal' ? current(res).user.id : null;
    const expires = days == null ? null : new Date(Date.now() + days * 86_400_000);
    const { rows } = await pool.query(
      `INSERT INTO api_tokens(id,owner_user_id,kind,name,token_hash,expires_at)
       VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,
      [randomUUID(), ownerId, kind, name, tokenHash(raw), expires],
    );
    res.status(201).json({ token: raw, item: tokenItem(rows[0]) });
  }
  app.get('/api/tokens', requireAuth, route(async (_req, res) => {
    const { rows } = await pool.query(`SELECT * FROM api_tokens WHERE kind='personal' AND owner_user_id=$1 ORDER BY created_at DESC`, [current(res).user.id]);
    res.json({ tokens: rows.map(tokenItem) });
  }));
  app.post('/api/tokens', requireAuth, route(async (req, res) => {
    await createApiToken(res, req.body || {}, 'personal');
  }));
  app.delete('/api/tokens/:id', requireAuth, route(async (req, res) => {
    const result = await pool.query(`DELETE FROM api_tokens WHERE id=$1 AND kind='personal' AND owner_user_id=$2`, [req.params.id, current(res).user.id]);
    if (!result.rowCount) throw new ApiError(404, 'not_found', uiMessage('ui.4441b4b45947', {}, 'en'));
    res.json({ ok: true });
  }));
  app.get('/api/admin/tokens', requireAuth, requireAdmin, route(async (_req, res) => {
    const { rows } = await pool.query(`SELECT * FROM api_tokens WHERE kind='system' ORDER BY created_at DESC`);
    res.json({ tokens: rows.map(tokenItem) });
  }));
  app.post('/api/admin/tokens', requireAuth, requireAdmin, route(async (req, res) => {
    await createApiToken(res, req.body || {}, 'system');
  }));
  app.delete('/api/admin/tokens/:id', requireAuth, requireAdmin, route(async (req, res) => {
    const result = await pool.query(`DELETE FROM api_tokens WHERE id=$1 AND kind='system'`, [req.params.id]);
    if (!result.rowCount) throw new ApiError(404, 'not_found', uiMessage('ui.4441b4b45947', {}, 'en'));
    res.json({ ok: true });
  }));
  async function agentBundle(): Promise<{ bytes: Buffer; filename: string; version: string; sha256: string }> {
    const directory = path.resolve(process.cwd(), 'agent-bundle');
    try {
      const version = (await readFile(path.join(directory, 'version.txt'), 'utf8')).trim();
      const sha256 = (await readFile(path.join(directory, 'sha256.txt'), 'utf8')).trim();
      if (!/^[A-Za-z0-9._-]{1,80}$/.test(version) || !/^[a-f0-9]{64}$/.test(sha256)) {
        throw new Error('Invalid agent bundle manifest');
      }
      const filename = `rdf-linux-agent-${version}.tar.gz`;
      const bytes = await readFile(path.join(directory, filename));
      if (createHash('sha256').update(bytes).digest('hex') !== sha256) throw new Error('Agent bundle checksum mismatch');
      return { bytes, filename, version, sha256 };
    } catch {
      throw new ApiError(503, 'agent_bundle_unavailable', uiMessage('ui.4099726074e3', {}, 'en'));
    }
  }
  app.get('/api/admin/agent-bundle/info', requireAuth, requireAdmin, route(async (_req, res) => {
    const bundle = await agentBundle();
    res.json({ version: bundle.version, filename: bundle.filename,
      sha256: bundle.sha256, sizeBytes: bundle.bytes.length });
  }));
  app.get('/api/admin/agent-bundle', requireAuth, requireAdmin, route(async (_req, res) => {
    const bundle = await agentBundle();
    res.set('Content-Disposition', `attachment; filename="${bundle.filename}"`);
    res.set('Cache-Control', 'no-store');
    res.set('X-Content-Type-Options', 'nosniff');
    res.type('application/gzip').send(bundle.bytes);
  }));
  app.get('/api/admin/agents', requireAuth, requireAdmin, route(async (_req, res) => {
    res.json({ agents: await listAgentInventory(pool, config.bootstrapAgentId) });
  }));
  app.post('/api/admin/agents', requireAuth, requireAdmin, route(async (req, res) => {
    const hostId = boundedString(req.body?.hostId, 100);
    if (!/^[A-Za-z0-9._-]{1,100}$/.test(hostId)) throw new ApiError(400, 'invalid_agent', uiMessage('ui.d9cca14d5ca8', {}, 'en'));
    const raw = `rdfagent_${newToken()}`;
    const agent = await transaction(pool, async client => {
      await assertAgentCredentialChangeAllowed(client, hostId);
      const { rows } = await client.query(
        `INSERT INTO agent_credentials(host_id,token_hash) VALUES($1,$2)
         ON CONFLICT(host_id) DO UPDATE SET token_hash=EXCLUDED.token_hash,created_at=now()
         RETURNING host_id AS "hostId",created_at AS "createdAt"`,
        [hostId, tokenHash(raw)]);
      return rows[0];
    });
    hub.disconnectHost(hostId);
    res.status(201).json({ token: raw, agent });
  }));
  app.delete('/api/admin/agents/:hostId', requireAuth, requireAdmin, route(async (req, res) => {
    const hostId = req.params.hostId!;
    await transaction(pool, async client => {
      await assertAgentCredentialChangeAllowed(client, hostId);
      const result = await client.query('DELETE FROM agent_credentials WHERE host_id=$1', [hostId]);
      if (!result.rowCount) throw new ApiError(404, 'not_found', uiMessage('ui.694129fcc6f3', {}, 'en'));
    });
    hub.disconnectHost(hostId);
    res.json({ ok: true });
  }));

}
