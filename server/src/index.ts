import { createHttpApplication } from './http-application.js';
import { operationalError, StartupFailure, waitForStartupDependency, type StartupPhase } from './startup.js';
import { uiMessage } from './messages.js';
import { createServer, type Server } from 'node:http';
import { sealLegacyProfileEnv } from './secrets.js';
import type { Pool } from 'pg';
import { createPool, migrate } from './db.js';
import { loadConfig, type Config } from './config.js';
import { AuthService } from './auth.js';
import { OidcService } from './oidc.js';
import { AgentHub } from './agent.js';
import { createServerContext } from './server-context.js';
import { ImageManagement } from './image-management.js';
import { ImageBuildWorker } from './image-build-worker.js';
import { ImagePrewarmWorker } from './image-prewarm.js';
import { initializeRegistry } from './registry.js';
import { attachWebSocket } from './websocket.js';
import { AdbPortBroker } from './adb-port.js';
import { startSessionReaper } from './session-lifecycle.js';
import { ApplicationLog, logSecrets } from './application-log.js';
import { connectServiceLog } from './service-log.js';

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
  const context = createServerContext(pool, config, auth, oidc, hub);
  const adbPortBroker = new AdbPortBroker(pool, hub, config);
  const imageBuilds = new ImageBuildWorker(pool, hub, config.secretsKey);
  const imageManagement = new ImageManagement(pool, hub);
  const imagePrewarm = new ImagePrewarmWorker(pool, hub, config.secretsKey);
  const { app, stopAuth, stopApplicationLog, queue, stopOps } = createHttpApplication(context, {
    applicationLog, adbPortBroker, imageBuilds, imageManagement, imagePrewarm,
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
