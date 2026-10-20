import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm, access } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { agentMessage } from './messages.mjs';

const fail = () => { throw new Error(agentMessage('agent.appium.failed')); };
export function assertAppiumAndroid(sdkLevel) {
  if (!Number.isInteger(sdkLevel) || sdkLevel < 26) throw new Error(agentMessage('agent.appium.androidVersion'));
}
const COMMANDS = [
  ['GET', /^\/status$/], ['POST', /^\/session$/], ['DELETE', /^\/session\/[A-Za-z0-9-]+$/],
  ['GET', /^\/session\/[A-Za-z0-9-]+\/(?:source|screenshot|window\/rect|orientation|timeouts|contexts|context|appium\/device\/current_activity|appium\/device\/current_package)$/],
  ['POST', /^\/session\/[A-Za-z0-9-]+\/(?:element|elements|actions|timeouts|orientation|context|execute\/sync|appium\/device\/press_keycode|appium\/device\/hide_keyboard)$/],
  ['DELETE', /^\/session\/[A-Za-z0-9-]+\/actions$/],
  ['GET', /^\/session\/[A-Za-z0-9-]+\/element\/[A-Za-z0-9-]+\/(?:text|rect|enabled|selected|displayed|name|attribute\/[A-Za-z0-9_-]+)$/],
  ['POST', /^\/session\/[A-Za-z0-9-]+\/element\/[A-Za-z0-9-]+\/(?:click|clear|value|element|elements)$/],
];
const CAPABILITIES = new Set(['platformName', 'appium:automationName', 'appium:udid',
  'appium:deviceName', 'appium:platformVersion', 'appium:appPackage', 'appium:appActivity', 'appium:appWaitActivity',
  'appium:autoGrantPermissions', 'appium:noReset', 'appium:newCommandTimeout',
  'appium:language', 'appium:locale', 'appium:printPageSourceOnFindFailure']);
const GESTURES = new Set(['mobile: clickGesture', 'mobile: longClickGesture', 'mobile: doubleClickGesture',
  'mobile: swipeGesture', 'mobile: scrollGesture', 'mobile: flingGesture', 'mobile: pinchOpenGesture', 'mobile: pinchCloseGesture']);

export function validateAppiumRequest(value) {
  if (!value || typeof value !== 'object' || Object.keys(value).some(k => !['method', 'path', 'body'].includes(k)) ||
      !COMMANDS.some(([method, pattern]) => value.method === method && pattern.test(value.path)) ||
      typeof value.path !== 'string' || value.path.length > 512 ||
      Buffer.byteLength(JSON.stringify(value.body ?? {})) > 256 * 1024) fail();
  if (value.method === 'POST' && value.path.endsWith('/execute/sync') && !GESTURES.has(value.body?.script)) fail();
  return value;
}
export function sessionCapabilities(body, serial, systemPort) {
  const caps = body?.capabilities;
  if (!caps || typeof caps !== 'object' || Array.isArray(caps) ||
      Object.keys(caps).some(k => !['alwaysMatch', 'firstMatch'].includes(k)) ||
      (caps.firstMatch !== undefined && (JSON.stringify(caps.firstMatch) !== '[{}]'))) fail();
  const input = caps.alwaysMatch ?? {};
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !CAPABILITIES.has(k))) fail();
  for (const [key, value] of Object.entries(input)) {
    if (key === 'appium:udid' && value !== serial) fail();
    if (key === 'platformName' && value !== 'Android') fail();
    if (key === 'appium:automationName' && String(value).toLowerCase() !== 'uiautomator2') fail();
    if (key === 'appium:newCommandTimeout') {
      if (!Number.isInteger(value) || value < 1 || value > 300) fail();
    } else if (key === 'appium:deviceName') {
      if (typeof value !== 'string' || !value.length || value.length > 100 || /[\x00-\x1f\x7f]/.test(value)) fail();
    } else if (['appium:autoGrantPermissions', 'appium:noReset', 'appium:printPageSourceOnFindFailure'].includes(key)) {
      if (typeof value !== 'boolean') fail();
    } else if (typeof value !== 'string' || value.length > 255 || !/^[A-Za-z0-9._*:-]+$/.test(value)) fail();
  }
  return { capabilities: { alwaysMatch: { ...input, platformName: 'Android',
    'appium:automationName': 'UiAutomator2', 'appium:udid': serial,
    'appium:systemPort': systemPort, 'appium:noReset': input['appium:noReset'] ?? true,
    'appium:newCommandTimeout': input['appium:newCommandTimeout'] ?? 120 }, firstMatch: [{}] } };
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); });
  });
}

// One loopback worker per owned device session. Only the brokered W3C subset is
// reachable; clients cannot choose a device, host path, download URL or driver.
export class ManagedAppium {
  constructor({ entry = process.env.RDF_APPIUM_ENTRY, spawnImpl = spawn, fetchImpl = fetch, startTimeoutMs = 60_000, maxWorkers = Number(process.env.RDF_APPIUM_MAX_WORKERS ?? 2) } = {}) {
    if (!Number.isInteger(maxWorkers) || maxWorkers < 1 || maxWorkers > 8) fail();
    this.maxWorkers = maxWorkers;
    this.entry = entry; this.spawn = spawnImpl; this.fetch = fetchImpl;
    this.startTimeoutMs = startTimeoutMs; this.workers = new Map(); this.pending = new Set(); this.stopping = new Map(); this.ports = new Set();
  }
  async request(sessionId, serial, raw, { signal } = {}) {
    signal?.throwIfAborted();
    const params = validateAppiumRequest(raw);
    if (!this.entry || !path.isAbsolute(this.entry)) throw new Error(agentMessage('agent.appium.unavailable'));
    if (this.stopping.has(sessionId) || this.pending.has(sessionId)) throw new Error(agentMessage('agent.appium.busy'));
    if (params.path === '/status') {
      await access(this.entry).catch(() => { throw new Error(agentMessage('agent.appium.unavailable')); });
      return { status: 200, body: { value: { ready: !this.workers.has(sessionId) && new Set([...this.workers.keys(), ...this.pending]).size < this.maxWorkers, message: agentMessage('agent.appium.ready') } } };
    }
    this.pending.add(sessionId);
    let uncertain = false;
    try {
      await access(this.entry).catch(() => { throw new Error(agentMessage('agent.appium.unavailable')); });
      signal?.throwIfAborted();
      let worker = this.workers.get(sessionId);
      if (params.path === '/session') {
        if (worker || new Set([...this.workers.keys(), ...this.pending]).size > this.maxWorkers) throw new Error(agentMessage('agent.appium.busy'));
        // Reject unsafe capabilities before starting a process.
        sessionCapabilities(params.body, serial, 8200);
        uncertain = true;
        worker = await this.start(sessionId, signal);
        params.body = sessionCapabilities(params.body, serial, worker.systemPort);
      } else {
        const id = /^\/session\/([A-Za-z0-9-]+)/.exec(params.path)?.[1];
        if (!worker || id !== worker.driverId) fail();
      }
      uncertain = true;
      const result = await this.forward(worker, params, params.path === '/session' ? 120_000 : 45_000);
      if (params.path === '/session') {
        const driverId = result.body?.value?.sessionId;
        if (result.status !== 200 || typeof driverId !== 'string' || !/^[A-Za-z0-9-]{1,100}$/.test(driverId)) {
          await this.stop(sessionId); return result;
        }
        worker.driverId = driverId;
      }
      if (params.method === 'DELETE' && /^\/session\/[A-Za-z0-9-]+$/.test(params.path)) await this.stop(sessionId);
      return result;
    } catch (error) {
      // After an uncertain request, do not leave an automation worker running.
      if (uncertain) await this.stop(sessionId);
      throw error;
    } finally { this.pending.delete(sessionId); }
  }
  async start(sessionId, parentSignal) {
    await access(this.entry).catch(() => { throw new Error(agentMessage('agent.appium.unavailable')); });
    const directory = await mkdtemp(path.join(os.tmpdir(), 'rdf-appium-'));
    const worker = { directory, life: new AbortController(), driverId: null, child: null, closed: null };
    worker.signal = parentSignal ? AbortSignal.any([worker.life.signal, parentSignal]) : worker.life.signal;
    this.workers.set(sessionId, worker);
    try {
      worker.signal.throwIfAborted();
      worker.reservedPorts = [];
      for (const key of ['port', 'systemPort']) {
        for (let attempt = 0; attempt < 10; attempt++) {
          const port = await freePort();
          if (this.ports.has(port)) continue;
          this.ports.add(port); worker.reservedPorts.push(port); worker[key] = port; break;
        }
        if (!worker[key]) fail();
      }
      worker.origin = 'http://127.0.0.1:' + worker.port;
      const env = Object.fromEntries(['PATH', 'HOME', 'USERPROFILE', 'SystemRoot', 'TMP', 'TEMP', 'JAVA_HOME', 'ANDROID_HOME',
        'ANDROID_SDK_ROOT', 'ANDROID_ADB_SERVER_PORT', 'ADB_SERVER_SOCKET', 'ADB_VENDOR_KEYS'].filter(k => process.env[k]).map(k => [k, process.env[k]]));
      worker.signal.throwIfAborted();
      worker.child = this.spawn(process.execPath, ['--max-old-space-size=256', this.entry, '--address', '127.0.0.1', '--port', String(worker.port),
        '--use-drivers', 'uiautomator2', '--tmp', directory, '--log-level', 'error',
        '--deny-insecure', '*:adb_shell,*:chromedriver_autodownload'], {
        cwd: path.resolve(path.dirname(this.entry), '../..'), env,
        detached: process.platform !== 'win32', windowsHide: true, stdio: 'ignore',
      });
      worker.closed = new Promise(resolve => { worker.child.once('close', resolve); worker.child.once('error', resolve); });
      worker.child.once('error', () => worker.life.abort());
      worker.child.once('exit', () => worker.life.abort());
      const signal = AbortSignal.any([worker.signal, AbortSignal.timeout(this.startTimeoutMs)]);
      while (true) {
        signal.throwIfAborted();
        try { if ((await this.forward(worker, { method: 'GET', path: '/status' }, 2000)).status === 200) return worker; }
        catch { signal.throwIfAborted(); }
        await delay(250, undefined, { signal });
      }
    } catch { await this.stop(sessionId); fail(); }
  }
  async forward(worker, { method, path: resource, body }, timeoutMs) {
    const signal = AbortSignal.any([worker.signal, AbortSignal.timeout(timeoutMs)]);
    const response = await this.fetch(worker.origin + resource, { method, signal, redirect: 'error',
      headers: { 'Content-Type': 'application/json' }, body: body === undefined || method === 'GET' ? undefined : JSON.stringify(body) });
    const chunks = []; let size = 0;
    for await (const chunk of response.body ?? []) {
      size += chunk.length;
      if (size > 8 * 1024 * 1024) { await response.body?.cancel().catch(() => {}); fail(); }
      chunks.push(chunk);
    }
    let data; try { data = JSON.parse(Buffer.concat(chunks).toString()); } catch { fail(); }
    if (data?.value?.error) data.value = { error: String(data.value.error).slice(0, 80), message: agentMessage('agent.appium.commandFailed'), stacktrace: '' };
    return { status: response.status, body: data };
  }
  stop(sessionId) {
    if (this.stopping.has(sessionId)) return this.stopping.get(sessionId);
    const worker = this.workers.get(sessionId);
    if (!worker) return Promise.resolve();
    const stopped = (async () => {
      worker.life.abort();
      if (worker.child) {
        const kill = signal => {
          if (!Number.isInteger(worker.child.pid) || worker.child.pid <= 0) return;
          try {
            if (process.platform !== 'win32') process.kill(-worker.child.pid, signal);
            else worker.child.kill(signal);
          } catch (error) { if (error.code !== 'ESRCH') throw error; }
        };
        kill('SIGTERM');
        const grace = new AbortController();
        try { await Promise.race([worker.closed, delay(3000, undefined, { signal: grace.signal })]); }
        finally { grace.abort(); }
        kill('SIGKILL');
        await worker.closed;
      }
      const target = path.resolve(worker.directory);
      if (path.dirname(target) !== path.resolve(os.tmpdir()) || !path.basename(target).startsWith('rdf-appium-')) fail();
      await rm(target, { recursive: true, force: true });
      for (const port of worker.reservedPorts ?? []) this.ports.delete(port);
      if (this.workers.get(sessionId) === worker) this.workers.delete(sessionId);
    })().finally(() => this.stopping.delete(sessionId));
    this.stopping.set(sessionId, stopped);
    return stopped;
  }
  async close() { await Promise.all([...this.workers.keys()].map(id => this.stop(id))); }
}
