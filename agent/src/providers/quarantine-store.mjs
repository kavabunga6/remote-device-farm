import { mkdir, readFile, rename, open } from 'node:fs/promises';
import path from 'node:path';

// Durable record of the cleanliness of physical devices. It is a POSITIVE list: a device may be leased only if it
// has a `clean` record, i.e. a wipe + verify succeeded for it. Anything the store has never seen (new phone, lost or
// reset state file) is therefore treated as unverified, never as clean.
//   clean        last wipe was verified; the only state in which a device can be leased
//   dirty        leased (or lost mid-lease) and not yet wiped+verified; never offered until it is
//   quarantined  wipe failed / device vanished; stays out of rotation until an admin runs a successful sanitize
// Persisted so that an agent crash or restart can never put a used phone back into rotation.
export class QuarantineStore {
  constructor(dir, file = 'device-state.json') {
    this.file = path.join(dir, file);
    this.dir = dir;
    this.state = { dirty: {}, quarantined: {}, clean: {} };
    this.ready = false;
    this.queue = Promise.resolve();
  }

  async load() {
    try { this.state = { dirty: {}, quarantined: {}, clean: {}, ...JSON.parse(await readFile(this.file, 'utf8')) }; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await mkdir(this.dir, { recursive: true });
    await this.save();
    this.ready = true;
  }

  save() {
    const run = async () => {
      const tmp = `${this.file}.tmp`;
      const file = await open(tmp, 'w', 0o600);
      try { await file.writeFile(JSON.stringify(this.state)); await file.sync(); }
      finally { await file.close(); }
      await rename(tmp, this.file);
      // Atomic rename is not crash durability until the directory entry is synced.
      if (process.platform !== 'win32') {
        const dir = await open(this.dir, 'r');
        try { await dir.sync(); } finally { await dir.close(); }
      }
    };
    this.queue = this.queue.catch(() => {}).then(run).catch(error => { this.ready = false; throw error; });
    return this.queue;
  }

  isDirty(key) { return Object.hasOwn(this.state.dirty, key); }
  isClean(key) { return Object.hasOwn(this.state.clean, key) && !this.isDirty(key) && !this.isQuarantined(key); }
  isQuarantined(key) { return Object.hasOwn(this.state.quarantined, key); }
  reason(key) { return this.state.quarantined[key]?.reason ?? null; }
  dirtyKeys() { return Object.keys(this.state.dirty); }
  sessionOf(key) { return this.state.dirty[key]?.sessionId ?? null; }
  canaryOf(key) { return this.state.dirty[key]?.canary ?? null; }

  // Leaving "clean" is persisted before anything else happens to the device.
  async markDirty(key, sessionId = null, { canary = null } = {}) {
    delete this.state.clean[key];
    this.state.dirty[key] = { since: new Date().toISOString(), sessionId, canary };
    await this.save();
  }
  // The session is over: a restart must wipe the device, not resurrect the session.
  async detachSession(key) {
    if (this.state.dirty[key]) { this.state.dirty[key].sessionId = null; await this.save(); }
  }
  async markClean(key) {
    delete this.state.dirty[key];
    delete this.state.quarantined[key];
    this.state.clean[key] = { verifiedAt: new Date().toISOString() };
    await this.save();
  }
  async quarantine(key, reason) {
    delete this.state.clean[key];
    this.state.quarantined[key] = { reason: String(reason).slice(0, 300), since: new Date().toISOString() };
    await this.save();
  }
}
