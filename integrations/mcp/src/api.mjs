import { constants } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { t } from './messages.mjs';

export class FarmError extends Error {
  constructor(code, status = 0) { super(code); this.code = code; this.status = status; }
}

export class FarmApi {
  constructor(config, fetchImpl = fetch) { this.config = config; this.fetch = fetchImpl; }
  async request(method, resource, { body, signal, timeoutMs = 45_000, binary = false, allowConflict = false, idempotencyKey } = {}) {
    if (!/^\/api\/[A-Za-z0-9/_?=&.%:-]+$/.test(resource)) throw new FarmError('invalid_resource');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) controller.abort();
    try {
      const response = await this.fetch(this.config.url + resource, {
        method, redirect: 'error', signal: controller.signal,
        headers: { Authorization: 'Bearer ' + this.config.token,
          ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
          ...(body instanceof FormData ? {} : body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
      });
      const limit = binary && response.ok ? 8 * 1024 * 1024 : 4 * 1024 * 1024;
      if (Number(response.headers.get('content-length')) > limit) {
        await response.body?.cancel(); throw new FarmError('response_too_large');
      }
      const chunks = []; let size = 0;
      if (response.body) {
        for await (const chunk of response.body) {
          size += chunk.length;
          if (size > limit) { controller.abort(); throw new FarmError('response_too_large'); }
          chunks.push(chunk);
        }
      }
      const buffer = Buffer.concat(chunks);
      if (binary && response.ok) {
        if (!/^image\/png(?:;|$)/i.test(response.headers.get('content-type') || '') || buffer.length < 24 ||
            !buffer.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) throw new FarmError('invalid_image');
        return buffer;
      }
      let data;
      try { data = JSON.parse(buffer.toString('utf8')); } catch { throw new FarmError('invalid_response', response.status); }
      if (!response.ok && !(allowConflict && response.status === 409 && data.error?.code === 'queue_already_assigned')) {
        const code = typeof data.error?.code === 'string' && /^[a-z0-9_-]{1,80}$/.test(data.error.code) ? data.error.code : 'api_error';
        throw new FarmError(code, response.status);
      }
      return data;
    } catch (error) {
      if (error instanceof FarmError) throw error;
      throw new FarmError(controller.signal.aborted ? 'request_aborted' : 'connection_failed');
    } finally {
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
    }
  }

  async upload(relativePath, signal) {
    const root = this.config.uploadRoot;
    if (!root) throw new FarmError('upload_disabled');
    if (path.isAbsolute(relativePath) || /^[a-z]:/i.test(relativePath) || relativePath.includes('\0') ||
        relativePath.split(/[\\/]/).some(part => part === '..') || !relativePath.toLowerCase().endsWith('.apk')) {
      throw new FarmError('invalid_apk_path');
    }
    let handle;
    try {
      const target = await realpath(path.resolve(root, relativePath));
      const relative = path.relative(root, target);
      if (relative.startsWith('..') || path.isAbsolute(relative)) throw new FarmError('invalid_apk_path');
      handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
      const openedPath = process.platform === 'linux' ? await realpath('/proc/self/fd/' + handle.fd) : await realpath(target);
      const openedRelative = path.relative(root, openedPath);
      if (openedRelative.startsWith('..') || path.isAbsolute(openedRelative)) throw new FarmError('invalid_apk_path');
      const fileStat = await handle.stat();
      const currentStat = await stat(openedPath);
      if (fileStat.dev !== currentStat.dev || fileStat.ino !== currentStat.ino) throw new FarmError('invalid_apk_path');
      if (!fileStat.isFile() || fileStat.size < 4 || fileStat.size > 50 * 1024 * 1024) throw new FarmError('invalid_apk_file');
      // Validate the already-open file, then bound the read even if it grows.
      const bytes = Buffer.alloc(fileStat.size);
      let offset = 0;
      while (offset < bytes.length) {
        const read = await handle.read(bytes, offset, bytes.length - offset, offset);
        if (!read.bytesRead) throw new FarmError('invalid_apk_file');
        offset += read.bytesRead;
      }
      if (bytes.readUInt32LE(0) !== 0x04034b50) throw new FarmError('invalid_apk_file');
      const form = new FormData();
      form.set('file', new Blob([bytes], { type: 'application/vnd.android.package-archive' }), path.basename(target));
      return await this.request('POST', '/api/apps', { body: form, signal, timeoutMs: 180_000 });
    } catch (error) {
      if (error instanceof FarmError) throw error;
      throw new FarmError('invalid_apk_file');
    } finally { await handle?.close(); }
  }

  async release(requestId, signal) {
    const data = await this.request('DELETE', '/api/queue/' + requestId, { signal, allowConflict: true });
    const entry = data.entry || data;
    if (entry.sessionId && ['assigned', 'assigning'].includes(entry.state) && entry.sessionState !== 'released') {
      try { await this.request('DELETE', '/api/sessions/' + entry.sessionId, { signal }); }
      catch (error) {
        if (!(error instanceof FarmError) || error.status !== 404) throw error;
      }
    }
    const current = await this.request('GET', '/api/queue/' + requestId, { signal });
    return { ...current, released: isReleased(current) };
  }
}

export function isReleased(entry) {
  return ['cancelled', 'expired'].includes(entry.state) ||
    (entry.state === 'assigned' && entry.sessionState === 'released' && Boolean(entry.resolvedAt));
}

export function errorResult(error, language = 'en') {
  const code = error instanceof FarmError ? error.code : 'operation_failed';
  const status = error instanceof FarmError ? error.status : 0;
  const result = { code, ...(status ? { httpStatus: status } : {}), message: t('error', { code }, language) };
  return { isError: true, content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
}
