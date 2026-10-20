import net from 'node:net';
import { agentMessage } from './messages.mjs';
import { chmod, mkdir, rm } from 'node:fs/promises';
import { validateNodePolicy } from './node-policy.mjs';
import { validateRegistryAuth } from './config.mjs';
import { validateEmuConsoleArgs } from './emu-console.mjs';
import { normalizeStartupProgress, progressReporter } from './startup-progress.mjs';

export const CONTROL_SOCKET = '/run/agent-control/control.sock';
const MAX_MESSAGE_BYTES = 16 * 1024;
const MAX_CACHE_REQUEST_BYTES = 640 * 1024;
const isCacheOperation = op => ['imageCache','imageCacheRemove'].includes(op);
const isLargeOperation = op => isCacheOperation(op) || op === 'cameraImage';
const DEFAULT_TIMEOUT_MS = 15_000;

// Builds take Google system image names only; the image context is fixed in agent/emulator-image.
function validateBuildRequest(request) {
  const { packages, target } = request;
  if (!Array.isArray(packages) || !packages.length || packages.length > 50 ||
      packages.some((item) => typeof item !== 'string' || !/^system-images;[a-zA-Z0-9._-]{1,40};[a-z0-9_.-]{1,60};[a-z0-9_-]{2,20}$/.test(item))) {
    throw new Error('Invalid system image list');
  }
  if (!target || typeof target !== 'object' || Array.isArray(target) || Object.keys(target).some((key) => !['repository', 'auth'].includes(key)) ||
      typeof target.repository !== 'string' || !/^[a-z0-9.-]+(:[0-9]{1,5})?(\/[a-z0-9._-]+){1,5}$/i.test(target.repository)) {
    throw new Error('Invalid image build target');
  }
  validateRegistryAuth(target.auth);
}

export function validateControlRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request) ||
      typeof request.op !== 'string' || !['hostInfo', 'recover', 'inventory', 'start', 'stop', 'diagnostics', 'setEgress', 'emuConsole', 'cameraImage', 'setPolicy', 'emulatorCatalog', 'emulatorBuild', 'emulatorCancel', 'emulatorJobs', 'prewarmImage', 'imageCache', 'imageCacheRemove'].includes(request.op)) {
    throw new Error('Invalid control operation');
  }
  const fields = {
    imageCache: ['op','protectedRefs'], imageCacheRemove:['op','ids','protectedRefs'],
    hostInfo: ['op'], recover: ['op'], inventory: ['op'],
    start: ['op', 'sessionId', 'profile', 'adbPublicKey'],
    stop: ['op', 'sessionId'], diagnostics: ['op', 'sessionId'], setEgress: ['op', 'sessionId', 'enabled'],
    emuConsole: ['op', 'sessionId', 'args'],
    cameraImage: ['op', 'sessionId', 'params'],
    setPolicy: ['op', 'policy'],
    prewarmImage: ['op', 'image', 'auth'],
    emulatorCatalog: ['op', 'refresh'], emulatorBuild: ['op', 'packages', 'target'], emulatorJobs: ['op', 'acknowledged'], emulatorCancel: ['op', 'jobId'],
  }[request.op];
  if (Object.keys(request).some((key) => !fields.includes(key)) ||
      fields.some((key) => key !== 'acknowledged' && !Object.hasOwn(request, key))) {
    throw new Error('Unexpected control request field');
  }
  if (fields.includes('sessionId') &&
      (typeof request.sessionId !== 'string' || !/^[a-zA-Z0-9-]{8,64}$/.test(request.sessionId))) {
    throw new Error('Invalid session ID');
  }
  if (['imageCache','imageCacheRemove'].includes(request.op)) {
    if(!Array.isArray(request.protectedRefs) || request.protectedRefs.length>1000 || request.protectedRefs.some(ref=>typeof ref!=='string'||ref.length>512))throw new Error('Invalid protected images');
    if(request.op==='imageCacheRemove' && (!Array.isArray(request.ids)||!request.ids.length||request.ids.length>100||request.ids.some(id=>typeof id!=='string'||!/^sha256:[a-f0-9]{64}$/.test(id))))throw new Error('Invalid cache image IDs');
  }
  if (request.op === 'setEgress' && typeof request.enabled !== 'boolean') throw new Error('Invalid egress state');
  if (request.op === 'cameraImage' && (!request.params || !['status', 'set', 'reset', 'show'].includes(request.params.op) || Object.keys(request.params).some(k => !['op', 'imageBase64'].includes(k)) || (request.params.op === 'set' && (typeof request.params.imageBase64 !== 'string' || request.params.imageBase64.length > 350000)))) throw new Error(agentMessage('agent.camera.invalidRequest'));
  if (request.op === 'emuConsole') validateEmuConsoleArgs(request.args);
  if (request.op === 'setPolicy') validateNodePolicy(request.policy);
  if (request.op === 'emulatorCatalog' && typeof request.refresh !== 'boolean') throw new Error('Invalid catalog refresh flag');
  if (request.op === 'prewarmImage') {
    if (typeof request.image !== 'string' || request.image.length > 256 || !/@sha256:[0-9a-f]{64}$/.test(request.image)) throw new Error('Image prewarm requires a pinned digest');
    validateRegistryAuth(request.auth);
  }
  if (request.op === 'emulatorBuild') validateBuildRequest(request);
  if (request.op === 'emulatorCancel' && (typeof request.jobId !== 'string' || !/^[a-zA-Z0-9-]{1,64}$/.test(request.jobId))) throw new Error('Invalid emulator build job ID');
  if (request.op === 'emulatorJobs' && request.acknowledged !== undefined && (!Array.isArray(request.acknowledged) || request.acknowledged.length > 50 || request.acknowledged.some(id => typeof id !== 'string' || !/^[a-zA-Z0-9-]{1,64}$/.test(id)))) throw new Error('Invalid build acknowledgements');
  if (request.op === 'start' &&
      (!request.profile || typeof request.profile !== 'object' || Array.isArray(request.profile) ||
       Object.keys(request.profile).some((key) => !['image', 'cpu', 'memoryMb', 'guestMemoryMb', 'guestCores', 'diskGb', 'sdcardGb', 'sdCardMb', 'emulatorParams', 'containerEnv', 'dockerOptions', 'gpuMode', 'gpuBackend', 'deviceType', 'resolution', 'registryAuth'].includes(key)))) {
    throw new Error('Unexpected emulator profile field');
  }
  if (request.op === 'start' &&
      (typeof request.adbPublicKey !== 'string' || request.adbPublicKey.length > 4096 ||
       !/^[A-Za-z0-9+/=]+(?: [^\r\n\0]{1,128})?\n?$/.test(request.adbPublicKey))) {
    throw new Error('Invalid ADB public key');
  }
  return request;
}

function decodeLine(buffer, maxBytes = MAX_MESSAGE_BYTES) {
  if (buffer.length > maxBytes) throw new Error('Control message exceeds limit');
  const newline = buffer.indexOf(10);
  if (newline < 0) return null;
  if (newline !== buffer.length - 1) throw new Error('Only one control message is allowed per connection');
  return JSON.parse(buffer.subarray(0, newline).toString('utf8'));
}

export class ControlClient {
  constructor(socketPath = CONTROL_SOCKET) { this.socketPath = socketPath; }

  request(op, fields = {}, timeoutMs = DEFAULT_TIMEOUT_MS, { onProgress, onLog, signal } = {}) {
    signal?.throwIfAborted();
    const message = JSON.stringify({ op, ...fields }) + '\n';
    const requestLimit=isLargeOperation(op)?MAX_CACHE_REQUEST_BYTES:MAX_MESSAGE_BYTES;
    const responseLimit=isCacheOperation(op)?8*1024*1024:256*1024;
    if (Buffer.byteLength(message) > requestLimit) return Promise.reject(new Error('Control request exceeds limit'));
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(this.socketPath);
      let buffer = Buffer.alloc(0);
      let settled = false, receivedBytes = 0;
      let timer;
      const abort = () => finish(signal.reason instanceof Error ? signal.reason : new Error('Startup cancelled'));
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer); signal?.removeEventListener('abort', abort);
        socket.destroy();
        if (error) reject(error); else resolve(value);
      };
      timer = setTimeout(() => finish(new Error('Agent control request timed out')), timeoutMs);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) { abort(); return; }
      socket.on('connect', () => socket.write(message));
      socket.on('data', (chunk) => {
        receivedBytes += chunk.length;
        buffer = Buffer.concat([buffer, chunk]);
        try {
          if (receivedBytes > 16 * 1024 * 1024) throw new Error('Control response exceeds total limit');
          let newline;
          while (!settled && (newline = buffer.indexOf(10)) >= 0) {
            if (newline > responseLimit) throw new Error('Control message exceeds limit');
            const response = JSON.parse(buffer.subarray(0, newline).toString('utf8'));
            buffer = buffer.subarray(newline + 1);
            if (response?.type === 'progress' && op === 'start') {
              const progress = normalizeStartupProgress(response.progress);
              onProgress?.(progress); continue;
            }
            if (response?.type === 'log' && ['start', 'stop', 'diagnostics', 'recover'].includes(op)) { onLog?.(response.event); continue; }
            if (!response || typeof response !== 'object' || typeof response.ok !== 'boolean') throw new Error('Invalid control response');
            if (response.ok) finish(null, response.data);
            else finish(new Error(String(response.error || 'Agent control request failed')));
          }
          if (buffer.length > responseLimit) throw new Error('Control message exceeds limit');
        } catch (error) { finish(error); }
      });
      socket.on('error', (error) => finish(error));
      socket.on('end', () => { if (!settled) finish(new Error('Agent control response ended early')); });
    });
  }

  imageCache(protectedRefs) { return this.request('imageCache',{protectedRefs},60000); }
  imageCacheRemove(ids,protectedRefs) { return this.request('imageCacheRemove',{ids,protectedRefs},60000); }
  hostInfo() { return this.request('hostInfo'); }
  recover(options = {}) { return this.request('recover', {}, 120_000, options); }
  inventory(options = {}) { return this.request('inventory', {}, DEFAULT_TIMEOUT_MS, options); }
  start(sessionId, profile, adbPublicKey, onProgress, options = {}) { return this.request('start', { sessionId, profile, adbPublicKey }, 60 * 60_000, { ...options, onProgress }); }
  diagnostics(sessionId, onLog) { return this.request('diagnostics', { sessionId }, 15_000, { onLog }); }
  stop(sessionId, options = {}) { return this.request('stop', { sessionId }, 120_000, options); }
  setEgress(sessionId, enabled) { return this.request('setEgress', { sessionId, enabled }, 60_000); }
  cameraImage(sessionId, params) { return this.request('cameraImage', { sessionId, params }, 60_000); }
  emuConsole(sessionId, args) { return this.request('emuConsole', { sessionId, args }, 30_000); }
  setPolicy(policy) { return this.request('setPolicy', { policy }); }
  // The first catalog call builds the sdkmanager tools image, which takes a few minutes.
  emulatorCatalog(refresh = false) { return this.request('emulatorCatalog', { refresh }, 15 * 60_000); }
  emulatorBuild(packages, target) { return this.request('emulatorBuild', { packages, target }, 60_000); }
  prewarmImage(image, auth = null) { return this.request('prewarmImage', { image, auth }, 30 * 60_000); }
  emulatorCancel(jobId) { return this.request('emulatorCancel', { jobId }); }

  emulatorJobs(acknowledged = []) { return this.request('emulatorJobs', { acknowledged }); }
}

export async function createControlServer(control, socketPath = CONTROL_SOCKET) {
  const windowsPipe = process.platform === 'win32' && socketPath.startsWith('\\\\.\\pipe\\');
  if (!windowsPipe) {
    await mkdir(socketPath.slice(0, socketPath.lastIndexOf('/')), { recursive: true, mode: 0o770 });
    await rm(socketPath, { force: true });
  }
  const server = net.createServer((socket) => {
    let buffer = Buffer.alloc(0);
    let received = false;
    const controller = new AbortController();
    socket.once('close', () => controller.abort(new Error('Control client disconnected')));
    const report = progressReporter(progress => {
      if (socket.destroyed) return;
      if (socket.writableLength > 256 * 1024) { socket.destroy(new Error('Control client is too slow')); return; }
      socket.write(JSON.stringify({ type: 'progress', progress }) + '\n');
    });
    socket.setTimeout(15_000, () => socket.destroy());
    socket.on('data', (chunk) => {
      if (received) { socket.destroy(); return; }
      buffer = Buffer.concat([buffer, chunk]);
      let request;
      try { request = decodeLine(buffer, MAX_CACHE_REQUEST_BYTES); }
      catch (error) { received = true; socket.end(JSON.stringify({ ok: false, error: error.message }) + '\n'); return; }
      if (request === null) return;
      received = true;
      socket.setTimeout(request.op === 'prewarmImage' ? 30 * 60_000 : request.op === 'emulatorCatalog' ? 15 * 60_000 : request.op === 'start' ? 60 * 60_000 : ['recover', 'stop'].includes(request.op) ? 120_000 : 60_000, () => socket.destroy());
      Promise.resolve().then(() => {
        if(!isLargeOperation(request.op)&&buffer.length>MAX_MESSAGE_BYTES)throw new Error('Control request exceeds limit');
        return validateControlRequest(request);
      }).then((valid) => control.handle(valid, { onProgress: report, onLog: async event => {
        if (socket.destroyed) return;
        if (!socket.write(JSON.stringify({ type: 'log', event }) + '\n')) await new Promise(resolve => {
          const done = () => { socket.off('drain', done); socket.off('close', done); socket.off('error', done); resolve(); };
          socket.once('drain', done); socket.once('close', done); socket.once('error', done);
        });
      }, signal: controller.signal }))
        .then((data) => socket.end(JSON.stringify({ ok: true, data }) + '\n'))
        .catch((error) => socket.end(JSON.stringify({ ok: false, error: error.message || 'Control operation failed' }) + '\n'));
    });
    socket.on('error', () => {});
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
  if (!windowsPipe) await chmod(socketPath, 0o660);
  return server;
}
