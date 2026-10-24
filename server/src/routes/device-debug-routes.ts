import type { Express } from 'express';
import type { ServerContext } from '../server-context.js';
import { ApiError, route } from '../http-common.js';
import { assertPermission } from '../permissions.js';
import { uiMessage } from '../messages.js';

export { trafficHar } from '../../../shared/traffic-har.mjs';
import { trafficHar } from '../../../shared/traffic-har.mjs';

export function debugCommandError(error: unknown, feature: 'webviews' | 'network-inspector'): ApiError {
  const known = [
    ['debug.busy', 'debug_busy', 409],
    ['networkInspector.unavailable', 'network_inspector_unavailable', 503],
    ['networkInspector.restartRequired', 'network_inspector_restart_required', 409],
    ['networkInspector.connectionsOpen', 'network_inspector_connections_open', 409],
    ['networkInspector.alreadyStarted', 'network_inspector_recording', 409],
    ['networkInspector.proxyConflict', 'network_inspector_proxy_conflict', 409],
    ['networkInspector.stopBeforeExport', 'network_inspector_recording', 409],
    ['networkInspector.captureChanged', 'network_inspector_capture_changed', 409],
  ] as const;
  for (const [key, code, status] of known)
    if (error instanceof Error && (['ru', 'en'] as const).some(language => error.message === uiMessage(key, {}, language)))
      return new ApiError(status, code, uiMessage(key));
  return new ApiError(502, 'device_debug_unavailable', uiMessage(feature === 'webviews' ? 'webviews.failed' : 'networkInspector.failed'));
}

export function registerDeviceDebugRoutes(app: Express, context: ServerContext): void {
  const { requireAuth, current, ownedSession, hub, pool, activity } = context;
  const pending = new Map<string, number>(); let active = 0;
  const handle = (feature: 'webviews' | 'network-inspector', format?: 'har') => route(async (req, res) => {
    const user = current(res).user;
    assertPermission(user, 'sessions.console');
    if (feature === 'network-inspector') assertPermission(user, 'sessions.env');
    if (format === 'har') assertPermission(user, 'sessions.files');
    const session = await ownedSession(req.params.id!, current(res), true);
    if (session.state !== 'running') throw new ApiError(409, 'session_not_ready', uiMessage('ui.63075d9eaf25'));
    if (feature === 'network-inspector' && session.deviceKind && session.deviceKind !== 'emulator')
      throw new ApiError(422, 'unsupported_device', uiMessage('networkInspector.unavailable'));
    const params = req.method === 'GET' ? { op: feature === 'webviews' ? 'list' : 'status' } : req.body;
    const allowed = feature === 'webviews' ? ['document', 'evaluate'] : ['start', 'stop', 'clear', 'pcap'];
    if (req.method !== 'GET' && (!params || !allowed.includes(params.op) || JSON.stringify(params).length > 20000))
      throw new ApiError(400, 'invalid_debug_command', uiMessage(feature === 'webviews' ? 'webviews.failed' : 'networkInspector.failed'));
    if (req.method !== 'GET') {
      const fields = feature === 'webviews' ? (params.op === 'evaluate' ? ['op', 'target', 'expression'] : ['op', 'target'])
        : params.op === 'start' ? ['op', 'pcap', 'captureBodies'] : params.op === 'pcap' ? ['op', 'offset', 'captureId'] : ['op'];
      if (Object.keys(params).some(key => !fields.includes(key)) || fields.filter(key => !['captureBodies', 'captureId'].includes(key)).some(key => !Object.hasOwn(params, key)) ||
          (feature === 'webviews' && (typeof params.target !== 'string' || !/^(?:webview_devtools_remote(?:_\d+)?|chrome_devtools_remote)\/[A-Za-z0-9_.-]{1,160}$/.test(params.target))) ||
          (params.op === 'evaluate' && (typeof params.expression !== 'string' || !params.expression.trim() || params.expression.length > 16384)) ||
          (params.op === 'start' && (typeof params.pcap !== 'boolean' || (params.captureBodies !== undefined && typeof params.captureBodies !== 'boolean'))) ||
          (params.captureId !== undefined && (typeof params.captureId !== 'string' || !/^[a-f0-9]{32}$/.test(params.captureId))) ||
          (params.op === 'pcap' && (!Number.isSafeInteger(params.offset) || params.offset < 0 || params.offset > 40 * 1024 * 1024)))
        throw new ApiError(400, 'invalid_debug_command', uiMessage(feature === 'webviews' ? 'webviews.failed' : 'networkInspector.failed'));
    }
    if (params.op === 'pcap') assertPermission(user, 'sessions.files');
    activity.touch(session.id);
    if (active >= 16 || (pending.get(user.id) ?? 0) >= 2) throw new ApiError(429, 'debug_busy', uiMessage('debug.busy'));
    pending.set(user.id, (pending.get(user.id) ?? 0) + 1); active++;
    let result: Record<string, unknown>;
    try { result = await hub.command(session.hostId, session.id, feature, params, 60_000); }
    catch (error) { throw debugCommandError(error, feature); }
    finally { active--; const left = (pending.get(user.id) ?? 1) - 1; if (left) pending.set(user.id, left); else pending.delete(user.id); }
    if (req.method !== 'GET' && params.op !== 'pcap' && params.op !== 'document') {
      await pool.query(
        'INSERT INTO audit_events(actor_user_id,actor_username,subject_user_id,action,target_type,target_id,detail) ' +
        "VALUES($1,$2,$3,'session.debug_changed','session',$4,$5)",
        [user.id, user.username, session.ownerId, session.id, feature + ':' + params.op]);
    }
    res.setHeader('Cache-Control', 'no-store');
    if (format === 'har') {
      res.setHeader('Content-Disposition', 'attachment; filename="session-' + session.id.slice(0, 8) + '.har"');
      res.json(trafficHar(result, { tunnel: uiMessage('networkInspector.harTunnelNote'), unmeasured: uiMessage('networkInspector.harUnmeasured') }));
    } else res.json(result);
  });
  app.get('/api/sessions/:id/webviews', requireAuth, handle('webviews'));
  app.post('/api/sessions/:id/webviews', requireAuth, handle('webviews'));
  app.get('/api/sessions/:id/network-inspector', requireAuth, handle('network-inspector'));
  app.post('/api/sessions/:id/network-inspector', requireAuth, handle('network-inspector'));
  app.get('/api/sessions/:id/network-inspector/har', requireAuth, handle('network-inspector', 'har'));
}
