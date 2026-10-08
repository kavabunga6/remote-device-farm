import { uiMessage } from './messages.js';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import type { AgentHub } from './agent.js';

type Options = {
  socket: WebSocket; hub: AgentHub; sessionId: string; hostId: string;
  canControl: boolean; activity: () => void; enabled: boolean;
};

// Signaling inherits the stream socket's origin/auth/share revalidation. The
// browser never chooses its agent, session, peer ID or permission level.
export function attachRtcSignaling({ socket, hub, sessionId, hostId, canControl, activity, enabled }: Options) {
  let closed = false;
  let peerId: string | null = null;
  let pending = false;
  let lastOfferAt = 0;
  let lastRenewAt = 0;
  let lastInputActivity = 0;
  const send = (message: Record<string, unknown>) => {
    if (!closed && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  };
  if (enabled) hub.setViewerTransport(socket, 'webrtc');
  void hub.command(hostId, sessionId, 'rtc-capabilities', {}, 5000).then(data => {
    send({ type: 'rtc-capabilities', available: data.available === true,
      iceServers: Array.isArray(data.iceServers) ? data.iceServers : [],
      ...(typeof data.reason === 'string' ? { reason: data.reason } : {}) });
  }, () => send({ type: 'rtc-capabilities', available: false, iceServers: [], reason: uiMessage('ui.95f3870528cc') }));

  const closePeer = (id: string) => hub.command(hostId, sessionId, 'rtc-close', { peerId: id }, 5000).catch(() => {});
  const close = () => {
    if (closed) return;
    closed = true;
    const id = peerId; peerId = null;
    if (id) void closePeer(id);
  };
  socket.once('close', close);

  const handle = (message: Record<string, unknown>): boolean => {
    if (closed) return true;
    if (message.type === 'ping') {
      // Only a live, still-authorized signaling socket renews the media lease.
      // A data channel alone cannot survive grant revocation indefinitely.
      if (peerId && Date.now() - lastRenewAt >= 1500) {
        lastRenewAt = Date.now();
        const renewedPeer = peerId;
        void hub.command(hostId, sessionId, 'rtc-renew', { peerId }, 4000).then(data => {
          if (closed || peerId !== renewedPeer || !canControl) return;
          if (typeof data.inputActivity === 'number' && data.inputActivity > lastInputActivity) {
            lastInputActivity = data.inputActivity; activity();
          }
        }).catch(() => {});
      }
      return false;
    }
    if (enabled && message.type === 'input') {
      send({ type: 'input-error', code: 'wrong_transport', message: uiMessage('ui.a243bb1cb6e7') });
      return true;
    }
    if (!['rtc-offer', 'rtc-close'].includes(String(message.type))) return false;
    if (!enabled) { send({ type: 'rtc-error', message: uiMessage('ui.e35053b5e05a') }); return true; }
    if (message.type === 'rtc-close') {
      const id = peerId; peerId = null;
      if (id) void closePeer(id);
      return true;
    }
    if (pending || Date.now() - lastOfferAt < 2000) {
      send({ type: 'rtc-error', message: uiMessage('ui.54a9b2e00f66') }); return true;
    }
    const description = message.description as Record<string, unknown> | undefined;
    if (!description || description.type !== 'offer' || typeof description.sdp !== 'string' || description.sdp.length > 128 * 1024) {
      send({ type: 'rtc-error', message: uiMessage('ui.e8849839b378') }); return true;
    }
    pending = true; lastOfferAt = Date.now();
    const previous = peerId;
    const id = randomUUID(); peerId = id; lastInputActivity = 0;
    if (previous) void closePeer(previous);
    void hub.command(hostId, sessionId, 'rtc-offer', {
      peerId: id, description: { type: 'offer', sdp: description.sdp }, canControl,
    }, 15_000).then(data => {
      if (closed || peerId !== id) { void closePeer(id); return; }
      send({ type: 'rtc-answer', peerId: id, description: data.description });
    }, error => {
      void closePeer(id);
      if (peerId === id) peerId = null;
      send({ type: 'rtc-error', message: error instanceof Error ? error.message : uiMessage('ui.eba53be90b65') });
    }).finally(() => { pending = false; });
    return true;
  };
  return { handle, close };
}
