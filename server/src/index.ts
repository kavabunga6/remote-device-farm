import { operationalError, StartupFailure, waitForStartupDependency, type StartupPhase } from './startup.js';
import { uiMessage } from './messages.js';
import { createServer, type Server } from 'node:http';
import { sealLegacyProfileEnv } from './secrets.js';
import type { Pool } from 'pg';
import express, { type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import { createPool, migrate } from './db.js';
import { loadConfig, type Config } from './config.js';
import { AuthService } from './auth.js';
import { OidcService } from './oidc.js';
import { AgentHub } from './agent.js';
import { ApiError, isAllowedOrigin } from './http-common.js';
import { createServerContext } from './server-context.js';
import { registerAuthRoutes } from './routes/auth-routes.js';
import { registerAdminRoutes } from './routes/admin-routes.js';
import { ImageManagement } from './image-management.js';
import { registerImageManagementRoutes } from './routes/image-management-routes.js';
import { ImageBuildWorker } from './image-build-worker.js';
import { ImagePrewarmWorker, registerImagePrewarmRoutes } from './image-prewarm.js';
import { initializeRegistry } from './registry.js';
import { registerImageRoutes } from './routes/image-routes.js';
import { registerSessionRoutes } from './routes/session-routes.js';
import { attachWebSocket } from './websocket.js';
import { AdbPortBroker } from './adb-port.js';
import { registerAdbPortRoutes } from './routes/adb-port-routes.js';
import { registerUserSettingsRoutes } from './routes/user-settings-routes.js';
import { installAuditTrail } from './audit.js';
import { startSessionReaper } from './session-lifecycle.js';
import { registerQueueRoutes } from './routes/queue-routes.js';
import { registerShareRoutes } from './routes/share-routes.js';
import { registerAppRoutes } from './routes/app-routes.js';
import { registerEnvRoutes } from './routes/env-routes.js';
import { registerOpsRoutes } from './routes/ops-routes.js';
import { httpCounter } from './metrics.js';
import { registerTeamRoutes } from './routes/team-routes.js';
import { ApplicationLog, logSecrets } from './application-log.js';
import { registerApplicationLogRoutes } from './routes/application-log-routes.js';
import { applicationRequestLog } from './application-request-log.js';
import { connectServiceLog, recordServiceLog } from './service-log.js';

export { safeUploadName, parseProfile, parseHostSettings, hostJson, inputParams, isAllowedOrigin } from './http-common.js';

// Close upgraded connections and background workers while HTTP requests drain, then release the pool.
export function createServerShutdown(server: Server, pool: Pick<Pool, 'end'>, stopServices: () => Promise<void>): () => Promise<void> {
  let stopping: Promise<void> | undefined;
  return () => {
    if (stopping) return stopping;
    stopping = (async () => {
      const closed = new Promise<void>(resolve => server.close(() => resolve()));
      const deadline = setTimeout(() => server.closeAllConnections(), 10_000);
      deadline.unref();
      try {
        const results = await Promise.allSettled([closed, Promise.resolve().then(stopServices)]);
        const failed = results.find(result => result.status === 'rejected');
        if (failed?.status === 'rejected') throw failed.reason;
      } finally {
        clearTimeout(deadline);
        await pool.end();
      }
    })();
    return stopping;
  };
}

export async function buildServer(config: Config = loadConfig()) {
  const applicationLog = new ApplicationLog(2000, logSecrets(process.env));
  applicationLog.append('info', 'Remote Device Farm server starting');
  const pool = createPool(config);
  const auth = new AuthService(pool, config);
  let startupPhase: StartupPhase = 'database';
  pool.on('error', error => console.error(uiMessage('runtime.databaseFailure', {}, 'en'), operationalError(error, 'database')));
  try {
    await waitForStartupDependency(() => pool.query('SELECT 1'), { onRetry: details => {
      const message = uiMessage('runtime.startupWaiting', {}, 'en') + ' ' + details;
      applicationLog.append('warning', message);
      console.warn(message);
    } });
    startupPhase = 'migrations';
    await migrate(pool);
    startupPhase = 'registry';
    await initializeRegistry(pool, config.builtinRegistryAddress);
    startupPhase = 'profile_secrets';
    await sealLegacyProfileEnv(pool, config.secretsKey);
    startupPhase = 'authentication';
    await auth.bootstrap();
  } catch (error) {
    await pool.end().catch(() => {});
    throw new StartupFailure(startupPhase, error);
  }
  const disconnectServiceLog = connectServiceLog(pool, applicationLog);
  const oidc = config.oidc ? new OidcService(pool, config) : undefined;
  const hub = new AgentHub(pool);
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
        res.status(204).end(); return;
      }
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !isAllowedOrigin(req, config)) {
      next(new ApiError(403, 'origin_denied', uiMessage('ui.9b49b345bdf5', {}, 'en'))); return;
    }
    next();
  });
  const context = createServerContext(pool, config, auth, oidc, hub);
  const adbPortBroker = new AdbPortBroker(pool, hub, config);
  installAuditTrail(app, pool);
  const stopAuth = registerAuthRoutes(app, context);
  registerAdminRoutes(app, context);
  const imageBuilds = new ImageBuildWorker(pool, hub, config.secretsKey);
  registerImageRoutes(app, context, imageBuilds);
  const imageManagement = new ImageManagement(pool, hub);
  registerImageManagementRoutes(app, context, imageManagement);
  const imagePrewarm = new ImagePrewarmWorker(pool, hub, config.secretsKey);
  registerImagePrewarmRoutes(app, context, imagePrewarm);
  registerSessionRoutes(app, context);
  registerAdbPortRoutes(app, context, adbPortBroker);
  registerUserSettingsRoutes(app, context);
  const stopApplicationLog = registerApplicationLogRoutes(app, context, applicationLog);
  const queue = registerQueueRoutes(app, context);
  registerShareRoutes(app, context);
  registerAppRoutes(app, context);
  registerEnvRoutes(app, context);
  const stopOps = registerOpsRoutes(app, context);
  registerTeamRoutes(app, context);

  app.use((req, _res, next) => next(new ApiError(404, 'not_found', uiMessage('ui.ae5bf9975c8c', { p0: req.method, p1: req.path }, 'en'))));
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent) return;
    if (error instanceof SyntaxError && (error as { type?: string }).type === 'entity.parse.failed') {
      res.locals.applicationError = 'invalid_json';
      res.status(400).json({ error: { code: 'invalid_json', message: 'Expected a JSON object or array' } });
      return;
    }
    if (error instanceof multer.MulterError) {
      res.locals.applicationError = error.code;
      res.status(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: { code: error.code, message: error.message } });
      return;
    }
    if ((error as { code?: string }).code === '55006' && ['image_maintenance', 'image_removed'].includes(String((error as Error).message))) {
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
        service: 'server', severity: 'error', code: 'api.internal_error', message: operationalError(error, 'api'),
      }).catch(() => {});
    }
    res.status(status).json({ error: { code, message } });
  });

  const restoreConsole = applicationLog.captureConsole();
  const server = createServer(app);
  server.headersTimeout = 15_000;
  server.requestTimeout = 120_000;
  const stopWebSocket = attachWebSocket(server, context);
  let stopReaper = () => Promise.resolve();
  let stopImageManagement = () => Promise.resolve();
  let stopImageBuilds = () => Promise.resolve();
  let stopImagePrewarm = () => Promise.resolve();
  const stop = createServerShutdown(server, pool, async () => {
    const results = await Promise.allSettled([
      stopApplicationLog, () => queue?.stop(), stopReaper, stopImageManagement, stopImageBuilds, stopImagePrewarm, stopAuth, stopOps, () => hub.dispose(), stopWebSocket, () => adbPortBroker.stop(),
    ].map(dispose => Promise.resolve().then(dispose)));
    const failed = results.find(result => result.status === 'rejected');
    disconnectServiceLog();
    restoreConsole();
    if (failed?.status === 'rejected') throw failed.reason;
  });
  try {
    await adbPortBroker.start();
    stopImageBuilds = imageBuilds.start();
    stopImageManagement = imageManagement.start();
    stopImagePrewarm = imagePrewarm.start();
    stopReaper = startSessionReaper(pool, hub, context.policy, id => adbPortBroker.hasActiveSocket(id) || hub.hasActiveTunnel(id));
  } catch (error) {
    await stop();
    throw error;
  }
  return { server, pool, hub, adbPortBroker, stop };
}

if (process.argv[1] && /(?:^|[\\/])index\.(?:ts|js)$/.test(process.argv[1])) {
  const main = async () => {
    let config: Config;
    try { config = loadConfig(); } catch (error) { throw new StartupFailure('configuration', error); }
    const { server, stop } = await buildServer(config);
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(config.port, () => { server.off('error', reject); resolve(); });
      });
    } catch (error) {
      await stop().catch(() => {});
      throw new StartupFailure('listeners', error);
    }
    console.log(`Remote Device Farm API listening on ${config.port}`);
    const shutdown = () => {
      void stop().then(() => process.exit(0)).catch(error => { console.error(uiMessage('runtime.shutdownFailure', {}, 'en'), operationalError(error, 'shutdown')); process.exit(1); });
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
  };
  void main().catch(error => { console.error(uiMessage('runtime.startupFailure', {}, 'en'), operationalError(error, 'listeners')); process.exit(1); });
}
