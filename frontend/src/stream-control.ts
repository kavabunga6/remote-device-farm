export const HEARTBEAT_INTERVAL_MS = 2_000;
export const HEARTBEAT_TIMEOUT_MS = 8_000;
export const INPUT_BUFFER_LIMIT = 16 * 1024;

/** Deadlines use a peer clock anchored to performance.now(), independent of local wall-clock changes. */
export class StreamControl {
  private epoch = '';
  private sequence = 0;
  private serverTime = 0;
  private clockAt = 0;
  private maxAge = 1_500;
  private pingSequence = 0;
  private pending = new Map<string, number>();
  lastPongAt = 0;
  rttMs: number | null = null;

  ready(message: Record<string, unknown>, now: number): boolean {
    if (typeof message.inputEpoch !== 'string' || !message.inputEpoch || !Number.isFinite(message.serverTime)) return false;
    this.epoch = message.inputEpoch;
    this.sequence = 0;
    this.serverTime = Number(message.serverTime);
    this.clockAt = now;
    this.maxAge = Math.min(1_500, Math.max(100, Number(message.inputMaxAgeMs) || 1_500));
    this.lastPongAt = now;
    this.pending.clear();
    return true;
  }

  ping(now: number) {
    const id = String(++this.pingSequence);
    this.pending.set(id, now);
    for (const [key, sent] of this.pending) if (now - sent > HEARTBEAT_TIMEOUT_MS) this.pending.delete(key);
    return { type: 'ping', id };
  }

  pong(message: Record<string, unknown>, now: number): boolean {
    const sent = this.pending.get(String(message.id));
    if (sent === undefined || !Number.isFinite(message.serverTime)) return false;
    this.pending.delete(String(message.id));
    this.rttMs = Math.max(0, now - sent);
    // Conservative estimate: do not extend a deadline beyond the peer's maximum age.
    this.serverTime = Number(message.serverTime);
    this.clockAt = now;
    this.lastPongAt = now;
    return true;
  }

  input(payload: Record<string, unknown>, now: number) {
    if (!this.epoch || now - this.lastPongAt >= HEARTBEAT_TIMEOUT_MS) return null;
    return { ...payload, type: 'input', epoch: this.epoch, seq: ++this.sequence,
      deadline: Math.floor(this.serverTime + now - this.clockAt + this.maxAge - Math.min(100, this.maxAge / 4)) };
  }
}

export function reconnectDelay(attempt: number, random = Math.random()): number {
  return Math.round(Math.min(10_000, 500 * 2 ** Math.min(5, attempt)) * (0.7 + random * 0.6));
}
