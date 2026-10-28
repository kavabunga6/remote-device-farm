import { diagnostic } from '../diagnostics.mjs';
import { agentMessage } from '../messages.mjs';
import { DeviceProvider } from './base.mjs';
import { sanitize } from './wipe.mjs';

// Lease/wipe/quarantine lifecycle shared by every physical-device provider (currently USB Android).
// Invariants (fail closed):
//  * a device is offered only if the store holds a verified `clean` record for it (unknown = unverified);
//  * it becomes dirty *before* the lease is handed out, and the dirty mark is on disk first;
//  * it returns to rotation solely after wipe + verify succeed; one wipe per device at a time.
export class PhysicalDeviceProvider extends DeviceProvider {
  constructor(meta, { store, wiper, alert = () => {} }) {
    super(meta);
    Object.assign(this, { store, wiper, alert });
    this.cleaning = new Set();
    this.locks = new Map();
  }

  /** Identifier used as the store key and by the broker, e.g. adb serial or UDID. */
  deviceId(entry) { return entry.id; }
  key(id) { return `${this.kind}:${id}`; }

  deviceState(id, base = 'free') {
    const key = this.key(id);
    if (this.store.isQuarantined(key)) return 'quarantined';
    if (this.store.isDirty(key)) return [...this.sessions.values()].some((e) => this.deviceId(e) === id) ? 'busy' : 'cleaning';
    if (!this.store.isClean(key)) return 'unverified';
    return base;
  }

  assertCanLease(id) {
    if (!this.store.ready) throw new Error(agentMessage('agent.a13554e0b9b5'));
    if (!this.wiper) throw new Error(agentMessage('agent.noWiper', { p0: this.kind }));
    const key = this.key(id);
    if (this.store.isQuarantined(key)) throw new Error(agentMessage('agent.quarantined', { p0: this.store.reason(key) }));
    if ([...this.sessions.values()].some((e) => this.deviceId(e) === id)) throw new Error(agentMessage('agent.94a6b461a77a'));
    if (this.store.isDirty(key)) throw new Error(agentMessage('agent.a3e284efaef3'));
    if (!this.store.isClean(key)) throw new Error(agentMessage('agent.36ca4f18c906'));
  }

  async lease(sessionId, entry) {
    const id = this.deviceId(entry);
    this.assertCanLease(id);
    // Plant evidence a full wipe must destroy; if that is impossible the device is not leased at all.
    const canary = await this.wiper.arm?.(id) ?? null;
    this.assertCanLease(id); // state may have changed while arming
    await this.store.markDirty(this.key(id), sessionId, { canary });
    this.sessions.set(sessionId, entry);
  }

  // Ends the session at once and wipes in the background: a wipe can take minutes and must not hold the user's
  // release (or the broker's kill) hostage. The device stays "cleaning" (dirty on disk, so also across a crash)
  // and is leasable again only after wipe + verify succeed; otherwise it is quarantined and admins are alerted.
  async stop(sessionId) {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    await this.beforeWipe(sessionId, entry);
    const id = this.deviceId(entry);
    await this.store.detachSession(this.key(id));
    this.sessions.delete(sessionId);
    this.startCleaning(id, 'session ended');
  }

  startCleaning(id, context) {
    if (this.locks.has(id)) return;
    const job = this.cleanDevice(id, context).catch((error) => console.error(diagnostic('physical.0ae08a9bf1', { p0: id, p1: error.message })))
      .finally(() => this.cleaning.delete(job));
    this.cleaning.add(job);
  }

  /** Resolves when every background wipe has finished (tests, graceful shutdown). */
  async settled() { while (this.cleaning.size) await Promise.allSettled([...this.cleaning]); }

  async beforeWipe() {}

  // One wipe per device at a time: a second one racing the first could mark the device clean while it is still
  // being erased (or erase it again after it was leased).
  async cleanDevice(id, context) {
    if (this.locks.has(id)) throw new Error(agentMessage('agent.4603ecd59333'));
    const key = this.key(id);
    const done = (async () => {
      const ctx = { canary: this.store.canaryOf(key) };
      const result = this.wiper ? await sanitize(this.wiper, id, ctx) : { ok: false, reason: diagnostic('physical.68e39a641f') };
      if (result.ok) { await this.store.markClean(key); return true; }
      const reason = `${context}: ${result.reason}`;
      await this.store.quarantine(key, reason);
      this.alert({ id: `quarantine:${key}:${Date.now()}`, event: 'device.quarantined', kind: this.kind, deviceId: id, reason });
      return false;
    })();
    this.locks.set(id, done);
    try { return await done; } finally { this.locks.delete(id); }
  }

  /** Subclasses: ids of attached, usable devices that this agent is allowed to manage. */
  async listIds() { return []; }

  // Heartbeat hook: any managed device that is attached but has no verified-clean record (new phone, lost state
  // file, ...) is wiped before it can ever be leased. Devices are enrolled via the allowlist, nothing else is touched.
  async maintain() {
    if (!this.store.ready || !this.wiper) return;
    const leased = new Set([...this.sessions.values()].map((e) => this.deviceId(e)));
    for (const id of await this.listIds()) {
      const key = this.key(id);
      if (leased.has(id) || this.locks.has(id) || this.store.isClean(key) || this.store.isQuarantined(key)) continue;
      if (!this.store.isDirty(key)) await this.store.markDirty(key, null);
      this.startCleaning(id, 'enrollment');
    }
  }

  /** Subclasses: is the device attached and usable right now? And how to rebuild a session entry for it. */
  async isPresent() { return false; }
  restoredEntry(id) { return { id }; }

  // Startup. A device that was leased when the agent stopped is either still in use (agent upgrade/restart) or
  // abandoned. We cannot tell, so: put the session back if the phone is still attached and let the broker decide
  // (it kills sessions it no longer knows, and that kill wipes the device). Anything we cannot restore is wiped now,
  // otherwise quarantined.
  async recover() {
    for (const key of this.store.dirtyKeys().filter((k) => k.startsWith(`${this.kind}:`))) {
      if (this.store.isQuarantined(key)) continue;
      const id = key.slice(this.kind.length + 1);
      const sessionId = this.store.sessionOf(key);
      if (sessionId && await this.isPresent(id).catch(() => false)) {
        this.sessions.set(sessionId, this.restoredEntry(id));
        continue;
      }
      this.startCleaning(id, 'dirty after agent restart'); // in the background: startup must not wait for a wipe
    }
  }

  // Admin action: retry the wipe on a quarantined/dirty device and release it only if it now verifies clean.
  get nodeOps() {
    return {
      'device-sanitize': async (params) => {
        if (params?.kind !== this.kind) return undefined;
        const id = String(params?.deviceId ?? '');
        if ([...this.sessions.values()].some((e) => this.deviceId(e) === id)) throw new Error(agentMessage('agent.fe61e1669f6e'));
        if (this.store.isClean(this.key(id))) throw new Error(agentMessage('agent.ba6ac7423541'));
        if (!(await this.listIds()).includes(id)) throw new Error(agentMessage('agent.8e0728d7bf55'));
        return { deviceId: id, clean: await this.cleanDevice(id, 'manual sanitize') };
      },
    };
  }

}
