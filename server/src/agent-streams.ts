import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';
import { INPUT_MAX_AGE_MS, readInputMetadata, StreamInputError, type InputMetadata } from './stream-input.js';
interface StreamCommands {
  hasAgent(hostId: string): boolean;
  command(hostId: string, sessionId: string, action: string, params: Record<string, unknown>, timeoutMs?: number, input?: InputMetadata): Promise<Record<string, unknown>>;
}
const MAX_VIEWERS_PER_SESSION = 8;
const MAX_VIEWERS_TOTAL = 128;
const MAX_VIEWER_MEDIA_BUFFER = 256 * 1024;

/** Viewer transport, expiring input and media backpressure share one resource owner. */
export class AgentStreams {
  private readonly viewers = new Map<string, Set<WebSocket>>();
  private readonly viewersWaitingForKeyframe = new WeakSet<WebSocket>();
  private readonly lastKeyframeRequest = new Map<string, number>();
  private readonly viewerTransports = new WeakMap<WebSocket, 'webrtc' | 'websocket'>();
  private readonly inputViewers = new WeakMap<WebSocket, { epoch: string; sequence: number; clockOffset: number; active: boolean }>();
  private readonly streamStopTimers = new Map<string, NodeJS.Timeout>();
  private readonly viewerDrainPolls = new WeakMap<WebSocket, NodeJS.Timeout>();
  private readonly sessionHosts = new Map<string, string>();
  private stopped = false;
  constructor(private readonly transport: StreamCommands) {}

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
      if (this.transport.hasAgent(hostId)) void this.transport.command(hostId, sessionId, 'input-release', { epoch: state.epoch }, 5000).catch(() => {});
    });
    const result = await this.transport.command(hostId, sessionId, 'input-open', { epoch: state.epoch }, 5000);
    if (!state.active || socket.readyState !== WebSocket.OPEN) {
      if (this.transport.hasAgent(hostId)) void this.transport.command(hostId, sessionId, 'input-release', { epoch: state.epoch }, 5000).catch(() => {});
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
      return await this.transport.command(hostId, sessionId, 'input', params, 3000, input);
    } catch (error) {
      // A rejected/expired UP must release contacts even if the browser cannot
      // receive the error or has not closed its socket yet. Never replay input.
      state.active = false;
      if (this.transport.hasAgent(hostId)) void this.transport.command(hostId, sessionId, 'input-release', { epoch: state.epoch }, 5000).catch(() => {});
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
        if (this.transport.hasAgent(hostId)) void this.transport.command(hostId, sessionId, 'stream-start', { relayMedia: false }).catch(() => {});
        const timer = setTimeout(() => {
          this.streamStopTimers.delete(sessionId);
          if (!this.viewers.get(sessionId)?.size && this.transport.hasAgent(hostId)) void this.transport.command(hostId, sessionId, 'stream-stop', {}).catch(() => {});
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
    void this.transport.command(hostId, sessionId, 'video-keyframe', {}, 5000).catch(() => {});
    return true;
  }

  refreshStream(sessionId: string, hostId: string): void {
    const viewers = this.viewers.get(sessionId);
    if (!viewers?.size) return;
    const relayMedia = [...viewers].some(viewer => viewer.readyState === WebSocket.OPEN && this.viewerTransports.get(viewer) !== 'webrtc');
    void this.transport.command(hostId, sessionId, 'stream-start', { relayMedia }).catch(error => {
      for (const viewer of this.viewers.get(sessionId) || []) {
        if (viewer.readyState === WebSocket.OPEN) viewer.send(JSON.stringify({ type: 'error', message: error.message }));
      }
    });
  }

  relay(sessionId: string, hostId: string, message: Record<string, unknown>): void {
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
          this.scheduleKeyframeOnDrain(sessionId, hostId, viewer);
          continue;
        }
        if (this.viewersWaitingForKeyframe.has(viewer) && message.keyframe !== true) {
          this.requestKeyframe(sessionId, hostId, viewer);
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

  }

  closeSession(sessionId: string): void {
    const stopping = this.streamStopTimers.get(sessionId);
    if (stopping) { clearTimeout(stopping); this.streamStopTimers.delete(sessionId); }
    this.sessionHosts.delete(sessionId); this.lastKeyframeRequest.delete(sessionId);
    const viewers = this.viewers.get(sessionId); this.viewers.delete(sessionId);
    for (const viewer of viewers || []) { this.clearViewerDrainPoll(viewer); viewer.close(4001, 'session ended'); }
  }
  dispose(): void {
    this.stopped = true;
    for (const timer of this.streamStopTimers.values()) clearTimeout(timer);
    this.streamStopTimers.clear();
    const sockets = [...this.viewers.values()].flatMap(viewers => [...viewers]);
    this.viewers.clear(); this.sessionHosts.clear(); this.lastKeyframeRequest.clear();
    for (const viewer of sockets) { this.clearViewerDrainPoll(viewer); viewer.terminate(); }
  }
}
