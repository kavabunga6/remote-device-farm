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
    if (!validName(name) || !name.toLowerCase().endsWith('.apk')) throw new Error('Invalid upload name');
    if (!Number.isInteger(size) || size < 1 || size > MAX_TRANSFER_BYTES) throw new Error('Invalid transfer size');
    if (sha256 !== undefined && !/^[a-f0-9]{64}$/.test(sha256)) throw new Error('Invalid checksum');
    if (this.opening.has(sessionId)) throw new Error('Another transfer is in progress');
    for (const t of this.active.values()) if (t.sessionId === sessionId) throw new Error('Another transfer is in progress');
    if (this.active.size + this.opening.size >= MAX_ACTIVE) throw new Error('Too many transfers in progress');
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
    if (!transfer || transfer.sessionId !== sessionId) throw new Error('Unknown transfer');
    return transfer;
  }

  async chunk(sessionId, { transferId, index, contentBase64 }) {
    const transfer = this.get(sessionId, transferId);
    if (transfer.busy) throw new Error('Transfer is busy');
    transfer.busy = true;
    clearTimeout(transfer.timer);
    try {
      if (index !== transfer.next) throw new Error('Chunk out of order');
      if (typeof contentBase64 !== 'string' || contentBase64.length > Math.ceil(MAX_CHUNK_BYTES / 3) * 4 + 4 ||
          !/^[A-Za-z0-9+/]*={0,2}$/.test(contentBase64)) throw new Error('Invalid chunk data');
      const data = Buffer.from(contentBase64, 'base64');
      if (data.length === 0 || data.length > MAX_CHUNK_BYTES) throw new Error('Invalid chunk size');
      if (transfer.received + data.length > transfer.size) throw new Error('Transfer exceeds declared size');
      let offset = 0;
      while (offset < data.length) {
        const { bytesWritten } = await transfer.handle.write(data, offset, data.length - offset);
        if (bytesWritten < 1) throw new Error('Could not write transfer chunk');
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
    if (transfer.busy) throw new Error('Transfer is busy');
    transfer.busy = true;
    clearTimeout(transfer.timer);
    try {
      if (transfer.received !== transfer.size) throw new Error('Transfer is incomplete');
      if (transfer.sha256 && transfer.hash.digest('hex') !== transfer.sha256) throw new Error('Checksum mismatch');
      await transfer.handle.close();
      await this.adb.connect(serial);
      const result = await this.adb.run(serial, ['install', '-r', transfer.local], { timeoutMs: 300_000 });
      if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout || 'Install failed');
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
