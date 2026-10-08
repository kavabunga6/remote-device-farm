import { mkdir, open, unlink } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { finished } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { startProcess } from './process.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const artifacts = path.resolve(process.env.RDF_ARTIFACTS_DIR || path.join(directory, 'artifacts'));
const port = Number(process.env.APPIUM_PORT || 4723);
const adbPort = Number(process.env.ANDROID_ADB_SERVER_PORT || 5037);
if (!process.env.ANDROID_SERIAL) throw new Error('Run through scripts/rdf.sh run; ANDROID_SERIAL is required');
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('APPIUM_PORT must be 1024-65535');
if (!Number.isInteger(adbPort) || adbPort < 1 || adbPort > 65535) throw new Error('ANDROID_ADB_SERVER_PORT must be 1-65535');
await mkdir(artifacts, { recursive: true });
const env = { ...process.env, APPIUM_PORT: String(port), RDF_ARTIFACTS_DIR: artifacts };
// Discover the pinned driver from this package, not a user's global extension directory.
delete env.APPIUM_HOME;
// Appium and the test client do not need the farm's API credential.
delete env.RDF_TOKEN;
// This runner starts its own node:test process, including when called by a test harness.
delete env.NODE_TEST_CONTEXT;
const abort = new AbortController();
let cancelledCode;
const signalHandlers = new Map([['SIGINT', 130], ['SIGTERM', 143]].map(([signal, code]) => {
  const handler = () => { cancelledCode = code; abort.abort(new Error(`Cancelled by ${signal}`)); };
  return [signal, handler];
}));
let onAbort;
const interrupted = new Promise((_, reject) => {
  onAbort = () => reject(abort.signal.reason);
  abort.signal.addEventListener('abort', onAbort, { once: true });
});
// During startup, cancellation is handled by abortable fetch/delay before we await this promise.
void interrupted.catch(() => {});
let appium;
let testProcess;
let log;
let artifactLock;
let ownsArtifactLock = false;
const lockPath = path.join(artifacts, '.appium.lock');
const onLogError = (error) => abort.abort(new Error(`Could not write Appium log: ${error.message}`));
try {
  for (const [signal, handler] of signalHandlers) process.once(signal, handler);
  // A distinct directory per job is required. Never erase another active run's
  // reports if two jobs accidentally point at the same directory.
  try { artifactLock = await open(lockPath, 'wx'); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error(`Appium artifacts are locked: ${lockPath}; use a different RDF_ARTIFACTS_DIR or check that the previous process stopped`);
    throw error;
  }
  ownsArtifactLock = true;
  await artifactLock.writeFile(String(process.pid));
  await artifactLock.close();
  artifactLock = undefined;
  abort.signal.throwIfAborted();
  // Remove only this example's previous outputs, including after an early failure.
  for (const name of ['appium.log', 'appium.xml', 'settings-home.png', 'failure.png']) {
    await unlink(path.join(artifacts, name)).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
  // Refuse to reuse an Appium server belonging to another job.
  await new Promise((resolve, reject) => {
    const socket = net.createServer();
    socket.once('error', () => reject(new Error(`Local port ${port} is busy; choose a different APPIUM_PORT`)));
    socket.listen(port, '127.0.0.1', () => socket.close(resolve));
  });
  abort.signal.throwIfAborted();
  // Opening and closing the file belong to the same cleanup scope as both processes.
  const logFile = await open(path.join(artifacts, 'appium.log'), 'w');
  log = logFile.createWriteStream();
  log.on('error', onLogError);
  abort.signal.throwIfAborted();
  appium = startProcess(process.execPath, [path.join(directory, 'node_modules/appium/index.js'),
    '--address', '127.0.0.1', '--port', String(port), '--use-drivers', 'uiautomator2', '--log-no-colors'],
  { cwd: directory, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  appium.child.stdout.pipe(log, { end: false });
  appium.child.stderr.pipe(log, { end: false });
  const deadline = Date.now() + 60_000;
  let ready = false;
  while (Date.now() < deadline) {
    abort.signal.throwIfAborted();
    if (appium.result) throw appium.result.error || new Error(`Appium exited during startup; see ${path.join(artifacts, 'appium.log')}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/status`, {
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(1000)]),
      });
      // Consume every response so failed readiness checks do not retain HTTP connections.
      const status = await response.json();
      ready = response.ok && status.value?.ready === true;
    } catch {
      abort.signal.throwIfAborted();
      // Refused connections and incomplete responses are expected during startup.
    }
    if (ready) break;
    await delay(250, undefined, { signal: abort.signal });
  }
  abort.signal.throwIfAborted();
  if (!ready) throw new Error(`Appium startup timed out; see ${path.join(artifacts, 'appium.log')}`);
  testProcess = startProcess(process.execPath, ['--test', '--test-reporter=spec', '--test-reporter=junit',
    '--test-reporter-destination=stdout', `--test-reporter-destination=${path.join(artifacts, 'appium.xml')}`,
    path.join(directory, 'settings.test.mjs')], { cwd: directory, env, stdio: 'inherit', windowsHide: true });
  const result = await Promise.race([testProcess.completion, interrupted]);
  if (result.error) throw result.error;
  process.exitCode = result.code ?? 1;
} catch (error) {
  console.error(error.message);
  process.exitCode = cancelledCode ?? 1;
} finally {
  // Attempt both stops even if one process cannot be terminated.
  const stops = await Promise.allSettled([testProcess?.stop(), appium?.stop()]);
  for (const result of stops) {
    if (result.status === 'rejected') {
      console.error(result.reason.message);
      process.exitCode ||= 1;
    }
  }
  if (log) {
    log.end();
    await finished(log, { cleanup: true }).catch((error) => {
      console.error(`Could not finish Appium log: ${error.message}`);
      process.exitCode ||= 1;
    });
    log.off('error', onLogError);
  }
  try {
    await artifactLock?.close();
    if (ownsArtifactLock) await unlink(lockPath);
  } catch (error) {
    console.error(`Could not release artifact lock: ${error.message}`);
    process.exitCode ||= 1;
  }
  abort.signal.removeEventListener('abort', onAbort);
  for (const [signal, handler] of signalHandlers) process.off(signal, handler);
  if (cancelledCode) process.exitCode = cancelledCode;
}
