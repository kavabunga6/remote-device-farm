import type { Express } from 'express';
import multer from 'multer';
import type { ServerContext } from '../server-context.js';
import { ApiError, route } from '../http-common.js';
import { assertPermission } from '../permissions.js';
import { uiMessage } from '../messages.js';

export function registerCameraRoutes(app: Express, context: ServerContext): void {
  const { requireAuth, current, ownedSession, hub, activity } = context;
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 256 * 1024, files: 1, fields: 0, parts: 1 } }).single('image');
  let activeUploads = 0;
  async function call(id: string, auth: ReturnType<typeof current>, op: string, imageBase64?: string) {
    assertPermission(auth.user, 'sessions.env');
    const session = await ownedSession(id, auth, true);
    activity.touch(session.id);
    return hub.command(session.hostId, session.id, 'camera', { op, ...(imageBase64 ? { imageBase64 } : {}) }, 65_000);
  }
  app.get('/api/sessions/:id/camera', requireAuth, route(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(await call(req.params.id!, current(res), 'status'));
  }));
  app.post('/api/sessions/:id/camera/image', requireAuth, route(async (req, res) => {
    assertPermission(current(res).user, 'sessions.env');
    await ownedSession(req.params.id!, current(res), true);
    if (activeUploads >= 2) throw new ApiError(429, 'camera_busy', uiMessage('camera.busy'));
    activeUploads++;
    try {
      await new Promise<void>((resolve, reject) => upload(req, res, error => error ? reject(error) : resolve()));
      if (!req.file || req.file.mimetype !== 'image/png') throw new ApiError(400, 'invalid_camera_image', uiMessage('camera.invalid'));
      res.json(await call(req.params.id!, current(res), 'set', req.file.buffer.toString('base64')));
    } finally { activeUploads--; }
  }));
  app.post('/api/sessions/:id/camera/reset', requireAuth, route(async (req, res) => {
    res.json(await call(req.params.id!, current(res), 'reset'));
  }));
  app.post('/api/sessions/:id/camera/show', requireAuth, route(async (req, res) => {
    res.json(await call(req.params.id!, current(res), 'show'));
  }));
}
