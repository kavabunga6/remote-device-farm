import { diagnostic } from './diagnostics.mjs';
import { installApkSet } from './apk-sets.mjs';
import { runProcess } from './adb.mjs';
import { agentMessage } from './messages.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, open, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const MAX_TRANSFER_BYTES = 1024 * 1024 * 1024;
export const MAX_CHUNK_BYTES = 8 * 1024 * 1024;
const IDLE_MS = 120_000;
const MAX_ACTIVE = 4;

const validName = (name) => typeof name === 'string' && /^[^\/\p{C}]{1,240}$/u.test(name) && name !== '.' && name !== '..';

// Chunked APK transfer: chunks are appended to a temp file, so memory stays bounded by one chunk.
export class AppTransfers {
  constructor(adb, { tmpRoot = os.tmpdir(), idleMs = IDLE_MS } = {}) {
    this.adb = adb;
    this.tmpRoot = tmpRoot;
    this.idleMs = idleMs;
    this.active = new Map();
    this.opening = new Set();
  }

  async begin(sessionId, { name, size, sha256 }) {
    if (!validName(name) || !/\.(apk|apks|zip)$/i.test(name)) throw new Error(agentMessage('apps.invalidSet'));
    if (!Number.isInteger(size) || size < 1 || size > MAX_TRANSFER_BYTES) throw new Error(diagnostic('app-transfer.3964773ef3'));
    if (sha256 !== undefined && !/^[a-f0-9]{64}$/.test(sha256)) throw new Error(diagnostic('app-transfer.17eba61e97'));
    if (this.opening.has(sessionId)) throw new Error(diagnostic('app-transfer.b0f30aeea9'));
    for (const t of this.active.values()) if (t.sessionId === sessionId) throw new Error(diagnostic('app-transfer.b0f30aeea9'));
    if (this.active.size + this.opening.size >= MAX_ACTIVE) throw new Error(diagnostic('app-transfer.69b13e9989'));
    this.opening.add(sessionId);
    let directory;
    try {
      directory = await mkdtemp(path.join(this.tmpRoot, 'rdf-app-'));
      const local = path.join(directory, name);
      const handle = await open(local, 'wx', 0o600);
      const id = randomUUID();
      const transfer = { id, sessionId, name, size, sha256, directory, local, handle, received: 0, next: 0,
        hash: createHash('sha256'), timer: null, busy: false };
      this.active.set(id, transfer);
      this.arm(transfer);
      return { transferId: id };
    } catch (error) {
      if (directory) await rm(directory, { recursive: true, force: true }).catch(() => {});
      throw error;
    } finally {
      this.opening.delete(sessionId);
    }
  }

  arm(transfer) {
    clearTimeout(transfer.timer);
    transfer.timer = setTimeout(() => { void this.discard(transfer.id); }, this.idleMs);
    transfer.timer.unref?.();
  }

  get(sessionId, transferId) {
    const transfer = typeof transferId === 'string' ? this.active.get(transferId) : undefined;
    if (!transfer || transfer.sessionId !== sessionId) throw new Error(diagnostic('app-transfer.e67d3d5cd9'));
    return transfer;
  }

  async chunk(sessionId, { transferId, index, contentBase64 }) {
    const transfer = this.get(sessionId, transferId);
    if (transfer.busy) throw new Error(diagnostic('app-transfer.379bbc435e'));
    transfer.busy = true;
    clearTimeout(transfer.timer);
    try {
      if (index !== transfer.next) throw new Error(diagnostic('app-transfer.6dd790ed18'));
      if (typeof contentBase64 !== 'string' || contentBase64.length > Math.ceil(MAX_CHUNK_BYTES / 3) * 4 + 4 ||
          !/^[A-Za-z0-9+/]*={0,2}$/.test(contentBase64)) throw new Error(diagnostic('app-transfer.6e5a95024e'));
      const data = Buffer.from(contentBase64, 'base64');
      if (data.length === 0 || data.length > MAX_CHUNK_BYTES) throw new Error(diagnostic('app-transfer.a84f14d1d6'));
      if (transfer.received + data.length > transfer.size) throw new Error(diagnostic('app-transfer.a77e2b8168'));
      let offset = 0;
      while (offset < data.length) {
        const { bytesWritten } = await transfer.handle.write(data, offset, data.length - offset);
        if (bytesWritten < 1) throw new Error(diagnostic('app-transfer.2332d75d69'));
        offset += bytesWritten;
      }
      transfer.hash.update(data);
      transfer.received += data.length;
      transfer.next += 1;
      this.arm(transfer);
      return { received: transfer.received };
    } catch (error) {
      await this.discard(transferId);
      throw error;
    } finally {
      transfer.busy = false;
    }
  }

  async finish(sessionId, serial, { transferId }) {
    const transfer = this.get(sessionId, transferId);
    if (transfer.busy) throw new Error(diagnostic('app-transfer.379bbc435e'));
    transfer.busy = true;
    clearTimeout(transfer.timer);
    try {
      if (transfer.received !== transfer.size) throw new Error(diagnostic('app-transfer.9761875bcc'));
      if (transfer.sha256 && transfer.hash.digest('hex') !== transfer.sha256) throw new Error(diagnostic('app-transfer.e3a1ad2b99'));
      await transfer.handle.close();
      await this.adb.connect(serial);
      if (!transfer.name.toLowerCase().endsWith('.apk')) return await installApkSet(this.adb, serial, transfer, runProcess);
      const result = await this.adb.run(serial, ['install', '-r', transfer.local], { timeoutMs: 300_000 });
      if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout || diagnostic('app-transfer.33b4717bdc'));
      return { installed: true, output: result.stdout };
    } finally {
      await this.discard(transferId);
      transfer.busy = false;
    }
  }

  async abort(sessionId, transferId) {
    this.get(sessionId, transferId);
    await this.discard(transferId);
  }

  async discard(transferId) {
    const transfer = this.active.get(transferId);
    if (!transfer) return;
    this.active.delete(transferId);
    clearTimeout(transfer.timer);
    await transfer.handle.close().catch(() => {});
    await rm(transfer.directory, { recursive: true, force: true }).catch(() => {});
  }

  async discardSession(sessionId) {
    for (const t of [...this.active.values()]) if (t.sessionId === sessionId) await this.discard(t.id);
  }
}
