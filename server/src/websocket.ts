import { assertPermission, hasPermission } from './permissions.js';
import { registerAccessConnection } from './access-connections.js';
import { recordServiceLog } from './service-log.js';
import { streamHeartbeat, StreamInputError } from './stream-input.js';
import { attachRtcSignaling } from './rtc-signaling.js';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import WebSocket, { WebSocketServer } from 'ws';
import { secureEqual, tokenHash, type AuthContext } from './auth.js';
import type { ServerContext } from './server-context.js';
import { inputParams, isAllowedOrigin, statusMessage, type Session } from './http-common.js';
import { accessibleSession, classifyStreamMessage, registerGrantSocket, type Access } from './session-access.js';

export function attachWebSocket(server: Server, context: ServerContext): () => Promise<void> {
  const context_ = context;
  const { pool, config, auth, hub, ownedSession, activity } = context;
  const agentWss = new WebSocketServer({ noServer: true, maxPayload: 80 * 1024 * 1024 });
  const streamWss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });
  const tunnelWss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });

  let stopped = false;
  let stopping: Promise<void> | undefined;
  const pendingSockets = new Set<Duplex>();
  const tasks = new Set<Promise<unknown>>();
  const track = <T>(task: Promise<T>): Promise<T> => {
    tasks.add(task);
    void task.then(() => tasks.delete(task), () => tasks.delete(task));
    return task;
  };

  const rejectUpgrade = (socket: { write(data: string): unknown; destroy(): unknown }, status: number) => {
    const phrase = status === 401 ? 'Unauthorized' : status === 403 ? 'Forbidden' : status === 404 ? 'Not Found' : 'Bad Request';
    socket.write(`HTTP/1.1 ${status} ${phrase}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    socket.destroy();
  };

  const upgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (stopped) { socket.destroy(); return; }
    pendingSockets.add(socket);
    void track((async () => {
      const pathname = new URL(req.url || '/', 'http://localhost').pathname;
      if (pathname === '/agent/connect') {
        const bearer = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : '';
        let expectedHostId: string | undefined;
        if (bearer && secureEqual(bearer, config.agentToken)) expectedHostId = config.bootstrapAgentId;
        else if (bearer) {
          const credential = await pool.query('SELECT host_id FROM agent_credentials WHERE token_hash=$1', [tokenHash(bearer)]);
          expectedHostId = credential.rows[0]?.host_id;
        }
        if (!expectedHostId) { rejectUpgrade(socket, 401); return; }
        if (stopped || socket.destroyed) return;
        agentWss.handleUpgrade(req, socket, head, ws => hub.attachAgent(ws, expectedHostId));
        return;
      }
      const match = /^\/api\/sessions\/([a-f0-9-]{36})\/(stream|adb-tunnel)$/i.exec(pathname);
      if (!match || !match[1] || !match[2]) { rejectUpgrade(socket, 404); return; }
      if (!isAllowedOrigin(req, config)) { rejectUpgrade(socket, 403); return; }
      const sessionId = match[1];
      const kind = match[2];
      let context: AuthContext | null = null;
      let adbTokenExpiresAt: number | undefined;
      let adbAccessHash: string | undefined;
      if (kind === 'adb-tunnel' && req.headers.authorization?.startsWith('Bearer rdfa_')) {
        const raw = req.headers.authorization.slice(7);
        adbAccessHash = tokenHash(raw);
        const { rows } = await pool.query(
          `UPDATE adb_access_tokens SET used_at=now()
           WHERE token_hash=$1 AND session_id=$2 AND expires_at>now()
           RETURNING owner_user_id,expires_at`,
          [adbAccessHash, sessionId],
        );
        if (rows[0]) {
          adbTokenExpiresAt = new Date(rows[0].expires_at).getTime();
          const user = await auth.userById(String(rows[0].owner_user_id));
          if (user) context = {
            user, via: 'token',
          };
        }
      } else {
        context = await auth.authenticate(req);
      }
      if (!context) { rejectUpgrade(socket, 401); return; }
      let session: Session;
      let hostId: string;
      let access: Access = 'owner';
      let grantId: string | null = null;
      let grantExpiresAt: number | null = null;
      try {
        // Only the screen stream accepts share grants; the ADB tunnel stays owner/admin-only.
        if (kind === 'stream') {
          const result = await accessibleSession(context_, sessionId, context, 'view', true);
          session = result.session; hostId = result.hostId; access = hasPermission(context.user, 'sessions.control') ? result.access : 'view'; grantId = result.grantId; grantExpiresAt = result.grantExpiresAt;
        } else { assertPermission(context.user, 'sessions.adb'); session = await ownedSession(sessionId, context, true); hostId = session.hostId; }
      } catch { rejectUpgrade(socket, 404); return; }
      if (stopped || socket.destroyed) return;
      if (!hub.hasAgent(hostId)) { rejectUpgrade(socket, 403); return; }
      const authenticatedContext = context;
      const authorizeSocket = async () => {
        let refreshed: AuthContext | null = authenticatedContext;
        if (adbAccessHash) {
          const result = await pool.query(
            'SELECT owner_user_id FROM adb_access_tokens WHERE token_hash=$1 AND session_id=$2 AND expires_at>now()',
            [adbAccessHash, sessionId],
          );
          if (result.rows[0]?.owner_user_id !== authenticatedContext.user.id) refreshed = null;
          else { const user = await auth.userById(authenticatedContext.user.id); refreshed = user ? { user, via: 'token' } : null; }
        } else {
          refreshed = await auth.authenticate(req);
        }
        if (!refreshed || refreshed.user.id !== authenticatedContext.user.id) {
          throw new Error('authorization expired');
        }
        if (kind === 'stream') {
          const again = await accessibleSession(context_, sessionId, refreshed, 'view', true);
          if ((hasPermission(refreshed.user, 'sessions.control') ? again.access : 'view') !== access || again.grantId !== grantId) throw new Error('authorization changed');
        } else { assertPermission(refreshed.user, 'sessions.adb'); await ownedSession(sessionId, refreshed, true); }
      };
      const revalidateSocket = (ws: WebSocket) => {
        let checking = false;
        const timer = setInterval(() => {
          if (checking || ws.readyState !== WebSocket.OPEN) return;
          checking = true;
          void track((async () => {
            try {
              await authorizeSocket();
            } catch {
              ws.close(4003, 'authorization expired');
            } finally {
              checking = false;
            }
          })());
        }, 30_000);
        timer.unref();
        ws.once('close', () => clearInterval(timer));
      };
      if (kind === 'stream') {
        streamWss.handleUpgrade(req, socket, head, ws => {
          let rtc: ReturnType<typeof attachRtcSignaling> | undefined;
          registerAccessConnection(authenticatedContext.user.id, ws, () => rtc?.close());
          const heartbeat = streamHeartbeat(ws);
          // Register first so a concurrent revoke can close the socket. Then re-check the
          // exact grant before any frame or input can reach it.
          if (grantId) {
            registerGrantSocket(session.id, { ws, grantId, userId: authenticatedContext.user.id, name: authenticatedContext.user.displayName, mode: access });
            const timer = setTimeout(() => ws.close(4003, 'share expired'), Math.min(Math.max(0, (grantExpiresAt ?? 0) - Date.now()), 2 ** 31 - 1));
            timer.unref();
            ws.once('close', () => clearTimeout(timer));
          }
          const ready = track((async (): Promise<boolean> => {
            await authorizeSocket();
            if (ws.readyState !== WebSocket.OPEN) return false;
            const inputReady = access === 'view' ? undefined : await hub.openInput(session.id, hostId, ws);
            if (ws.readyState !== WebSocket.OPEN) return false;
            hub.addViewer(session.id, hostId, ws, inputReady);
            rtc = attachRtcSignaling({ socket: ws, hub, sessionId: session.id, hostId, canControl: access !== 'view',
              activity: () => activity.touch(session.id), enabled: new URL(req.url || '/', 'http://local').searchParams.get('transport') === 'webrtc' });
            revalidateSocket(ws);
            return true;
          })().catch(() => {
            if (ws.readyState === WebSocket.OPEN) ws.close(4003, 'share revoked');
            return false;
          }));
          let windowStart = Date.now(), count = 0, pending = 0;
          ws.on('message', raw => {
            if (++pending > 8) { ws.close(1008, 'input backlog exceeded'); return; }
            void ready.then(authorized => {
              pending--;
              if (!authorized || ws.readyState !== WebSocket.OPEN) return;
              let message: Record<string, unknown>;
              try { message = JSON.parse(raw.toString()) as Record<string, unknown>; }
              catch { ws.close(1003, 'invalid JSON'); return; }
              if (!message || typeof message !== 'object' || Array.isArray(message)) { ws.close(1003, 'message must be an object'); return; }
              const rtcHandled = rtc?.handle(message);
              if (heartbeat(message) || rtcHandled) return;
              if (Date.now() - windowStart > 1000) { windowStart = Date.now(); count = 0; }
              if (++count > 60) { ws.close(1008, 'input rate exceeded'); return; }
              const action = classifyStreamMessage(access, message);
              if (action === 'keyframe') {
                hub.requestKeyframe(session.id, hostId, ws);
                return;
              }
              if (action === 'reject') { ws.close(1008, 'view-only access'); return; }
              if (action !== 'input') return;
              activity.touch(session.id);
              try {
                const params = inputParams(message);
                void hub.input(session.id, hostId, ws, message, params).catch(error => {
                  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'input-error', code: error instanceof StreamInputError ? error.code : 'input_rejected', message: statusMessage(error) }));
                });
              } catch { ws.close(1008, 'invalid input'); }
            });
          });
        });
      } else {
        tunnelWss.handleUpgrade(req, socket, head, ws => {
          registerAccessConnection(authenticatedContext.user.id, ws);
          void track(authorizeSocket().then(() => {
            if (ws.readyState !== WebSocket.OPEN) return;
            hub.addTunnel(session.id, hostId, ws);
            revalidateSocket(ws);
          }).catch(() => ws.close(4003, 'authorization changed')));
          if (adbTokenExpiresAt !== undefined) {
            const timer = setTimeout(() => ws.close(4003, 'ADB access token expired'), Math.max(0, adbTokenExpiresAt - Date.now()));
            ws.once('close', () => clearTimeout(timer));
          }
        });
      }
    })().catch(() => {
      if (stopped || socket.destroyed) return;
      console.error('WebSocket upgrade failed');
      void recordServiceLog(context.pool, {
        service: 'server', severity: 'error', code: 'websocket.upgrade_error',
      }).catch(() => {});
      rejectUpgrade(socket, 400);
    }).finally(() => pendingSockets.delete(socket)));
  };
  server.on('upgrade', upgrade);
  return () => {
    if (stopping) return stopping;
    stopped = true;
    server.off('upgrade', upgrade);
    for (const socket of pendingSockets) socket.destroy();
    pendingSockets.clear();
    const closed = [agentWss, streamWss, tunnelWss].map(wss => {
      for (const ws of wss.clients) ws.terminate();
      return new Promise<void>(resolve => wss.close(() => resolve()));
    });
    stopping = Promise.allSettled([...closed, ...tasks]).then(() => {});
    return stopping;
  };
}
