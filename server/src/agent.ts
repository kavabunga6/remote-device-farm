import { normalizeProviderStatuses } from './generated/device-contract.js';
import { AgentRequests } from './agent-requests.js';
import { ApiError } from './http-common.js';
import { uiMessage } from './messages.js';
import { emitServiceLog, recordServiceLog, sessionLog } from './service-log.js';
import { randomUUID } from 'node:crypto';
import { INPUT_MAX_AGE_MS, readInputMetadata, StreamInputError, type InputMetadata } from './stream-input.js';
import type { Socket } from 'node:net';
import WebSocket from 'ws';
import type { Pool } from 'pg';
import { transaction } from './db.js';
import { desiredNodePolicy } from './node-policy.js';
import { recordAuditEvent } from './audit.js';
import { notifyAdmins, notifySessionReady, notifyUser } from './notifications.js';
import { parseActiveSessions, cleanAgentMetrics, cleanProviderCapabilities, type ActiveSessionReport } from './agent-report.js';
import { physicalDevicesFromProviders } from './physical-devices.js';
import { cleanStartupProgress, storedStartupProgress, START_CANCEL_TIMEOUT_MS, type StartupStage } from './startup-progress.js';

type Tunnel = { socket: WebSocket; sessionId: string; hostId: string };
type DeviceTunnel = { socket: Socket; sessionId: string; hostId: string };
type AgentLink = { ws: WebSocket; hostId: string; lastHeartbeat: number; policyVersion: number; preparingSessions: Set<string> };
const MAX_RELAY_BUFFER = 4 * 1024 * 1024;
const MAX_TUNNELS_PER_SESSION = 8;
const MAX_TUNNELS_PER_HOST = 32;
const MAX_TUNNELS_TOTAL = 64;
const MAX_VIEWERS_PER_SESSION = 8;
const MAX_VIEWERS_TOTAL = 128;
const MAX_VIEWER_MEDIA_BUFFER = 256 * 1024;

export class AgentHub {
  private readonly maintenanceLogs = new Map<string, { hostId: string; owner: Promise<boolean>; writes: Promise<void>; count: number }>();
  private readonly agents = new Map<string, AgentLink>();
  private readonly seenAlerts = new Set<string>();
  private readonly pending = new AgentRequests();
  private readonly locallyStartedSessions = new Set<string>();
  private readonly cancellationInFlight = new Set<string>();
  private readonly viewers = new Map<string, Set<WebSocket>>();
  private readonly viewersWaitingForKeyframe = new WeakSet<WebSocket>();
  private readonly lastKeyframeRequest = new Map<string, number>();
  private readonly viewerTransports = new WeakMap<WebSocket, 'webrtc' | 'websocket'>();
  private readonly inputViewers = new WeakMap<WebSocket, { epoch: string; sequence: number; clockOffset: number; active: boolean }>();
  private readonly streamStopTimers = new Map<string, NodeJS.Timeout>();
  private readonly viewerDrainPolls = new WeakMap<WebSocket, NodeJS.Timeout>();
  private readonly tunnels = new Map<string, Tunnel>();
  private readonly deviceTunnels = new Map<string, DeviceTunnel>();
  private readonly sessionClosedListeners = new Set<(sessionId: string) => void>();
  private readonly sessionHosts = new Map<string, string>();
  private readonly policyRefreshInFlight = new Map<string, AgentLink>();
  private readonly policyRetryAfter = new Map<string, number>();

  private readonly staleTimer: NodeJS.Timeout;
  private readonly agentSockets = new Map<WebSocket, NodeJS.Timeout>();
  private readonly agentTasks = new Set<Promise<void>>();
  private stopped = false;
  private stopping?: Promise<void>;

  constructor(private readonly pool: Pool) {
    this.staleTimer = setInterval(() => this.closeStaleAgents(), 15_000);
    this.staleTimer.unref();
  }

  private trackAgentTask(task: Promise<void>): void {
    this.agentTasks.add(task);
    void task.then(() => this.agentTasks.delete(task), () => this.agentTasks.delete(task));
  }

  dispose(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.stopped = true;
    clearInterval(this.staleTimer);
    for (const timer of this.streamStopTimers.values()) clearTimeout(timer);
    this.streamStopTimers.clear();
    const sockets = new Set([...this.agentSockets.keys(), ...[...this.agents.values()].map(link => link.ws)]);
    for (const timer of this.agentSockets.values()) clearTimeout(timer);
    this.agentSockets.clear();
    this.agents.clear();
    this.pending.rejectWhere(() => true, new Error('server shutting down'));
    for (const viewers of this.viewers.values()) for (const viewer of viewers) {
      this.clearViewerDrainPoll(viewer);
      sockets.add(viewer);
    }
    for (const tunnel of this.tunnels.values()) sockets.add(tunnel.socket);
    for (const tunnel of this.deviceTunnels.values()) tunnel.socket.destroy();
    this.viewers.clear();
    this.tunnels.clear();
    this.deviceTunnels.clear();
    this.sessionClosedListeners.clear();
    this.sessionHosts.clear();
    this.locallyStartedSessions.clear();
    this.lastKeyframeRequest.clear();
    this.policyRefreshInFlight.clear();
    this.policyRetryAfter.clear();
    for (const socket of sockets) socket.terminate();
    this.stopping = Promise.allSettled([...this.agentTasks]).then(() => {});
    return this.stopping;
  }

  attachAgent(ws: WebSocket, expectedHostId: string): void {
    if (this.stopped) { ws.terminate(); return; }
    let link: AgentLink | undefined;
    const helloTimer = setTimeout(() => { if (!link) ws.close(1008, 'hello required'); }, 10_000);
    this.agentSockets.set(ws, helloTimer);
    ws.on('message', raw => {
      if (this.stopped) return;
      if (typeof raw === 'string' || Buffer.isBuffer(raw)) {
        let message: Record<string, unknown>;
        try { message = JSON.parse(raw.toString()) as Record<string, unknown>; }
        catch { ws.close(1003, 'invalid JSON'); return; }
        this.trackAgentTask(this.onAgentMessage(ws, expectedHostId, message, value => { link = value; clearTimeout(helloTimer); }).catch(() => {
          emitServiceLog(this.pool, { service: 'server', severity: 'error', code: 'agent.message_failed', hostId: expectedHostId });
          ws.close(1011, 'agent message failed');
        }));
      }
    });
    ws.on('close', () => {
      clearTimeout(helloTimer);
      this.agentSockets.delete(ws);
      if (link && !this.stopped) this.trackAgentTask(this.agentClosed(link).catch(() => {}));
    });
    ws.on('error', () => {});
  }

  private async onAgentMessage(ws: WebSocket, expectedHostId: string, message: Record<string, unknown>, setLink: (link: AgentLink) => void): Promise<void> {
    if (message.type === 'hello') {
      const hostId = String(message.hostId || '');
      const name = String(message.name || hostId);
      const slots = Number(message.slots);
      if (hostId !== expectedHostId || !/^[A-Za-z0-9._-]{1,100}$/.test(hostId) || !name || name.length > 120 || !Number.isInteger(slots) || slots < 0 || slots > 256) {
        ws.close(1008, 'invalid hello'); return;
      }
      const existing = this.agents.get(hostId);
      if (existing && existing.ws !== ws) existing.ws.close(1012, 'replaced');
      const metrics = cleanAgentMetrics(message.metrics);
      const policyVersion = message.policyVersion === 1 ? 1 : 0;
      await transaction(this.pool, async client => {
        await client.query(
          `INSERT INTO hosts(id,name,status,slots,metrics,last_seen_at,agent_policy_version,applied_policy_revision) VALUES($1,$2,'online',$3,$4,now(),$5,-1)
           ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,status='online',slots=EXCLUDED.slots,metrics=EXCLUDED.metrics,last_seen_at=now(),agent_policy_version=EXCLUDED.agent_policy_version,applied_policy_revision=-1`,
          [hostId, name, policyVersion ? 0 : slots, metrics, policyVersion],
        );
        await client.query(
          `INSERT INTO host_slots(host_id,slot_index)
           SELECT $1, generate_series(0,$2-1) ON CONFLICT DO NOTHING`,
          [hostId, policyVersion ? 0 : slots],
        );
      });
      await this.storeDevices(hostId, message.providers);
      if (this.stopped || ws.readyState >= WebSocket.CLOSING) return;
      const link = { ws, hostId, lastHeartbeat: Date.now(), policyVersion, preparingSessions: new Set<string>() };
      this.agents.set(hostId, link);
      // A brief transport reconnect must not cancel a long preparation already running on this node.
      for (const pending of this.pending.values()) if (pending.action === 'start' && pending.hostId === hostId) pending.ws = ws;
      this.policyRefreshInFlight.delete(hostId);
      this.policyRetryAfter.delete(hostId);
      setLink(link);
      emitServiceLog(this.pool, { service: 'server', severity: 'info', code: 'agent.connected', hostId });
      ws.send(JSON.stringify({ type: 'welcome', hostId }));
      if (Array.isArray(message.sessionDiagnostics)) for (const event of message.sessionDiagnostics.slice(0, 4000)) {
        if (!event || typeof event !== 'object') continue;
        await this.onAgentMessage(ws, hostId, { type: 'session-log', sessionId: (event as Record<string, unknown>).sessionId, event }, setLink);
      }
      await this.flushMaintenanceLogs(hostId);
      if (policyVersion) this.schedulePolicyApply(link, 'apply');
      if (Array.isArray(message.activeSessions)) {
        const reported = parseActiveSessions(message.activeSessions);
        link.preparingSessions = new Set([...reported].filter(([, item]) => item.preparing).map(([id]) => id));
        const known = await this.pool.query(`SELECT id,state FROM sessions WHERE host_id=$1 AND state IN ('starting','running','stopping')`, [hostId]);
        const knownIds = new Set<string>();
        for (const row of known.rows) {
          knownIds.add(row.id);
          if (row.state === 'stopping') continue; // Reconciled below, never treated as an orphan.
          if (reported.has(row.id)) {
            const active = reported.get(row.id)!;
            await this.storeSessionCapabilities(row.id, active);
            if (active.preparing) { await this.releaseStaleStartingSession(row.id); continue; }
            if (row.state === 'starting' && this.hasPendingStart(row.id)) {
              this.completeRecoveredStart(link, row.id, active);
              continue;
            }
            await this.pool.query(
              `UPDATE sessions SET state='running',container_id=COALESCE(NULLIF($2,''),container_id),
               network_enabled=COALESCE($3,network_enabled),started_at=COALESCE(started_at,now())
               WHERE id=$1 AND state IN ('starting','running')`, [row.id, active.containerId, active.networkEnabled],
            );
            if (row.state === 'starting') await notifySessionReady(this.pool, row.id);
            await sessionLog(this.pool, hostId, row.id, 'session.recovered', uiMessage('ui.3e2bc70e11d4') + active.containerId);
            this.refreshStream(row.id, hostId);
          } else if (row.state === 'running') {
            await sessionLog(this.pool, hostId, row.id, 'session.container_missing', uiMessage('ui.69004b7318ca'), 'error');
            await this.releaseSession(row.id, 'running');
          } else {
            await this.releaseStaleStartingSession(row.id);
          }
        }
        for (const sessionId of reported.keys()) {
          if (!knownIds.has(sessionId)) void this.command(hostId, sessionId, 'kill', {}, START_CANCEL_TIMEOUT_MS).catch(() => {});
        }
      }
      // A reconnect must finish any stop that was accepted before the agent went away.
      const pendingStops = await this.pool.query(`SELECT id FROM sessions WHERE host_id=$1 AND state='stopping'`, [hostId]);
      for (const row of pendingStops.rows) {
        this.stopSession(hostId, row.id, true);
      }
      return;
    }

    const link = [...this.agents.values()].find(item => item.ws === ws);
    if (!link) { ws.close(1008, 'hello required'); return; }
    if (message.type === 'heartbeat') {
      if (message.hostId !== link.hostId) { ws.close(1008, 'host mismatch'); return; }
      const slots = Number(message.slots);
      if (!Number.isInteger(slots) || slots < 0 || slots > 256) { ws.close(1008, 'invalid slots'); return; }
      const metrics = cleanAgentMetrics(message.metrics);
      // A valid heartbeat proves liveness before potentially slow log storage.
      link.lastHeartbeat = Date.now();
      await this.flushMaintenanceLogs(link.hostId);
      await this.storeDevices(link.hostId, message.providers);
      const revision = Number(message.policyRevision);
      const hostRow = await transaction(this.pool, async client => {
        const updated = await client.query(
          `UPDATE hosts SET status='online',
           slots=CASE WHEN NOT $4::boolean THEN $2 ELSE slots END,
           metrics=$3,last_seen_at=now() WHERE id=$1 RETURNING *`,
          [link.hostId, slots, metrics, link.policyVersion === 1],
        );
        await client.query(`INSERT INTO host_slots(host_id,slot_index) SELECT $1, generate_series(0,$2-1) ON CONFLICT DO NOTHING`, [link.hostId, Number(updated.rows[0]?.slots ?? 0)]);
        return updated.rows[0] as Record<string, unknown> | undefined;
      });
      if (link.policyVersion && hostRow) {
        const desired = desiredNodePolicy(hostRow);
        if (revision !== desired.revision || slots !== desired.slots ||
            Number(hostRow.applied_policy_revision) !== desired.revision) {
          this.schedulePolicyApply(link, 'refresh');
        }
      }
      if (Array.isArray(message.activeSessions)) {
        const active = parseActiveSessions(message.activeSessions);
        const previouslyPreparing = link.preparingSessions;
        link.preparingSessions = new Set([...active].filter(([, item]) => item.preparing).map(([id]) => id));
        const sessions = await this.pool.query(`SELECT id,state FROM sessions WHERE host_id=$1 AND state IN ('starting','running','stopping')`, [link.hostId]);
        const knownIds = new Set<string>();
        for (const row of sessions.rows) {
          knownIds.add(row.id);
          if (row.state === 'stopping') {
            // Missing containers alone are not a cancellation acknowledgement: preparation may still own the slot.
            this.stopSession(link.hostId, row.id, true);
            continue;
          }
          if (!active.has(row.id)) {
            if (row.state === 'running') await this.releaseSession(row.id, 'running');
            else await this.releaseStaleStartingSession(row.id);
          } else {
            const reported = active.get(row.id)!;
            await this.storeSessionCapabilities(row.id, reported);
            if (reported.preparing) { await this.releaseStaleStartingSession(row.id); continue; }
            if (row.state === 'starting') {
              if (this.hasPendingStart(row.id)) {
                this.completeRecoveredStart(link, row.id, reported);
                continue;
              }
              const updated = await this.pool.query(
                `UPDATE sessions SET state='running',container_id=COALESCE(NULLIF($2,''),container_id),
                 network_enabled=COALESCE($3,network_enabled),started_at=COALESCE(started_at,now())
                 WHERE id=$1 AND state='starting' RETURNING id`,
                [row.id, reported.containerId, reported.networkEnabled],
              );
              if (updated.rowCount) {
                await notifySessionReady(this.pool, row.id);
                this.refreshStream(row.id, link.hostId);
              }
            } else {
              if (reported.networkEnabled !== null) await this.pool.query(
                `UPDATE sessions SET network_enabled=$2 WHERE id=$1`, [row.id, reported.networkEnabled],
              );
              // A viewer may reconnect before an agent-recovered running device
              // finishes its boot probe. Its rejected stream-start is not retried
              // by the open viewer socket, so resume it on this ready transition.
              if (previouslyPreparing.has(row.id) && reported.bootReady) this.refreshStream(row.id, link.hostId);
            }
          }
        }
        // A container that appeared after the start record was released must not
        // keep consuming host resources outside the broker's session table.
        for (const sessionId of active.keys()) {
          if (!knownIds.has(sessionId)) void this.command(link.hostId, sessionId, 'kill', {}, START_CANCEL_TIMEOUT_MS).catch(() => {});
        }
      }
      return;
    }
    if (message.type === 'device-alert') {
      await this.onDeviceAlert(ws, link.hostId, message);
      return;
    }
    if (message.type === 'session-log') {
      const pending = this.pending.get(String(message.requestId || ''));
      const sessionId = typeof message.sessionId === 'string' ? message.sessionId : '';
      const event = message.event as Record<string, unknown> | undefined;
      if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(sessionId) ||
          !event || typeof event.message !== 'string' || event.message.length > 4096 ||
          typeof event.code !== 'string' || !/^(session|container)\.[a-z0-9_.-]{1,64}$/.test(event.code) ||
          !['info', 'warning', 'error'].includes(String(event.severity)) || !['agent', 'emulator'].includes(String(event.service))) return;
      const write = () => sessionLog(this.pool, link.hostId, sessionId, event.code as `session.${string}` | `container.${string}`,
        event.message as string, event.severity as 'info' | 'warning' | 'error', event.service as 'agent' | 'emulator');
      if (!pending) {
        // Unsolicited diagnostics cover automatic cleanup and recovery. Bind them to this
        // authenticated host's current lease or retained rental, including after deletion.
        if (message.requestId !== undefined) return;
        const key = link.hostId + ':' + sessionId;
        let state = this.maintenanceLogs.get(key);
        if (!state) {
          const owner = this.pool.query('SELECT id FROM sessions WHERE id=$1 AND host_id=$2', [sessionId, link.hostId])
            .then(async result => Boolean(result.rowCount) || Boolean((await this.pool.query('SELECT id FROM rental_history WHERE session_id=$1 AND host_id=$2 LIMIT 1', [sessionId, link.hostId])).rowCount)).catch(() => false);
          state = { hostId: link.hostId, owner, writes: Promise.resolve(), count: 0 }; this.maintenanceLogs.set(key, state);
        }
        if (state.count++ > 4500) return;
        state.writes = state.writes.then(async () => { if (await state!.owner) await write(); });
        this.trackAgentTask(state.writes);
        return;
      }
      if (pending.ws !== ws || pending.hostId !== link.hostId || pending.sessionId !== sessionId ||
          !['start', 'stop', 'kill'].includes(pending.action)) return;
      if (/^container\.(stdout|stderr)$/.test(event.code)) {
        if ((pending.diagnosticCount ?? 0) >= 4000) {
          if (pending.diagnosticCount === 4000) {
            pending.diagnosticCount++;
            pending.diagnosticWrites = (pending.diagnosticWrites ?? Promise.resolve()).then(() => sessionLog(this.pool, link.hostId, sessionId, 'container.output_limited', uiMessage('ui.56bae39642e5'), 'warning'));
            this.trackAgentTask(pending.diagnosticWrites);
          }
          return;
        }
        pending.diagnosticCount = (pending.diagnosticCount ?? 0) + 1;
      }
      pending.diagnosticWrites = (pending.diagnosticWrites ?? Promise.resolve()).then(write);
      this.trackAgentTask(pending.diagnosticWrites);
      return;
    }
    if (message.type === 'startup-progress') {
      const requestId = typeof message.requestId === 'string' ? message.requestId : '';
      const pending = this.pending.get(requestId);
      const sessionId = typeof message.sessionId === 'string' ? message.sessionId : '';
      const now = Date.now();
      const progress = cleanStartupProgress(message.progress, now);
      if (!progress) return;
      let previousStage: StartupStage | undefined;
      let previousAt = 0;
      if (pending) {
        if (pending.ws !== ws || pending.action !== 'start' || pending.hostId !== link.hostId || pending.sessionId !== sessionId) return;
        previousStage = pending.progressStage; previousAt = pending.progressWrittenAt ?? 0;
      } else {
        // After a broker restart the agent still owns its original start RPC. Recover only an
        // explicitly reported preparation on this authenticated connection and its live DB lease.
        // Requests issued by this process must never bypass their normal RPC binding, even after settling.
        const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
        if (!uuid.test(requestId) || !uuid.test(sessionId) || this.locallyStartedSessions.has(sessionId) ||
            !link.preparingSessions.has(sessionId) || now - link.lastHeartbeat > 45_000) return;
        const recovered = await this.pool.query(
          "SELECT startup_progress FROM sessions WHERE id=$1 AND host_id=$2 AND state='starting' AND startup_deadline_at > now()",
          [sessionId, link.hostId]);
        if (!recovered.rowCount || this.agents.get(link.hostId) !== link) return;
        const previous = storedStartupProgress(recovered.rows[0].startup_progress);
        previousStage = previous?.stage; previousAt = previous ? Date.parse(previous.updatedAt) : 0;
      }
      if (previousStage === progress.stage && previousAt > now - 750) return;
      if (pending && (previousStage !== progress.stage || now - (pending.progressLoggedAt ?? 0) > 15_000)) {
        pending.progressLoggedAt = now;
        const labels = { checking_image: uiMessage('ui.814d5c2acd76'), waiting_image: uiMessage('ui.62ebb1360547'),
          downloading: uiMessage('ui.30c7ae7079e1'), creating: uiMessage('ui.4dfa4c1c204a'), booting: uiMessage('ui.511ecf396a50'), ready: uiMessage('ui.ad0b444760b8') };
        pending.diagnosticWrites = (pending.diagnosticWrites ?? Promise.resolve()).then(() => sessionLog(this.pool,
          link.hostId, sessionId, 'session.' + progress.stage as `session.${string}`, labels[progress.stage] +
          (progress.percent == null ? '' : ': ' + progress.percent + '%'), 'info', 'agent'));
        this.trackAgentTask(pending.diagnosticWrites);
      }
      // Stage changes are immediately visible; only repeated samples within one stage are throttled.
      if (pending) { pending.progressWrittenAt = now; pending.progressStage = progress.stage; }
      await this.pool.query(
        "UPDATE sessions SET startup_progress=$3 WHERE id=$1 AND host_id=$2 AND state='starting' AND ($4::boolean OR startup_deadline_at > now())",
        [sessionId, link.hostId, progress, Boolean(pending)]);
      return;
    }
    if (message.type === 'result') {
      const id = String(message.id || '');
      const pending = this.pending.get(id);
      if (!pending || pending.ws !== ws) return;
      this.pending.take(id);
      await pending.diagnosticWrites;
      if (message.ok === true) pending.resolve((message.data && typeof message.data === 'object') ? message.data as Record<string, unknown> : {});
      else pending.reject(typeof message.code === 'string' && message.code.startsWith('input_')
        ? new StreamInputError(message.code, String(message.error || 'Input rejected'))
        : message.code === 'device_capability_unavailable'
          ? new ApiError(409, message.code, uiMessage('api.device_capability_unavailable', {}, 'en'))
          : new Error(String(message.error || 'agent rejected command')));
      return;
    }
    if (['frame', 'video-config', 'video-frame', 'audio-config', 'audio-frame', 'audio-unavailable'].includes(String(message.type))) {
      const sessionId = String(message.sessionId || '');
      if (!await this.belongsToHost(sessionId, link.hostId)) return;
      if (message.type === 'audio-unavailable') await this.pool.query('UPDATE sessions SET audio_enabled=false WHERE id=$1', [sessionId]);
      if (typeof message.data === 'string' && message.data.length > 12_000_000) return;
      const viewers = this.viewers.get(sessionId);
      if (!viewers?.size) return;
      const json = JSON.stringify(message);
      for (const viewer of viewers) {
        if (viewer.readyState !== WebSocket.OPEN) continue;
        if (this.viewerTransports.get(viewer) === 'webrtc' &&
            (['frame', 'video-frame'].includes(String(message.type)) || (message.type === 'audio-frame' && message.codec === 'opus'))) continue;
        if (message.type === 'video-frame') {
          if (viewer.bufferedAmount > MAX_VIEWER_MEDIA_BUFFER) {
            this.viewersWaitingForKeyframe.add(viewer);
            this.scheduleKeyframeOnDrain(sessionId, link.hostId, viewer);
            continue;
          }
          if (this.viewersWaitingForKeyframe.has(viewer) && message.keyframe !== true) {
            this.requestKeyframe(sessionId, link.hostId, viewer);
            continue;
          }
          if (message.keyframe === true) {
            this.viewersWaitingForKeyframe.delete(viewer);
            this.clearViewerDrainPoll(viewer);
          }
        } else if (['frame', 'audio-frame'].includes(String(message.type)) && viewer.bufferedAmount > MAX_VIEWER_MEDIA_BUFFER) {
          continue;
        }
        viewer.send(json);
      }
      return;
    }
    if (message.type === 'tunnel-data') {
      const tunnelId = String(message.tunnelId || '');
      const device = this.deviceTunnels.get(tunnelId);
      if (device?.hostId === link.hostId && typeof message.data === 'string' && message.data.length <= 2_000_000) {
        const bytes = Buffer.from(message.data, 'base64');
        if (device.socket.destroyed || device.socket.writableLength + bytes.length > MAX_RELAY_BUFFER) {
          device.socket.destroy();
        } else device.socket.write(bytes);
        return;
      }
      const tunnel = this.tunnels.get(tunnelId);
      if (!tunnel || tunnel.hostId !== link.hostId || typeof message.data !== 'string' || message.data.length > 2_000_000) return;
      if (tunnel.socket.readyState !== WebSocket.OPEN) return;
      if (tunnel.socket.bufferedAmount > MAX_RELAY_BUFFER) {
        tunnel.socket.terminate();
        return;
      }
      tunnel.socket.send(Buffer.from(message.data, 'base64'), { binary: true });
      return;
    }
    if (message.type === 'tunnel-close') {
      const tunnelId = String(message.tunnelId || '');
      const device = this.deviceTunnels.get(tunnelId);
      if (device?.hostId === link.hostId) {
        this.deviceTunnels.delete(tunnelId);
        device.socket.destroy();
        return;
      }
      const tunnel = this.tunnels.get(tunnelId);
      if (tunnel?.hostId === link.hostId) {
        this.tunnels.delete(tunnelId);
        tunnel.socket.close(1000, 'agent closed tunnel');
      }
    }
  }

  private async storeSessionCapabilities(sessionId: string, report: ActiveSessionReport): Promise<void> {
    if (!report.details?.capabilities) return;
    await this.pool.query('UPDATE sessions SET capabilities=$2,device_metadata=$3 WHERE id=$1 AND (capabilities IS DISTINCT FROM $2 OR device_metadata IS DISTINCT FROM $3)',
      [sessionId, report.details.capabilities, report.details]);
  }

  private async storeDevices(hostId: string, providers: unknown): Promise<void> {
    if (providers === undefined) return;
    const statuses = normalizeProviderStatuses(providers);
    const old = await transaction(this.pool, async client => {
      const previous = await client.query('SELECT provider_status FROM hosts WHERE id=$1 FOR UPDATE', [hostId]);
      await client.query('UPDATE hosts SET devices=$2,provider_capabilities=$3,provider_status=$4 WHERE id=$1',
        [hostId, JSON.stringify(physicalDevicesFromProviders(providers)), JSON.stringify(cleanProviderCapabilities(providers)), JSON.stringify(statuses)]);
      return normalizeProviderStatuses(previous.rows[0]?.provider_status);
    });
    for (const status of statuses) {
      const previous = old.find(item => item.kind === status.kind);
      if (status.status === 'unavailable' && (previous?.status !== status.status || previous.code !== status.code)) {
        await recordServiceLog(this.pool, { hostId, service: 'agent', severity: 'error', code: 'agent.provider_unavailable',
          message: uiMessage('providers.failedLog', { p0: status.kind, p1: status.code ?? 'unknown' }) });
      } else if (status.status === 'ready' && previous?.status === 'unavailable') {
        await recordServiceLog(this.pool, { hostId, service: 'agent', severity: 'info', code: 'agent.provider_recovered',
          message: uiMessage('providers.recoveredLog', { p0: status.kind }) });
      }
    }
  }

  // A device failed its wipe (or an emulator could not be destroyed). The agent keeps it out of rotation; here
  // the admins are told. The ack is sent only after the audit record is stored, so the agent re-sends until then.
  private async onDeviceAlert(ws: WebSocket, hostId: string, message: Record<string, unknown>): Promise<void> {
    const id = String(message.id || '');
    const kind = String(message.kind || '');
    const deviceId = String(message.deviceId || '');
    if (!/^[A-Za-z0-9:._-]{1,160}$/.test(id) || !/^[a-z-]{1,32}$/.test(kind) || !deviceId || deviceId.length > 100) return;
    if (!this.seenAlerts.has(id)) {
      const reason = String(message.reason || 'unknown').replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 300);
      try {
        await recordAuditEvent(this.pool, { action: 'device.quarantined', outcome: 'failed', targetType: 'device', targetId: `${hostId}/${deviceId}`.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 100) });
      } catch { return; }
      await notifyAdmins(this.pool, { kind: 'device.quarantined', title: uiMessage('ui.a7e77506e76b', { p0: deviceId }),
        body: uiMessage('ui.0cc432761585', { p0: hostId, p1: kind, p2: reason }) });
      this.seenAlerts.add(id);
      if (this.seenAlerts.size > 1000) this.seenAlerts.delete(this.seenAlerts.values().next().value as string);
    }
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'alert-ack', id }));
  }

  private async belongsToHost(sessionId: string, hostId: string): Promise<boolean> {
    if (this.sessionHosts.get(sessionId) === hostId) return true;
    const result = await this.pool.query(
      `SELECT host_id FROM sessions WHERE id=$1 AND state IN ('starting','running')`, [sessionId],
    );
    if (result.rows[0]?.host_id !== hostId) return false;
    this.sessionHosts.set(sessionId, hostId);
    return true;
  }

  async command(hostId: string, sessionId: string, action: string, params: Record<string, unknown>, timeoutMs = 30_000, input?: InputMetadata): Promise<Record<string, unknown>> {
    if (this.stopped) throw new Error('server shutting down');
    const agent = this.agents.get(hostId);
    if (!agent || agent.ws.readyState !== WebSocket.OPEN) throw new ApiError(503, 'agent_offline', uiMessage('api.agent_offline'));
    if (action === 'start') this.locallyStartedSessions.add(sessionId);
    return this.pending.request({ ws: agent.ws, hostId, sessionId, action }, timeoutMs, (id, fail) => {
      agent.ws.send(JSON.stringify({ type: 'command', id, sessionId, action, params, ...(input ? { input } : {}) }),
        error => { if (error) fail(error); });
    });
  }

  private schedulePolicyApply(link: AgentLink, phase: 'apply' | 'refresh'): void {
    const hostId = link.hostId;
    if (this.policyRefreshInFlight.get(hostId) === link ||
        (this.policyRetryAfter.get(hostId) ?? 0) > Date.now()) return;
    this.policyRefreshInFlight.set(hostId, link);
    void this.applyHostPolicy(hostId).then(() => {
      if (this.agents.get(hostId) === link) this.policyRetryAfter.delete(hostId);
    }).catch(error => {
      if (this.agents.get(hostId) === link) {
        this.policyRetryAfter.set(hostId, Date.now() + 10_000);
        console.warn('Node policy ' + phase + ' failed:', error.message);
      }
    }).finally(() => {
      if (this.policyRefreshInFlight.get(hostId) === link) this.policyRefreshInFlight.delete(hostId);
    });
  }

  supportsNodePolicy(hostId: string): boolean {
    return this.agents.get(hostId)?.policyVersion === 1;
  }

  async applyHostPolicy(hostId: string): Promise<Record<string, unknown>> {
    const link = this.agents.get(hostId);
    if (!link || link.ws.readyState !== WebSocket.OPEN) throw new ApiError(503, 'agent_offline', uiMessage('api.agent_offline'));
    if (!link.policyVersion) throw new Error('Agent upgrade is required for runtime node policy');
    const result = await this.pool.query('SELECT * FROM hosts WHERE id=$1 AND removed_at IS NULL', [hostId]);
    const host = result.rows[0];
    if (!host) throw new Error('Node is removed');
    const desired = desiredNodePolicy(host);
    const acknowledged = await this.command(hostId, hostId, 'set-policy', { policy: desired }, 30_000);
    if (acknowledged.revision !== desired.revision || acknowledged.slots !== desired.slots ||
        acknowledged.slotCpu !== desired.slotCpu || acknowledged.slotMemoryMb !== desired.slotMemoryMb) {
      throw new Error('Agent policy acknowledgement mismatch');
    }
    await transaction(this.pool, async client => {
      const updated = await client.query('UPDATE hosts SET slots=$2,applied_policy_revision=$3 WHERE id=$1 AND policy_revision=$3 RETURNING id',
        [hostId, desired.slots, desired.revision]);
      if (!updated.rowCount) throw new Error('Node policy changed during application');
      await client.query('INSERT INTO host_slots(host_id,slot_index) SELECT $1, generate_series(0,$2-1) ON CONFLICT DO NOTHING',
        [hostId, desired.slots]);
    });
    this.policyRetryAfter.delete(hostId);
    return acknowledged;
  }

  private completeRecoveredStart(link: AgentLink, sessionId: string,
    active: ActiveSessionReport): void {
    // A restarted agent has lost its original RPC, but only an explicit Android
    // boot check may replace that response. A transport reconnect still preparing
    // its container must retain the original promise and deadline.
    if (active.preparing || !active.bootReady || !active.containerId || this.agents.get(link.hostId) !== link) return;
    for (const [id, pending] of this.pending) {
      if (pending.action !== 'start' || pending.sessionId !== sessionId || pending.hostId !== link.hostId || pending.ws !== link.ws) continue;
      this.pending.take(id);
      pending.resolve({ containerId: active.containerId, networkEnabled: active.networkEnabled, ...active.details });
    }
  }

  private hasPendingStart(sessionId: string): boolean {
    return [...this.pending.values()].some(pending => pending.action === 'start' && pending.sessionId === sessionId);
  }

  hasAgent(hostId: string): boolean {
    return this.agents.get(hostId)?.ws.readyState === WebSocket.OPEN;
  }

  disconnectHost(hostId: string): void {
    this.agents.get(hostId)?.ws.close(4003, 'agent credential changed');
  }

  setViewerTransport(viewer: WebSocket, transport: 'webrtc' | 'websocket'): void {
    this.viewerTransports.set(viewer, transport);
    for (const [sessionId, viewers] of this.viewers) if (viewers.has(viewer)) {
      const hostId = this.sessionHosts.get(sessionId);
      if (hostId) this.refreshStream(sessionId, hostId);
      break;
    }
  }

  async openInput(sessionId: string, hostId: string, socket: WebSocket): Promise<{ inputEpoch: string; serverTime: number; inputMaxAgeMs: number }> {
    const state = { epoch: randomUUID(), sequence: 0, clockOffset: 0, active: true };
    this.inputViewers.set(socket, state);
    socket.once('close', () => {
      if (!state.active) return;
      state.active = false;
      if (this.hasAgent(hostId)) void this.command(hostId, sessionId, 'input-release', { epoch: state.epoch }, 5000).catch(() => {});
    });
    const result = await this.command(hostId, sessionId, 'input-open', { epoch: state.epoch }, 5000);
    if (!state.active || socket.readyState !== WebSocket.OPEN) {
      if (this.hasAgent(hostId)) void this.command(hostId, sessionId, 'input-release', { epoch: state.epoch }, 5000).catch(() => {});
      throw new StreamInputError('input_closed', 'Input connection has closed');
    }
    if (typeof result.agentTime !== 'number' || !Number.isFinite(result.agentTime)) throw new StreamInputError('input_unavailable', 'Agent does not support expiring input');
    // Response transit time makes the deadline earlier, never extends its life.
    state.clockOffset = result.agentTime - Date.now();
    return { inputEpoch: state.epoch, serverTime: Date.now(), inputMaxAgeMs: INPUT_MAX_AGE_MS };
  }

  async input(sessionId: string, hostId: string, socket: WebSocket, message: Record<string, unknown>, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (socket.readyState !== WebSocket.OPEN) throw new StreamInputError('input_closed', 'Viewer connection is closed');
    const state = this.inputViewers.get(socket);
    if (!state?.active) throw new StreamInputError('input_closed', 'Input connection has closed');
    try {
      const input = readInputMetadata(message, state.epoch, state.sequence);
      state.sequence = input.seq;
      input.deadline += state.clockOffset;
      return await this.command(hostId, sessionId, 'input', params, 3000, input);
    } catch (error) {
      // A rejected/expired UP must release contacts even if the browser cannot
      // receive the error or has not closed its socket yet. Never replay input.
      state.active = false;
      if (this.hasAgent(hostId)) void this.command(hostId, sessionId, 'input-release', { epoch: state.epoch }, 5000).catch(() => {});
      throw error;
    }
  }

  addViewer(sessionId: string, hostId: string, socket: WebSocket, inputReady?: { inputEpoch: string; serverTime: number; inputMaxAgeMs: number }): void {
    const stopping = this.streamStopTimers.get(sessionId);
    if (stopping) { clearTimeout(stopping); this.streamStopTimers.delete(sessionId); }
    let set = this.viewers.get(sessionId);
    let viewerCount = 0;
    for (const viewers of this.viewers.values()) viewerCount += viewers.size;
    if ((set?.size || 0) >= MAX_VIEWERS_PER_SESSION || viewerCount >= MAX_VIEWERS_TOTAL) {
      socket.close(1013, 'viewer limit reached');
      return;
    }
    if (!set) { set = new Set(); this.viewers.set(sessionId, set); }
    set.add(socket);
    this.sessionHosts.set(sessionId, hostId);
    this.viewersWaitingForKeyframe.add(socket);
    socket.send(JSON.stringify({ type: 'ready', sessionId, ...inputReady }));
    this.refreshStream(sessionId, hostId);
    socket.on('close', () => {
      this.clearViewerDrainPoll(socket);
      if (this.stopped) return;
      const current = this.viewers.get(sessionId);
      current?.delete(socket);
      if (current && !current.size) {
        this.viewers.delete(sessionId);
        this.lastKeyframeRequest.delete(sessionId);
        if (this.hasAgent(hostId)) void this.command(hostId, sessionId, 'stream-start', { relayMedia: false }).catch(() => {});
        const timer = setTimeout(() => {
          this.streamStopTimers.delete(sessionId);
          if (!this.viewers.get(sessionId)?.size && this.hasAgent(hostId)) void this.command(hostId, sessionId, 'stream-stop', {}).catch(() => {});
        }, 15_000);
        timer.unref();
        this.streamStopTimers.set(sessionId, timer);
      } else if (current?.size) this.refreshStream(sessionId, hostId);
    });
  }

  private clearViewerDrainPoll(viewer: WebSocket): void {
    const timer = this.viewerDrainPolls.get(viewer);
    if (timer) clearTimeout(timer);
    this.viewerDrainPolls.delete(viewer);
  }

  private scheduleKeyframeOnDrain(sessionId: string, hostId: string, viewer: WebSocket): void {
    if (this.viewerDrainPolls.has(viewer)) return;
    const check = () => {
      this.viewerDrainPolls.delete(viewer);
      if (viewer.readyState !== WebSocket.OPEN || !this.viewers.get(sessionId)?.has(viewer) ||
          !this.viewersWaitingForKeyframe.has(viewer)) return;
      if (viewer.bufferedAmount <= MAX_VIEWER_MEDIA_BUFFER &&
          this.requestKeyframe(sessionId, hostId, viewer)) return;
      const timer = setTimeout(check, 100);
      timer.unref();
      this.viewerDrainPolls.set(viewer, timer);
    };
    const timer = setTimeout(check, 100);
    timer.unref();
    this.viewerDrainPolls.set(viewer, timer);
  }

  requestKeyframe(sessionId: string, hostId: string, viewer: WebSocket): boolean {
    if (viewer.readyState !== WebSocket.OPEN || !this.viewers.get(sessionId)?.has(viewer)) return false;
    const now = Date.now();
    if (now - (this.lastKeyframeRequest.get(sessionId) || 0) < 1000) return false;
    this.lastKeyframeRequest.set(sessionId, now);
    void this.command(hostId, sessionId, 'video-keyframe', {}, 5000).catch(() => {});
    return true;
  }

  refreshStream(sessionId: string, hostId: string): void {
    const viewers = this.viewers.get(sessionId);
    if (!viewers?.size) return;
    const relayMedia = [...viewers].some(viewer => viewer.readyState === WebSocket.OPEN && this.viewerTransports.get(viewer) !== 'webrtc');
    void this.command(hostId, sessionId, 'stream-start', { relayMedia }).catch(error => {
      for (const viewer of this.viewers.get(sessionId) || []) {
        if (viewer.readyState === WebSocket.OPEN) viewer.send(JSON.stringify({ type: 'error', message: error.message }));
      }
    });
  }

  onSessionClosed(listener: (sessionId: string) => void): () => void {
    if (!this.stopped) this.sessionClosedListeners.add(listener);
    return () => { this.sessionClosedListeners.delete(listener); };
  }

  addDeviceTunnel(sessionId: string, hostId: string, socket: Socket, initial: Buffer): boolean {
    const agent = this.agents.get(hostId);
    if (!agent || agent.ws.readyState !== WebSocket.OPEN || initial.length > 8192) return false;
    let sessionTunnels = 0;
    let hostTunnels = 0;
    for (const tunnel of [...this.tunnels.values(), ...this.deviceTunnels.values()]) {
      if (tunnel.sessionId === sessionId) sessionTunnels++;
      if (tunnel.hostId === hostId) hostTunnels++;
    }
    if (sessionTunnels >= MAX_TUNNELS_PER_SESSION || hostTunnels >= MAX_TUNNELS_PER_HOST ||
        this.tunnels.size + this.deviceTunnels.size >= MAX_TUNNELS_TOTAL) return false;
    const tunnelId = randomUUID();
    this.deviceTunnels.set(tunnelId, { socket, sessionId, hostId });
    const send = (bytes: Buffer) => {
      const current = this.agents.get(hostId);
      if (!current || current.ws.readyState !== WebSocket.OPEN ||
          current.ws.bufferedAmount > MAX_RELAY_BUFFER || bytes.length > 1_000_000) {
        socket.destroy();
        return;
      }
      for (let offset = 0; offset < bytes.length; offset += 96_000) {
        current.ws.send(JSON.stringify({ type: 'tunnel-data', tunnelId,
          data: bytes.subarray(offset, offset + 96_000).toString('base64') }));
      }
    };
    agent.ws.send(JSON.stringify({ type: 'tunnel-open', tunnelId, sessionId, mode: 'device' }), error => {
      if (error) socket.destroy();
    });
    send(initial);
    socket.on('data', send);
    socket.on('close', () => {
      this.deviceTunnels.delete(tunnelId);
      const current = this.agents.get(hostId);
      if (current?.ws.readyState === WebSocket.OPEN) current.ws.send(JSON.stringify({ type: 'tunnel-close', tunnelId }));
    });
    socket.on('error', () => {});
    return true;
  }

  hasActiveTunnel(sessionId: string): boolean {
    for (const tunnel of [...this.tunnels.values(), ...this.deviceTunnels.values()]) if (tunnel.sessionId === sessionId) return true;
    return false;
  }

  addTunnel(sessionId: string, hostId: string, socket: WebSocket): void {
    const agent = this.agents.get(hostId);
    if (!agent || agent.ws.readyState !== WebSocket.OPEN) { socket.close(1013, 'agent offline'); return; }
    let sessionTunnels = 0;
    let hostTunnels = 0;
    for (const tunnel of this.tunnels.values()) {
      if (tunnel.sessionId === sessionId) sessionTunnels++;
      if (tunnel.hostId === hostId) hostTunnels++;
    }
    if (sessionTunnels >= MAX_TUNNELS_PER_SESSION || hostTunnels >= MAX_TUNNELS_PER_HOST || this.tunnels.size >= MAX_TUNNELS_TOTAL) {
      socket.close(1013, 'ADB tunnel limit reached');
      return;
    }
    const tunnelId = randomUUID();
    this.tunnels.set(tunnelId, { socket, sessionId, hostId });
    agent.ws.send(JSON.stringify({ type: 'tunnel-open', tunnelId, sessionId }), error => {
      if (error) socket.terminate();
    });
    socket.on('message', (data, isBinary) => {
      if (!isBinary) { socket.close(1003, 'binary ADB frames required'); return; }
      const current = this.agents.get(hostId);
      if (!current || current.ws.readyState !== WebSocket.OPEN) { socket.close(1013, 'agent offline'); return; }
      if (current.ws.bufferedAmount > MAX_RELAY_BUFFER) {
        socket.close(1013, 'agent relay congested');
        return;
      }
      const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
      if (bytes.length > 1_000_000) { socket.close(1009, 'ADB chunk too large'); return; }
      for (let offset = 0; offset < bytes.length; offset += 96_000) {
        current.ws.send(JSON.stringify({ type: 'tunnel-data', tunnelId, data: bytes.subarray(offset, offset + 96_000).toString('base64') }));
      }
    });
    socket.on('close', () => {
      this.tunnels.delete(tunnelId);
      const current = this.agents.get(hostId);
      if (current?.ws.readyState === WebSocket.OPEN) current.ws.send(JSON.stringify({ type: 'tunnel-close', tunnelId }));
    });
  }

  closeSessionChannels(sessionId: string): void {
    const stopping = this.streamStopTimers.get(sessionId);
    if (stopping) { clearTimeout(stopping); this.streamStopTimers.delete(sessionId); }
    this.sessionHosts.delete(sessionId);
    this.lastKeyframeRequest.delete(sessionId);
    for (const listener of this.sessionClosedListeners) listener(sessionId);
    for (const [id, tunnel] of this.deviceTunnels) {
      if (tunnel.sessionId !== sessionId) continue;
      this.deviceTunnels.delete(id);
      tunnel.socket.destroy();
      const agent = this.agents.get(tunnel.hostId);
      if (agent?.ws.readyState === WebSocket.OPEN) agent.ws.send(JSON.stringify({ type: 'tunnel-close', tunnelId: id }));
    }
    const viewers = this.viewers.get(sessionId);
    this.viewers.delete(sessionId);
    for (const viewer of viewers || []) {
      this.clearViewerDrainPoll(viewer);
      viewer.close(4001, 'session ended');
    }
    for (const [id, tunnel] of this.tunnels) {
      if (tunnel.sessionId !== sessionId) continue;
      this.tunnels.delete(id);
      tunnel.socket.close(4001, 'session ended');
      const agent = this.agents.get(tunnel.hostId);
      if (agent?.ws.readyState === WebSocket.OPEN) agent.ws.send(JSON.stringify({ type: 'tunnel-close', tunnelId: id }));
    }
  }

  async releaseSession(sessionId: string, expectedState?: 'running'): Promise<void> {
    const released = await transaction(this.pool, async client => {
      if (expectedState) {
        // A heartbeat snapshot may predate an accepted stop. Missing inventory
        // must not release a now-stopping lease without teardown confirmation.
        const current = await client.query('SELECT id FROM sessions WHERE id=$1 AND state=$2 FOR UPDATE', [sessionId, expectedState]);
        if (!current.rowCount) return false;
      }
      await client.query('UPDATE host_slots SET session_id=NULL WHERE session_id=$1', [sessionId]);
      // ADB leases and one-time tokens cascade from the session row.
      const deleted = await client.query('DELETE FROM sessions WHERE id=$1 RETURNING host_id', [sessionId]);
      return deleted.rows[0]?.host_id || false;
    });
    if (!released) return;
    await sessionLog(this.pool, String(released), sessionId, 'session.released', uiMessage('ui.26c3d9e2e40d'));
    this.locallyStartedSessions.delete(sessionId);
    this.closeSessionChannels(sessionId);
  }

  // The caller has durably marked the lease stopping. Cleanup belongs to the
  // hub, not the HTTP request; reconciliation uses this same in-flight guard.
  stopSession(hostId: string, sessionId: string, force = false): void {
    if (this.stopped || this.cancellationInFlight.has(sessionId) ||
        [...this.pending.values()].some(item => item.sessionId === sessionId && ['stop', 'kill'].includes(item.action))) return;
    this.cancellationInFlight.add(sessionId);
    this.closeSessionChannels(sessionId);
    const task = (async () => {
      try {
        await sessionLog(this.pool, hostId, sessionId, 'session.stop_requested', force ? uiMessage('ui.f9f9df12b783') : uiMessage('ui.e676012adeb0'));
        await this.command(hostId, sessionId, force ? 'kill' : 'stop', {}, force ? START_CANCEL_TIMEOUT_MS : 150_000);
      } catch (error) {
        await sessionLog(this.pool, hostId, sessionId, 'session.stop_failed', String(error instanceof Error ? error.message : error), 'error');
        if (force || this.stopped || !this.hasAgent(hostId)) throw error;
        await sessionLog(this.pool, hostId, sessionId, 'session.kill_requested', uiMessage('ui.cec74000fe62'), 'warning');
        await this.command(hostId, sessionId, 'kill', {}, START_CANCEL_TIMEOUT_MS);
      }
      await this.releaseSession(sessionId);
    })().catch(async error => {
      await sessionLog(this.pool, hostId, sessionId, 'session.cleanup_deferred', uiMessage('ui.09da2443a162') + String(error instanceof Error ? error.message : error), 'error');
      // Keep the durable stopping row and reserved slot. A subsequent heartbeat
      // or reconnect retries cancellation, including after a broker restart.
    }).finally(() => this.cancellationInFlight.delete(sessionId));
    this.trackAgentTask(task);
  }

  private async releaseStaleStartingSession(sessionId: string): Promise<void> {
    // Reserve preparation slots until their persisted start deadline plus one minute.
    // Pending RPCs also cover reconnects while the control worker continues its build.
    if (this.hasPendingStart(sessionId)) return;
    const released = await transaction(this.pool, async client => {
      const result = await client.query(
        "SELECT id,host_id,owner_user_id,startup_deadline_at FROM sessions WHERE id=$1 AND state='starting' " +
        "AND COALESCE(startup_deadline_at,created_at + interval '15 minutes') <= now() - interval '1 minute' FOR UPDATE",
        [sessionId],
      );
      if (!result.rowCount) return null;
      const row = result.rows[0];
      if (row.startup_deadline_at) {
        await client.query("UPDATE sessions SET state='stopping',error=$2 WHERE id=$1", [sessionId, uiMessage('ui.aa2682d7d1fa')]);
        return row;
      }
      await client.query('UPDATE host_slots SET session_id=NULL WHERE session_id=$1', [sessionId]);
      const deleted = await client.query('DELETE FROM sessions WHERE id=$1 RETURNING host_id', [sessionId]);

      return true;
    });
    if (released === true) { this.locallyStartedSessions.delete(sessionId); this.closeSessionChannels(sessionId); }
    else if (released) {
      await sessionLog(this.pool, String(released.host_id), sessionId, 'session.start_timeout', uiMessage('ui.d47594e8d152'), 'error');
      await notifyUser(this.pool, String(released.owner_user_id), { kind: 'session.failed', title: uiMessage('ui.49137ce3f979'), body: uiMessage('ui.8185909700d0'), sessionId });
      this.stopSession(String(released.host_id), sessionId, true);
    }
  }

  private async agentClosed(link: AgentLink): Promise<void> {
    if (this.agents.get(link.hostId) !== link) return;
    this.agents.delete(link.hostId);
    emitServiceLog(this.pool, { service: 'server', severity: 'warning', code: 'agent.disconnected', hostId: link.hostId });
    await this.pool.query(`UPDATE hosts SET status='offline' WHERE id=$1`, [link.hostId]).catch(() => {});
    this.pending.rejectWhere(pending => pending.ws === link.ws && pending.action !== 'start', new Error('agent disconnected'));
    const result = await this.pool.query(`SELECT id FROM sessions WHERE host_id=$1 AND state IN ('starting','running','stopping')`, [link.hostId]).catch(() => ({ rows: [] }));
    for (const row of result.rows) {
      await sessionLog(this.pool, link.hostId, row.id, 'session.agent_disconnected', uiMessage('ui.9ad97d6ce64c'), 'warning');
      this.closeSessionChannels(row.id);
    }
  }

  private async flushMaintenanceLogs(hostId: string): Promise<void> {
    for (const [key, state] of this.maintenanceLogs) {
      if (state.hostId !== hostId) continue;
      const writes = state.writes;
      await writes;
      if (state.writes === writes) this.maintenanceLogs.delete(key);
    }
  }

  private closeStaleAgents(): void {
    for (const link of this.agents.values()) {
      if (Date.now() - link.lastHeartbeat > 45_000) link.ws.close(1011, 'heartbeat timeout');
    }
  }
}
