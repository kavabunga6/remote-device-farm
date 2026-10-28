import { diagnostic } from './diagnostics.mjs';
// Input is ephemeral: epochs are explicitly opened, sequences never replay, and
// deadlines are checked both on arrival and immediately before device execution.
export const INPUT_MAX_AGE_MS = 1500;
export const INPUT_MAX_PENDING = 64;

export class InputError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

export class InputGate {
  constructor({ releaseInput, now = Date.now, maxPending = INPUT_MAX_PENDING } = {}) {
    this.releaseInput = releaseInput || (async () => {});
    this.now = now;
    this.maxPending = maxPending;
    this.sessions = new Map();
  }

  open(sessionId, epoch) {
    if (typeof epoch !== 'string' || !/^[a-f0-9-]{36}$/i.test(epoch)) throw new InputError('invalid_epoch', diagnostic('input-gate.b3765d5713'));
    let state = this.sessions.get(sessionId);
    if (!state) { state = { peers: new Map(), tail: Promise.resolve(), pending: 0, owner: null, executing: null, reset: Promise.resolve() }; this.sessions.set(sessionId, state); }
    if (!state.peers.has(epoch)) state.peers.set(epoch, { seq: 0, active: true, generation: 0 });
    else if (!state.peers.get(epoch).active) throw new InputError('input_closed', diagnostic('input-gate.0456f05b87'));
    return { epoch, agentTime: this.now(), inputMaxAgeMs: INPUT_MAX_AGE_MS };
  }

  dispatch(sessionId, meta, params, operation) {
    const state = this.sessions.get(sessionId);
    const peer = state?.peers.get(meta?.epoch);
    if (!peer?.active) throw new InputError('input_closed', diagnostic('input-gate.0456f05b87'));
    if (!Number.isSafeInteger(meta.seq) || meta.seq <= peer.seq) throw new InputError('input_sequence', diagnostic('input-gate.022c2a071f'));
    peer.seq = meta.seq;
    const generation = peer.generation;
    const receivedAt = this.now();
    if (!Number.isFinite(meta.deadline) || meta.deadline <= receivedAt || meta.deadline > receivedAt + INPUT_MAX_AGE_MS + 100) {
      if (params?.kind === 'touch' && params.action === 'up') void this.cancelGesture(sessionId, state, meta.epoch).catch(() => {});
      throw new InputError('input_expired', diagnostic('input-gate.b2e4849545'));
    }
    const releasing = params?.kind === 'touch' && params.action === 'up';
    if (state.pending >= this.maxPending && !releasing) throw new InputError('input_backlog', diagnostic('input-gate.c974019482'));
    // One release per peer may exceed the regular limit, never an unlimited queue.
    if (state.pending >= this.maxPending + 1) {
      if (releasing) void this.cancelGesture(sessionId, state, meta.epoch).catch(() => {});
      throw new InputError('input_backlog', diagnostic('input-gate.c974019482'));
    }
    state.pending++;
    const assertFresh = () => {
      if (!peer.active || peer.generation !== generation || this.sessions.get(sessionId) !== state) throw new InputError('input_closed', diagnostic('input-gate.0456f05b87'));
      if (this.now() >= meta.deadline) throw new InputError('input_expired', diagnostic('input-gate.6de971ea49'));
      if (state.owner && state.owner !== meta.epoch) throw new InputError('input_busy', diagnostic('input-gate.a34bd37dca'));
    };
    const run = state.tail.catch(() => {}).then(async () => {
      await state.reset;
      try {
        assertFresh();
        if (params?.kind === 'touch' && params.action === 'down') state.owner = meta.epoch;
        state.executing = meta.epoch;
        const result = await operation(assertFresh);
        if (releasing && state.owner === meta.epoch) state.owner = null;
        return result;
      } catch (error) {
        if (state.owner === meta.epoch) await this.resetContacts(sessionId, state, meta.epoch);
        throw error;
      } finally { if (state.executing === meta.epoch) state.executing = null; }
    });
    state.tail = run.catch(() => {});
    return run.finally(() => { state.pending--; });
  }

  cancelGesture(sessionId, state, epoch) {
    const peer = state.peers.get(epoch);
    if (peer) peer.generation++;
    return this.resetContacts(sessionId, state, epoch);
  }

  resetContacts(sessionId, state, epoch) {
    if (epoch && state.owner !== epoch && state.executing !== epoch) return state.reset;
    state.owner = null;
    const reset = state.reset.catch(() => {}).then(() => this.releaseInput(sessionId));
    state.reset = reset.catch(() => {});
    return reset;
  }

  async release(sessionId, epoch) {
    const state = this.sessions.get(sessionId);
    if (!state) return { released: false };
    const peer = state.peers.get(epoch);
    if (!peer || !peer.active) return { released: false };
    peer.active = false;
    await this.resetContacts(sessionId, state, epoch);
    // Remove only after all closures that captured this epoch have been invalidated.
    state.tail.finally(() => {
      if (state.peers.get(epoch) === peer) state.peers.delete(epoch);
      if (!state.peers.size && !state.pending && this.sessions.get(sessionId) === state) this.sessions.delete(sessionId);
    }).catch(() => {});
    return { released: true };
  }

  async disconnect() {
    await Promise.allSettled([...this.sessions].flatMap(([sessionId, state]) => [...state.peers.keys()].map(epoch => this.release(sessionId, epoch))));
  }

  async disposeSession(sessionId) {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    for (const peer of state.peers.values()) peer.active = false;
    await this.resetContacts(sessionId, state);
    this.sessions.delete(sessionId);
  }
}
