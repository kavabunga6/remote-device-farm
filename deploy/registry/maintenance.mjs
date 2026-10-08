import { runCleanup } from './cleanup.mjs';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, chmod, chown } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { registryInventory, validateRemoval } from './storage.mjs';
const root = '/var/lib/registry', stateDir = '/run/registry-maintenance';
await mkdir(stateDir, { recursive: true, mode: 0o700 });
try { await writeFile(stateDir + '/token', randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 }); }
catch (error) { if (error.code !== 'EEXIST') throw error; }
await chown(stateDir, 0, 1000); await chmod(stateDir, 0o750);
await chown(stateDir + '/token', 0, 1000); await chmod(stateDir + '/token', 0o640);
const token = Buffer.from((await readFile(stateDir + '/token', 'utf8')).trim());
let backend, maintenance = false, shuttingDown = false, accepting = false, job = null;
const active = new Set();
const persist = async () => {
  await writeFile(stateDir + '/job.tmp', JSON.stringify(job), { mode: 0o600 });
  await rename(stateDir + '/job.tmp', stateDir + '/job.json');
};
try { job = JSON.parse(await readFile(stateDir + '/job.json', 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
if (job && ['queued', 'running'].includes(job.state)) { job.state = 'failed'; job.errorCode = 'interrupted'; await persist(); }
function startBackend() {
  backend = spawn('registry', ['serve', '/etc/docker/registry/config.yml'], { stdio: 'inherit' });
  backend.once('error', () => { if (!shuttingDown) process.exit(1); });
  backend.once('exit', () => { if (!maintenance && !shuttingDown) process.exit(1); });
}
async function waitReady() {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await fetch('http://127.0.0.1:5002/v2/', { signal: AbortSignal.timeout(1000) }).then(r => r.ok, () => false)) return;
    await delay(100);
  }
  throw new Error('Registry failed to restart');
}
function runGc() {
  return new Promise((resolve, reject) => {
    // Untagged published manifests are legitimate. Never pass --delete-untagged.
    const child = spawn('registry', ['garbage-collect', '/etc/docker/registry/config.yml'], { stdio: ['ignore', 'inherit', 'inherit'] });
    const timeout = setTimeout(() => child.kill('SIGKILL'), 30 * 60_000);
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', code => { clearTimeout(timeout); code === 0 ? resolve() : reject(new Error('GC failed')); });
  });
}
async function clean() {
  maintenance = true;
  try {
    await runCleanup({
      job, save: persist, inventory: () => registryInventory(root),
      drain: async () => { const deadline = Date.now() + 60000; while (active.size && Date.now() < deadline) await delay(100); if (active.size) throw new Error('Registry still has active requests'); },
      remove: async digest => { const response = await fetch('http://127.0.0.1:5002/v2/rdf-emulator/manifests/' + digest, { method: 'DELETE', signal: AbortSignal.timeout(30000) }); if (response.status !== 202 && response.status !== 404) throw new Error('Manifest deletion failed'); },
      stop: async () => { const child = backend; if (child.exitCode !== null || child.signalCode !== null) return; const stopped = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGTERM'); const timeout = setTimeout(() => child.kill('SIGKILL'), 10000); await stopped; clearTimeout(timeout); },
      gc: runGc, restart: async () => { startBackend(); try { await waitReady(); } catch { process.exit(1); } }
    });
  } catch { job.state = 'failed'; job.errorCode = 'registry_cleanup_failed'; }
  finally { maintenance = false; await persist(); }
}
startBackend(); await waitReady();
const proxy = http.createServer((req, res) => {
  if (maintenance) { res.writeHead(503, { 'Retry-After': '30' }); res.end(); return; }
  const upstream = http.request({ hostname: '127.0.0.1', port: 5002, path: req.url, method: req.method, headers: req.headers }, response => {
    res.writeHead(response.statusCode, response.headers); response.pipe(res);
  });
  active.add(upstream);
  const finished = () => { active.delete(upstream); upstream.destroy(); };
  res.once('close', finished); req.once('aborted', finished);
  upstream.once('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); active.delete(upstream); });
  req.pipe(upstream);
});
const control = http.createServer(async (req, res) => {
  const presented = Buffer.from(String(req.headers.authorization ?? '').replace(/^Bearer /, ''));
  const reply = (code, data) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
  if (presented.length !== token.length || !timingSafeEqual(presented, token)) return reply(401, {});
  try {
    if (req.method === 'GET' && req.url === '/inventory') return reply(200, { ...await registryInventory(root), maintenance });
    if (req.method === 'GET' && req.url?.startsWith('/jobs/')) return reply(200, { job: job?.id === req.url.slice(6) ? job : null });
    if (req.method !== 'POST' || req.url !== '/jobs') return reply(404, {});
    let bytes = 0, body = '';
    for await (const chunk of req) { bytes += chunk.length; if (bytes > 64000) return reply(413, {}); body += chunk; }
    const input = JSON.parse(body);
    if (!/^[a-f0-9-]{36}$/.test(input.id) || Object.keys(input).some(key => !['id', 'digests'].includes(key))) return reply(400, {});
    if (job?.id === input.id) return reply(202, { job });
    if (accepting || maintenance || ['queued', 'running'].includes(job?.state)) return reply(409, {});
    accepting = true;
    try {
      validateRemoval((await registryInventory(root)).items, input.digests);
      const previous = job;
      job = { id: input.id, digests: input.digests, deleted: [], state: 'queued', stage: 'queued', errorCode: null };
      try { await persist(); } catch (error) { job = previous; throw error; }
      reply(202, { job });
      void clean().catch(() => process.exit(1));
    } finally { accepting = false; }
  } catch { reply(503, { errorCode: 'registry_unavailable' }); }
});
control.requestTimeout = 30000; control.headersTimeout = 15000;
proxy.listen(5000, '0.0.0.0'); control.listen(5001, '0.0.0.0');
const stop = () => { shuttingDown = true; proxy.close(); control.close(); backend.kill('SIGTERM'); setTimeout(() => process.exit(0), 10000).unref(); backend.once('exit', () => process.exit(0)); };
process.once('SIGTERM', stop); process.once('SIGINT', stop);
