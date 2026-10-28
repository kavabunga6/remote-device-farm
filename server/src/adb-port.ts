import { diagnostic } from './diagnostics.js';
import { registerAccessResource } from './access-connections.js';
import { recordServiceLog } from './service-log.js';
import net, { type Server, type Socket } from 'node:net';
import type { Pool } from 'pg';
import type { Config } from './config.js';
import type { AgentHub } from './agent.js';
import {
  ADB_AUTH_SIGNATURE, ADB_AUTH_TOKEN, ADB_COMMAND_AUTH, ADB_COMMAND_CONNECT,
  adbFrame, newAdbChallenge, parseAdbPublicKey, readAdbHandshakeFrame, verifyAdbSignature,
} from './adb-wire.js';

type Lease = {
  session_id: string;
  host_id: string;
  owner_user_id: string;
  public_key: string;
  fingerprint: string;
  expires_at: Date | null;
};

const MAX_CONNECTIONS = 128;
const MAX_PER_IP = 8;

export class AdbPortBroker {
  private readonly servers: Server[] = [];
  private readonly sockets = new Set<Socket>();
  private readonly sessionSockets = new Map<string, Set<Socket>>();

  constructor(private readonly pool: Pool, private readonly hub: AgentHub, private readonly config: Config) {
    hub.onSessionClosed(sessionId => this.closeSession(sessionId));
  }

  async start(): Promise<void> {
    const ports = this.config.adbPorts;
    if (!ports) return;
    try {
      for (let port = ports.start; port < ports.start + ports.count; port++) {
        const server = net.createServer(socket => { void this.handle(port, socket); });
        server.on('error', () => {
          console.error(diagnostic('adb-port.24bb25e0fc'));
          void recordServiceLog(this.pool, {
            service: 'server', severity: 'error', code: 'adb.listener_error',
          }).catch(() => {});
        });
        await new Promise<void>((resolve, reject) => {
          server.once('error', reject);
          server.listen(port, '0.0.0.0', () => { server.off('error', reject); resolve(); });
        });
        this.servers.push(server);
      }
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async stop(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    await Promise.all(this.servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  }

  hasActiveSocket(sessionId: string): boolean {
    return (this.sessionSockets.get(sessionId)?.size ?? 0) > 0;
  }

  closeSession(sessionId: string): void {
    for (const socket of this.sessionSockets.get(sessionId) || []) socket.destroy();
    this.sessionSockets.delete(sessionId);
  }

  private async lease(port: number): Promise<Lease | null> {
    const result = await this.pool.query(
      "SELECT a.session_id,s.host_id,a.owner_user_id,a.public_key,a.fingerprint,a.expires_at FROM adb_port_access a " +
      "JOIN sessions s ON s.id=a.session_id JOIN users u ON u.id=a.owner_user_id JOIN access_roles r ON r.id=u.access_role_id " +
      "WHERE a.port=$1 AND u.removed_at IS NULL AND (a.expires_at IS NULL OR a.expires_at>now()) AND s.state='running' " +
      "AND (r.builtin=\'admin\' OR \'sessions.adb\'=ANY(r.permissions)) AND (a.owner_user_id=s.owner_user_id OR r.builtin=\'admin\' OR \'sessions.manageAll\'=ANY(r.permissions))",
      [port],
    );
    return result.rows[0] || null;
  }

  private async stillAuthorized(port: number, lease: Lease): Promise<boolean> {
    const current = await this.lease(port);
    return Boolean(current && current.session_id === lease.session_id &&
      current.host_id === lease.host_id && current.owner_user_id === lease.owner_user_id &&
      current.fingerprint === lease.fingerprint);
  }

  private async handle(port: number, socket: Socket): Promise<void> {
    const ip = socket.remoteAddress || '';
    let sameIp = 0;
    for (const active of this.sockets) if (active.remoteAddress === ip) sameIp++;
    if (this.sockets.size >= MAX_CONNECTIONS || sameIp >= MAX_PER_IP) { socket.destroy(); return; }
    this.sockets.add(socket);
    socket.once('close', () => this.sockets.delete(socket));
    socket.on('error', () => {});
    socket.pause();
    socket.setNoDelay(true);
    socket.setTimeout(12_000, () => socket.destroy());
    let lease: Lease | null;
    try { lease = await this.lease(port); }
    catch { socket.destroy(); return; }
    if (!lease || socket.destroyed || !this.hub.hasAgent(lease.host_id)) { socket.destroy(); return; }
    let key;
    try { key = parseAdbPublicKey(lease.public_key).key; }
    catch { socket.destroy(); return; }
    let activeSockets = this.sessionSockets.get(lease.session_id);
    if (!activeSockets) { activeSockets = new Set(); this.sessionSockets.set(lease.session_id, activeSockets); }
    activeSockets.add(socket);
    socket.once('close', () => {
      activeSockets!.delete(socket);
      if (!activeSockets!.size && this.sessionSockets.get(lease!.session_id) === activeSockets) this.sessionSockets.delete(lease!.session_id);
    });
    let stage: 'connect' | 'signature' | 'relay' = 'connect';
    let buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let initial: Buffer | null = null;
    let challenge: Buffer | null = null;
    let failures = 0;
    const fail = () => socket.destroy();
    const onData = (chunk: Buffer) => {
      try {
        buffer = Buffer.concat([buffer, chunk]);
        if (buffer.length > 8192) { fail(); return; }
        while (stage !== 'relay') {
          const parsed = readAdbHandshakeFrame(buffer);
          if (!parsed) return;
          buffer = parsed.rest;
          const { packet } = parsed;
          if (stage === 'connect') {
            if (packet.command !== ADB_COMMAND_CONNECT ||
                packet.arg0 < 0x01000000 || packet.arg1 < 4096) { fail(); return; }
            initial = Buffer.from(packet.frame);
            challenge = newAdbChallenge();
            socket.write(adbFrame(ADB_COMMAND_AUTH, ADB_AUTH_TOKEN, 0, challenge));
            stage = 'signature';
            continue;
          }
          if (packet.command !== ADB_COMMAND_AUTH || packet.arg0 !== ADB_AUTH_SIGNATURE ||
              !challenge || packet.payload.length !== 256) { fail(); return; }
          if (!verifyAdbSignature(key, challenge, packet.payload)) {
            if (++failures >= 3) { fail(); return; }
            challenge = newAdbChallenge();
            socket.write(adbFrame(ADB_COMMAND_AUTH, ADB_AUTH_TOKEN, 0, challenge));
            continue;
          }
          stage = 'relay';
          socket.pause();
          socket.off('data', onData);
          socket.setTimeout(0);
          const first = Buffer.concat([initial!, buffer]);
          buffer = Buffer.alloc(0);
          void this.activate(port, lease!, socket, first);
        }
      } catch { fail(); }
    };
    socket.on('data', onData);
    socket.resume();
  }

  private async activate(port: number, lease: Lease, socket: Socket, first: Buffer): Promise<void> {
    if (socket.destroyed) return;
    const unregister = registerAccessResource(lease.owner_user_id, () => socket.destroy());
    socket.once('close', unregister);
    try {
      if (socket.destroyed || (lease.expires_at && Date.now() >= new Date(lease.expires_at).getTime()) ||
          !await this.stillAuthorized(port, lease) || socket.destroyed) { socket.destroy(); return; }
      const expiry = lease.expires_at
        ? setTimeout(() => socket.destroy(), Math.max(1, new Date(lease.expires_at).getTime() - Date.now()))
        : null;
      expiry?.unref();
      const recheck = setInterval(() => {
        void this.stillAuthorized(port, lease).then(ok => { if (!ok) socket.destroy(); })
          .catch(() => socket.destroy());
      }, 10_000);
      recheck.unref();
      socket.once('close', () => { if (expiry) clearTimeout(expiry); clearInterval(recheck); });
      if (!this.hub.addDeviceTunnel(lease.session_id, lease.host_id, socket, first)) {
        socket.destroy();
        return;
      }
      socket.resume();
    } catch { socket.destroy(); }
  }
}

