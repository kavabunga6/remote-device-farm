// Routes agent commands to the provider that owns the session. This is the only place that knows several
// provider kinds exist; main.mjs stays free of `if (emulator) … else if (usb) …`.
export class ProviderRegistry {
  constructor(providers) {
    this.providers = new Map(providers.map((p) => [p.kind, p]));
    this.defaultKind = 'emulator';
  }

  get(kind) {
    const provider = this.providers.get(kind);
    if (!provider) throw new Error('Unsupported device kind');
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
    if (!session || session.cleanupPending || session.startupPending) throw new Error('Session is not running on this agent');
    return { provider, session };
  }

  async start(sessionId, params, options) {
    const existing = this.owner(sessionId);
    if (existing) {
      const current = existing.sessions.get(sessionId);
      if (current.cleanupPending) throw new Error('Previous session cleanup is still pending');
      if (current.startupPending) throw new Error('Session startup is still pending');
      return existing.describe(current);
    }
    return this.get(params?.kind ?? this.defaultKind).start(sessionId, params, options);
  }

  async stop(sessionId, options) { await this.owner(sessionId)?.stop(sessionId, options); }

  execute(action, sessionId, params) {
    const { provider, session } = this.require(sessionId);
    const op = provider.ops[action];
    if (!op) throw new Error(`"${action}" is not supported for ${provider.kind} devices`);
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
    throw new Error('No device matched this action');
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

  async describeProviders() {
    return Promise.all([...this.providers.values()].map(async (p) =>
      ({ kind: p.kind, platform: p.platform, capabilities: p.capabilities,
        devices: await p.inventory().catch(() => []) })));
  }
}
