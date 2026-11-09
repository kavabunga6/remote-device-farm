import { uiMessage } from './messages.js';
import { randomUUID } from 'node:crypto';
import type WebSocket from 'ws';
import type { StartupStage } from './startup-progress.js';

export type PendingAgentRequest = {
  ws: WebSocket; hostId: string; sessionId: string; action: string;
  progressWrittenAt?: number; progressStage?: StartupStage;
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  completing?: boolean;
  signal?: AbortSignal;
  onAbort?: () => void;
  diagnosticWrites?: Promise<void>; diagnosticCount?: number; progressLoggedAt?: number;
};

/** Owns RPC deadlines and settlement; AgentHub validates transport identity and protocol messages. */
export class AgentRequests {
  private readonly entries = new Map<string, PendingAgentRequest>();
  get(id: string) { return this.entries.get(id); }
  values() { return this.entries.values(); }
  [Symbol.iterator]() { return this.entries[Symbol.iterator](); }
  take(id: string) {
    const entry = this.entries.get(id);
    if (entry) {
      clearTimeout(entry.timer);
      if (entry.onAbort) entry.signal?.removeEventListener('abort', entry.onAbort);
      this.entries.delete(id);
    }
    return entry;
  }
  async complete(id: string, settle: (entry: PendingAgentRequest) => void) {
    const entry = this.entries.get(id);
    if (!entry || entry.completing) return;
    entry.completing = true;
    await entry.diagnosticWrites;
    if (this.take(id)) settle(entry);
  }
  rejectWhere(predicate: (entry: PendingAgentRequest) => boolean, error: Error) {
    for (const [id, entry] of this.entries) if (predicate(entry)) this.take(id)!.reject(error);
  }
  request(meta: Pick<PendingAgentRequest, 'ws' | 'hostId' | 'sessionId' | 'action'>, timeoutMs: number,
    send: (id: string, fail: (error: Error) => void) => void, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const fail = (error: Error) => this.take(id)?.reject(error);
      const timer = setTimeout(() => fail(new Error(uiMessage('agent.e73e28a04029', {}, 'en'))), timeoutMs);
      const onAbort = signal && (() => fail(signal.reason));
      this.entries.set(id, { ...meta, resolve, reject, timer, signal, onAbort });
      if (signal?.aborted) { onAbort!(); return; }
      if (onAbort) signal?.addEventListener('abort', onAbort, { once: true });
      try { send(id, fail); } catch (error) { fail(error instanceof Error ? error : new Error(String(error))); }
    });
  }
}
