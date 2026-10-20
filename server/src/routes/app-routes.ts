import { uiMessage } from '../messages.js';
import { randomUUID } from 'node:crypto';
import { mkdir, open, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import type { Express, Request, RequestHandler, Response } from 'express';
import multer from 'multer';
import type { ServerContext } from '../server-context.js';
import type { Session } from '../http-common.js';
import { ApiError, boundedString, isUuid, route, safeUploadName } from '../http-common.js';
import { recordAuditEvent } from '../audit.js';
import {
  DEFAULT_APP_STORE, DownloadError, appFilePath, downloadToFile, ensureUserDir, hasZipMagic,
  parseDownloadUrl, readHead, sha256File, urlHostLabel, inspectApplication,
} from '../app-store.js';

const SINGLE_COMMAND_LIMIT = 50 * 1024 * 1024;
const CHUNK_BYTES = 4 * 1024 * 1024;

type AppRow = {
  id: string; name: string; size_bytes: string | number; sha256: string; package_name: string | null;
  version_name: string | null; note: string | null; uploaded_at: Date | string;
};

const appJson = (row: AppRow) => ({
  id: row.id, name: row.name, size: Number(row.size_bytes), sha256: row.sha256,
  packageName: row.package_name, versionName: row.version_name, note: row.note,
  uploadedAt: new Date(row.uploaded_at).toISOString(),
});

// Browsers send UTF-8 names; multer exposes them as latin1.
function decodeName(original: string): string {
  const utf8 = Buffer.from(original, 'latin1').toString('utf8');
  return utf8.includes('�') ? original : utf8;
}

function downloadStatus(error: DownloadError): ApiError {
  switch (error.code) {
    case 'app_too_large': return new ApiError(413, error.code, error.message);
    case 'download_timeout': return new ApiError(504, error.code, error.message);
    case 'download_failed': case 'too_many_redirects': return new ApiError(502, error.code, error.message);
    default: return new ApiError(400, error.code, error.message);
  }
}

export function registerAppRoutes(app: Express, context: ServerContext): void {
  const { pool, config, hub, requireAuth, current, ownedSession, activity } = context;
  const store = config.apps ?? DEFAULT_APP_STORE;
  const tmpDir = path.join(store.dir, '_tmp');
  void readdir(tmpDir).then(names => Promise.all(names.map(name => rm(path.join(tmpDir, name), { force: true }))), () => undefined);
  const audit = (event: Parameters<typeof recordAuditEvent>[1]) =>
    void recordAuditEvent(pool, event).catch(() => console.error('Audit event persistence failed'));

  async function usage(userId: string) {
    const { rows } = await pool.query('SELECT COUNT(*)::int AS count, COALESCE(SUM(size_bytes),0)::bigint AS used FROM stored_apps WHERE owner_user_id=$1', [userId]);
    return { count: Number(rows[0].count), usedBytes: Number(rows[0].used), maxBytes: store.maxUserBytes, maxApps: store.maxApps, maxFileBytes: store.maxFileBytes };
  }

  // ---- Library ----

  app.get('/api/apps', requireAuth, route(async (_req, res) => {
    const user = current(res).user;
    const { rows } = await pool.query('SELECT * FROM stored_apps WHERE owner_user_id=$1 ORDER BY uploaded_at DESC, id', [user.id]);
    res.json({ apps: rows.map(appJson), usage: await usage(user.id) });
  }));

  const uploading = new Set<string>();
  const upload = multer({
    storage: multer.diskStorage({
      destination: (req, _file, callback) => {
        const user = (req as Request & { appUserId?: string }).appUserId!;
        ensureUserDir(store.dir, user).then(dir => callback(null, dir), error => callback(error as Error, ''));
      },
      filename: (req, _file, callback) => {
        const id = randomUUID();
        (req as Request & { appId?: string }).appId = id;
        callback(null, `${id}.apk`);
      },
    }),
    limits: { fileSize: store.maxFileBytes, files: 1, fields: 4, parts: 5, fieldNameSize: 100, fieldSize: 4096, fieldArrayIndexLimit: 0 },
  });

  const runUpload = (req: Request, res: Response): Promise<void> => new Promise((resolve, reject) => {
    upload.single('file')(req, res, error => {
      if (!error) { resolve(); return; }
      if (error instanceof multer.MulterError) {
        reject(error.code === 'LIMIT_FILE_SIZE'
          ? new ApiError(413, 'app_too_large', uiMessage('ui.7ca24428a99c', { p0: Math.floor(store.maxFileBytes / 1048576) }, 'en'))
          : new ApiError(400, 'invalid_upload', uiMessage('ui.edffcd138f70', {}, 'en')));
      } else reject(error);
    });
  });

  app.post('/api/apps', requireAuth, route(async (req, res) => {
    const user = current(res).user;
    if (uploading.size >= 4 || uploading.has(user.id)) throw new ApiError(429, 'upload_busy', uiMessage('ui.68185b022a6e', {}, 'en'));
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > store.maxFileBytes + 64 * 1024) throw new ApiError(413, 'app_too_large', uiMessage('ui.7ca24428a99c', { p0: Math.floor(store.maxFileBytes / 1048576) }, 'en'));
    const before = await usage(user.id);
    if (before.count >= store.maxApps) throw new ApiError(409, 'app_limit', uiMessage('ui.82a09812c13e', { p0: store.maxApps }, 'en'));
    if (before.usedBytes >= store.maxUserBytes) throw new ApiError(413, 'quota_exceeded', uiMessage('ui.c3a3800eb31c', {}, 'en'));
    uploading.add(user.id);
    (req as Request & { appUserId?: string }).appUserId = user.id;
    try {
      await runUpload(req, res);
      const received = req.file;
      const appId = (req as Request & { appId?: string }).appId;
      if (!received || !appId) throw new ApiError(400, 'file_required', uiMessage('ui.b9f25ab3c2fe', {}, 'en'));
      const file = appFilePath(store.dir, user.id, appId);
      try {
        const name = safeUploadName(decodeName(received.originalname));
        if (!/\.(apk|apks|zip)$/i.test(name)) throw new ApiError(400, 'not_apk', uiMessage('apps.invalidSet', {}, 'en'));
        if (!hasZipMagic(await readHead(file))) throw new ApiError(400, 'not_apk', uiMessage('apps.invalidSet', {}, 'en'));
        const info = await inspectApplication(file, name);
        if (!info) throw new ApiError(400, 'not_apk', uiMessage('apps.invalidSet', {}, 'en'));
        const noteRaw = req.body?.note;
        if (noteRaw !== undefined && noteRaw !== '' && !boundedString(noteRaw, 200)) throw new ApiError(400, 'invalid_note', uiMessage('ui.775b482987e7', {}, 'en'));
        const note = noteRaw ? boundedString(noteRaw, 200) : null;
        const sha256 = await sha256File(file);
        const now = await usage(user.id);
        if (now.count >= store.maxApps) throw new ApiError(409, 'app_limit', uiMessage('ui.82a09812c13e', { p0: store.maxApps }, 'en'));
        if (now.usedBytes + received.size > store.maxUserBytes) throw new ApiError(413, 'quota_exceeded', uiMessage('ui.8e6aa66dae6b', {}, 'en'));
        try {
          const { rows } = await pool.query(
            `INSERT INTO stored_apps(id,owner_user_id,name,size_bytes,sha256,package_name,version_name,note)
             VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
            [appId, user.id, name, received.size, sha256, info.packageName ?? null, info.versionName ?? null, note]);
          audit({ action: 'app.uploaded', actor: user, targetType: 'app', targetId: appId });
          res.status(201).json({ app: appJson(rows[0] as AppRow), usage: await usage(user.id) });
        } catch (error) {
          if ((error as { code?: string }).code === '23505') throw new ApiError(409, 'app_duplicate', uiMessage('ui.12b6a775a310', {}, 'en'));
          throw error;
        }
      } catch (error) {
        await rm(file, { force: true });
        throw error;
      }
    } finally {
      uploading.delete(user.id);
    }
  }));

  app.delete('/api/apps/:id', requireAuth, route(async (req, res) => {
    const user = current(res).user;
    const id = req.params.id!;
    if (!isUuid(id)) throw new ApiError(404, 'not_found', uiMessage('ui.ab1663c1b5b2', {}, 'en'));
    const { rowCount } = await pool.query('DELETE FROM stored_apps WHERE id=$1 AND owner_user_id=$2', [id, user.id]);
    if (!rowCount) throw new ApiError(404, 'not_found', uiMessage('ui.ab1663c1b5b2', {}, 'en'));
    await rm(appFilePath(store.dir, user.id, id), { force: true });
    audit({ action: 'app.deleted', actor: user, targetType: 'app', targetId: id });
    res.json({ ok: true, usage: await usage(user.id) });
  }));

  // ---- Install ----

  const busyHosts = new Set<string>();
  let activeTransfers = 0;
  const acquire = (hostId: string): (() => void) => {
    if (activeTransfers >= 2 || busyHosts.has(hostId)) throw new ApiError(429, 'upload_busy', uiMessage('ui.d081883cd46f', {}, 'en'));
    activeTransfers++;
    busyHosts.add(hostId);
    let released = false;
    return () => { if (!released) { released = true; activeTransfers--; busyHosts.delete(hostId); } };
  };

  const runningSession: RequestHandler = (req, res, next) => {
    void ownedSession(req.params.id!, current(res), true).then(session => {
      if (session.state !== 'running') throw new ApiError(409, 'session_not_ready', uiMessage('ui.63075d9eaf25', {}, 'en'));
      res.locals.activeSession = session;
      next();
    }).catch(next);
  };

  async function sendApk(session: Session, file: string, size: number, sha256: string, extension = 'apk'): Promise<string> {
    const name = `app-${sha256.slice(0, 8)}.${extension}`;
    try {
      if (extension === 'apk' && size <= SINGLE_COMMAND_LIMIT) {
        const handle = await open(file, 'r');
        let content: Buffer;
        try { content = Buffer.alloc(size); await handle.read(content, 0, size, 0); } finally { await handle.close(); }
        const result = await hub.command(session.hostId, session.id, 'file', { name, contentBase64: content.toString('base64'), install: true }, 180_000);
        return String(result.output ?? '').slice(0, 300);
      }
      const begun = await hub.command(session.hostId, session.id, 'app-begin', { name, size, sha256 }, 30_000);
      const transferId = String(begun.transferId);
      try {
        const handle = await open(file, 'r');
        try {
          const buffer = Buffer.alloc(CHUNK_BYTES);
          for (let index = 0, offset = 0; offset < size; index++) {
            const { bytesRead } = await handle.read(buffer, 0, CHUNK_BYTES, offset);
            if (bytesRead === 0) throw new Error('file ended early');
            await hub.command(session.hostId, session.id, 'app-chunk',
              { transferId, index, contentBase64: buffer.toString('base64', 0, bytesRead) }, 60_000);
            offset += bytesRead;
          }
        } finally { await handle.close(); }
        const result = await hub.command(session.hostId, session.id, 'app-finish', { transferId }, 300_000);
        return String(result.output ?? '').slice(0, 300);
      } catch (error) {
        await hub.command(session.hostId, session.id, 'app-abort', { transferId }, 10_000).catch(() => undefined);
        throw error;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message === 'agent offline') throw new ApiError(503, 'agent_offline', uiMessage('ui.c5dec6d573c6', {}, 'en'));
      if (message === 'agent command timed out') throw new ApiError(504, 'install_timeout', uiMessage('ui.b7589c12394d', {}, 'en'));
      throw new ApiError(502, 'install_failed', message.replace(/\s+/g, ' ').slice(0, 300) || 'Installation failed');
    }
  }

  app.post('/api/sessions/:id/apps/install', requireAuth, runningSession, route(async (req, res) => {
    const user = current(res).user;
    const session = res.locals.activeSession as Session;
    const appId = typeof req.body?.appId === 'string' ? req.body.appId : '';
    if (!isUuid(appId)) throw new ApiError(400, 'invalid_app', uiMessage('ui.0f1cee18af8e', {}, 'en'));
    // Only the caller's own library is used, whoever owns the session.
    const { rows } = await pool.query('SELECT * FROM stored_apps WHERE id=$1 AND owner_user_id=$2', [appId, user.id]);
    const row = rows[0] as AppRow | undefined;
    if (!row) throw new ApiError(404, 'not_found', uiMessage('ui.ab1663c1b5b2', {}, 'en'));
    const release = acquire(session.hostId);
    try {
      activity.touch(session.id);
      const output = await sendApk(session, appFilePath(store.dir, user.id, row.id), Number(row.size_bytes), row.sha256, row.name.toLowerCase().split('.').at(-1));
      audit({ action: 'session.app_installed', actor: user, targetType: 'app', targetId: row.id });
      res.json({ ok: true, output, app: appJson(row) });
    } finally { release(); }
  }));

  app.post('/api/sessions/:id/apps/install-url', requireAuth, runningSession, route(async (req, res) => {
    const user = current(res).user;
    const session = res.locals.activeSession as Session;
    if (req.body?.headers !== undefined) throw new ApiError(400, 'headers_unsupported', uiMessage('ui.70670eb4c154', {}, 'en'));
    let url: URL;
    try { url = parseDownloadUrl(req.body?.url, store); } catch (error) { throw error instanceof DownloadError ? downloadStatus(error) : error; }
    const release = acquire(session.hostId);
    await mkdir(tmpDir, { recursive: true, mode: 0o700 });
    const file = path.join(tmpDir, `${randomUUID()}.apk`);
    try {
      activity.touch(session.id);
      let size: number;
      try { ({ size } = await downloadToFile(url.toString(), file, store)); }
      catch (error) { throw error instanceof DownloadError ? downloadStatus(error) : new ApiError(502, 'download_failed', uiMessage('ui.4f9adb2b15c1', {}, 'en')); }
      const name = /\.(apks|zip)$/i.test(url.pathname) ? safeUploadName(path.posix.basename(url.pathname)) : 'download.apk';
      if (!hasZipMagic(await readHead(file)) || !(await inspectApplication(file, name))) throw new ApiError(400, 'not_apk', uiMessage('ui.1b2b04a52bcc', {}, 'en'));
      const output = await sendApk(session, file, size, await sha256File(file), name.toLowerCase().split('.').at(-1));
      audit({ action: 'session.app_installed', actor: user, targetType: 'host', targetId: urlHostLabel(url) });
      res.json({ ok: true, output });
    } finally {
      release();
      await rm(file, { force: true });
    }
  }));
}
