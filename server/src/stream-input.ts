import { diagnostic } from './diagnostics.js';
import WebSocket from 'ws';

export const INPUT_MAX_AGE_MS = 1500;
export type InputMetadata = { epoch: string; seq: number; deadline: number };
export class StreamInputError extends Error {
  constructor(public readonly code: string, message: string) { super(message); }
}
export function readInputMetadata(message: Record<string, unknown>, epoch: string, previousSequence: number, now = Date.now()): InputMetadata {
  if (message.epoch !== epoch) throw new StreamInputError('input_epoch', diagnostic('stream-input.b1cfc65140'));
  if (!Number.isSafeInteger(message.seq) || Number(message.seq) <= previousSequence) throw new StreamInputError('input_sequence', diagnostic('stream-input.022c2a071f'));
  if (typeof message.deadline !== 'number' || !Number.isFinite(message.deadline) || message.deadline <= now || message.deadline > now + INPUT_MAX_AGE_MS + 100) {
    throw new StreamInputError('input_expired', diagnostic('stream-input.b2e4849545'));
  }
  return { epoch, seq: Number(message.seq), deadline: message.deadline };
}

// Native ping/pong also supports older viewers, while application pong gives
// browser code a measurable liveness signal (browser JS cannot send WS ping).
export function streamHeartbeat(socket: WebSocket, { intervalMs = 2000, timeoutMs = 8000, now = Date.now } = {}) {
  let lastSeen = now();
  const alive = () => { lastSeen = now(); };
  socket.on('pong', alive);
  const timer = setInterval(() => {
    if (socket.readyState !== WebSocket.OPEN) return;
    if (now() - lastSeen >= timeoutMs) socket.terminate();
    else socket.ping();
  }, intervalMs);
  timer.unref();
  socket.once('close', () => { clearInterval(timer); socket.off('pong', alive); });
  return (message: Record<string, unknown>): boolean => {
    if (message.type !== 'ping') return false;
    if (typeof message.id !== 'string' || message.id.length > 100) return true;
    alive();
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'pong', id: message.id, serverTime: now() }));
    return true;
  };
}
