import { operationalError } from './startup.js';
import { uiMessage } from './messages.js';
import express, { type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import { ApiError, isAllowedOrigin } from './http-common.js';
import { registerAuthRoutes } from './routes/auth-routes.js';
import { registerRegistrationRoutes } from './routes/registration-routes.js';
import { registerAdminRoutes } from './routes/admin-routes.js';
import { registerImageManagementRoutes } from './routes/image-management-routes.js';
import { registerImagePrewarmRoutes, type ImagePrewarmWorker } from './image-prewarm.js';
import { registerImageRoutes } from './routes/image-routes.js';
import { registerSessionRoutes } from './routes/session-routes.js';
import { registerAdbPortRoutes } from './routes/adb-port-routes.js';
import { registerUserSettingsRoutes } from './routes/user-settings-routes.js';
import { installAuditTrail } from './audit.js';
import { registerQueueRoutes } from './routes/queue-routes.js';
import { registerShareRoutes } from './routes/share-routes.js';
import { registerAppRoutes } from './routes/app-routes.js';
import { registerEnvRoutes } from './routes/env-routes.js';
import { registerUiRoutes } from './routes/ui-routes.js';
import { registerDeviceDebugRoutes } from './routes/device-debug-routes.js';
import { registerAppiumRoutes } from './routes/appium-routes.js';
import { registerCameraRoutes } from './routes/camera-routes.js';
import { registerOpsRoutes } from './routes/ops-routes.js';
import { httpCounter } from './metrics.js';
import { registerTeamRoutes } from './routes/team-routes.js';
import { registerApplicationLogRoutes } from './routes/application-log-routes.js';
import { applicationRequestLog } from './application-request-log.js';
import { recordServiceLog } from './service-log.js';
import type { ServerContext } from './server-context.js';
import type { ApplicationLog } from './application-log.js';
import type { AdbPortBroker } from './adb-port.js';
import type { ImageBuildWorker } from './image-build-worker.js';
import type { ImageManagement } from './image-management.js';

/** HTTP routing and middleware shared by production and integration tests. */
export function createHttpApplication(
  context: ServerContext,
  services: {
    applicationLog: ApplicationLog;
    adbPortBroker: AdbPortBroker;
    imageBuilds: ImageBuildWorker;
    imageManagement: ImageManagement;
    imagePrewarm: ImagePrewarmWorker;
  },
  options: { startDispatcher?: boolean } = {},
) {
  const { pool, config } = context;
  const { applicationLog, adbPortBroker, imageBuilds, imageManagement, imagePrewarm } = services;
  const app = express();
  app.disable('x-powered-by');
  app.use(httpCounter);
  app.use(applicationRequestLog(applicationLog));
  if (config.trustProxy !== undefined) app.set('trust proxy', config.trustProxy);
  app.use(express.json({ limit: '1mb' }));
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && isAllowedOrigin(req, config)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Vary', 'Origin');
      if (req.method === 'OPTIONS') {
        res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
        res.status(204).end();
        return;
      }
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !isAllowedOrigin(req, config)) {
      next(new ApiError(403, 'origin_denied', uiMessage('ui.9b49b345bdf5', {}, 'en')));
      return;
    }
    next();
  });
  installAuditTrail(app, pool);
  const stopAuth = registerAuthRoutes(app, context);
  registerRegistrationRoutes(app, context);
  registerAdminRoutes(app, context);
  registerImageRoutes(app, context, imageBuilds);
  registerImageManagementRoutes(app, context, imageManagement);
  registerImagePrewarmRoutes(app, context, imagePrewarm);
  registerSessionRoutes(app, context);
  registerAdbPortRoutes(app, context, adbPortBroker);
  registerUserSettingsRoutes(app, context);
  const stopApplicationLog = registerApplicationLogRoutes(app, context, applicationLog);
  const queue = registerQueueRoutes(app, context, { startDispatcher: options.startDispatcher ?? true });
  registerShareRoutes(app, context);
  registerAppRoutes(app, context);
  registerEnvRoutes(app, context);
  registerUiRoutes(app, context);
  registerAppiumRoutes(app, context);
  registerDeviceDebugRoutes(app, context);
  registerCameraRoutes(app, context);
  const stopOps = registerOpsRoutes(app, context);
  registerTeamRoutes(app, context);

  app.use((req, _res, next) =>
    next(
      new ApiError(404, 'not_found', uiMessage('ui.ae5bf9975c8c', { p0: req.method, p1: req.path }, 'en')),
    ),
  );
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent) return;
    if (error instanceof SyntaxError && (error as { type?: string }).type === 'entity.parse.failed') {
      res.locals.applicationError = 'invalid_json';
      res.status(400).json({ error: { code: 'invalid_json', message: 'Expected a JSON object or array' } });
      return;
    }
    if (error instanceof multer.MulterError) {
      res.locals.applicationError = error.code;
      res
        .status(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400)
        .json({ error: { code: error.code, message: error.message } });
      return;
    }
    if (
      (error as { code?: string }).code === '55006' &&
      ['image_maintenance', 'image_removed'].includes(String((error as Error).message))
    ) {
      const code = String((error as Error).message);
      res.status(409).json({ error: { code, message: uiMessage('images.error.' + code) } });
      return;
    }
    const status = error instanceof ApiError ? error.status : 500;
    const code = error instanceof ApiError ? error.code : 'internal_error';
    res.locals.applicationError = code;
    const message = error instanceof ApiError ? error.message : 'Internal server error';
    if (status === 500) {
      console.error(uiMessage('runtime.apiFailure', {}, 'en'), operationalError(error, 'api'));
      void recordServiceLog(pool, {
        service: 'server',
        severity: 'error',
        code: 'api.internal_error',
        message: operationalError(error, 'api'),
      }).catch(() => {});
    }
    res.status(status).json({ error: { code, message } });
  });

  return { app, stopAuth, stopApplicationLog, queue, stopOps };
}
