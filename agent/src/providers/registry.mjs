import { redactDiagnostic } from '../session-diagnostics.mjs';
import { agentMessage } from '../messages.mjs';
// Routes agent commands to the provider that owns the session. This is the only place that knows several
// provider kinds exist; main.mjs stays free of `if (emulator) … else if (usb) …`.
export class ProviderRegistry {
  constructor(providers) {
    this.providers = new Map(providers.map((p) => [p.kind, p]));
    this.failures = new Map();
    this.defaultKind = 'emulator';
  }

  get(kind) {
    const provider = this.providers.get(kind);
    if (!provider) throw new Error(agentMessage('agent.5c9e04a77662'));
    return provider;
  }

  owner(sessionId) {
    for (const p of this.providers.values()) if (p.sessions.has(sessionId)) return p;
    return null;
  }

  *allSessions() { for (const p of this.providers.values()) yield* p.sessions; }

  require(sessionId) {
    const provider = this.owner(sessionId);
    const session = provider?.sessions.get(sessionId);
    if (!session || session.cleanupPending || session.startupPending) throw new Error(agentMessage('agent.a14b4d584e08'));
    return { provider, session };
  }

  async start(sessionId, params, options) {
    const existing = this.owner(sessionId);
    if (existing) {
      const current = existing.sessions.get(sessionId);
      if (current.cleanupPending) throw new Error(agentMessage('agent.2162454b0b76'));
      if (current.startupPending) throw new Error(agentMessage('agent.eb3597029ef9'));
      return existing.describe(current);
    }
    return this.get(params?.kind ?? this.defaultKind).start(sessionId, params, options);
  }

  async stop(sessionId, options) { await this.owner(sessionId)?.stop(sessionId, options); }

  execute(action, sessionId, params) {
    const { provider, session } = this.require(sessionId);
    const op = provider.ops[action];
    if (!op) throw new Error(agentMessage('agent.unsupportedAction', { p0: action, p1: provider.kind }));
    const required = [...provider.capabilityMap()].find(([, actions]) => actions.includes(action))?.[0];
    if (required && !provider.sessionCapabilities(session).includes(required) && !(action === 'audio' && params?.enabled === false)) {
      const error = new Error(agentMessage('agent.1c2b5b00ab42'));
      error.code = 'device_capability_unavailable';
      throw error;
    }
    return op(session, params, { sessionId });
  }

  // Several providers may implement the same node action (device-sanitize); each declines with `undefined`
  // when the request is not for it.
  async nodeAction(action, params) {
    for (const p of this.providers.values()) {
      if (!(action in p.nodeOps)) continue;
      const result = await p.nodeOps[action](params);
      if (result !== undefined) return result;
    }
    throw new Error(agentMessage('agent.66cfc47a68a2'));
  }

  isNodeAction(action) { return [...this.providers.values()].some((p) => action in p.nodeOps); }

  // A failed teardown keeps the slot/device blocked; after repeated failures the admins are told.
  cleanupFailed(sessionId, error) {
    const provider = this.owner(sessionId);
    const entry = provider?.sessions.get(sessionId);
    if (!entry) return;
    entry.cleanupPending = true;
    entry.cleanupFailures = (entry.cleanupFailures ?? 0) + 1;
    provider.onCleanupFailure?.(sessionId, entry, error);
  }

  async recoverAll() { for (const p of this.providers.values()) await p.recover(); }

  activeSessions() { return [...this.providers.values()].flatMap((p) => p.activeSessions()); }

  recordProbe(kind, phase, failed, error) {
    let failures = this.failures.get(kind);
    if (!failures) { failures = new Set(); this.failures.set(kind, failures); }
    if (failed && !failures.has(phase)) console.warn(agentMessage('agent.providerFailure', { p0: kind, p1: phase, p2: redactDiagnostic(error?.message ?? '') }));
    if (!failed && failures.has(phase)) console.info(agentMessage('agent.providerRecovered', { p0: kind, p1: phase }));
    if (failed) failures.add(phase); else failures.delete(phase);
  }

  async reconcile(kind) {
    try { const sessions = await this.get(kind).reconcile(); this.recordProbe(kind, 'reconcile', false); return sessions; }
    catch (error) { this.recordProbe(kind, 'reconcile', true, error); return []; }
  }

  async maintainAll(options) {
    for (const provider of this.providers.values()) {
      try { await provider.maintain(options); this.recordProbe(provider.kind, 'maintenance', false); }
      catch (error) { this.recordProbe(provider.kind, 'maintenance', true, error); }
    }
  }

  async describeProviders() {
    return Promise.all([...this.providers.values()].map(async provider => {
      let devices = [];
      try { devices = await provider.inventory(); this.recordProbe(provider.kind, 'inventory', false); }
      catch (error) { this.recordProbe(provider.kind, 'inventory', true, error); }
      const failed = ['inventory', 'reconcile', 'maintenance'].find(phase => this.failures.get(provider.kind)?.has(phase));
      return { kind: provider.kind, platform: provider.platform, capabilities: provider.capabilities,
        status: failed ? 'unavailable' : 'ready', code: failed ? failed + '-unavailable' : null,
        devices: failed ? [] : devices };
    }));
  }
}
