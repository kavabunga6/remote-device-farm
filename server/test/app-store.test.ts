import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { deflateRawSync } from 'node:zlib';
import express from 'express';
import { PGlite } from '@electric-sql/pglite';
import type { Pool } from 'pg';
import type { Config } from '../src/config.js';
import { loadConfig } from '../src/config.js';
import type { AuthService } from '../src/auth.js';
import type { AgentHub } from '../src/agent.js';
import { ApiError } from '../src/http-common.js';
import { createServerContext } from '../src/server-context.js';
import { registerAppRoutes } from '../src/routes/app-routes.js';
import {
  appFilePath, inspectApk, isPrivateAddress, loadAppStoreConfig, parseDownloadUrl, parseManifest, urlHostLabel,
} from '../src/app-store.js';

// ---- Fixture builders ----

function axml(options: { utf8: boolean; typed: boolean }): Buffer {
  const strings = ['package', 'versionName', 'manifest', 'com.example.demo', '1.2.3'];
  const encoded = strings.map(text => {
    if (options.utf8) {
      const bytes = Buffer.from(text, 'utf8');
      return Buffer.concat([Buffer.from([text.length, bytes.length]), bytes, Buffer.from([0])]);
    }
    const body = Buffer.from(text, 'utf16le');
    const head = Buffer.alloc(2); head.writeUInt16LE(text.length);
    return Buffer.concat([head, body, Buffer.alloc(2)]);
  });
  const offsets = Buffer.alloc(strings.length * 4);
  let at = 0;
  encoded.forEach((item, i) => { offsets.writeUInt32LE(at, i * 4); at += item.length; });
  let data = Buffer.concat(encoded);
  if (data.length % 4) data = Buffer.concat([data, Buffer.alloc(4 - (data.length % 4))]);
  const poolHeader = Buffer.alloc(28);
  poolHeader.writeUInt16LE(0x0001, 0); poolHeader.writeUInt16LE(28, 2);
  poolHeader.writeUInt32LE(28 + offsets.length + data.length, 4);
  poolHeader.writeUInt32LE(strings.length, 8);
  poolHeader.writeUInt32LE(options.utf8 ? 0x100 : 0, 16);
  poolHeader.writeUInt32LE(28 + offsets.length, 20);
  const pool = Buffer.concat([poolHeader, offsets, data]);

  const attribute = (name: number, raw: number, typed: number | null): Buffer => {
    const b = Buffer.alloc(20);
    b.writeUInt32LE(0xffffffff, 0); b.writeUInt32LE(name, 4); b.writeUInt32LE(raw, 8);
    b.writeUInt16LE(8, 12); b.writeUInt8(0, 14); b.writeUInt8(typed === null ? 0 : 0x03, 15); b.writeUInt32LE(typed ?? 0, 16);
    return b;
  };
  const attrs = options.typed
    ? [attribute(0, 0xffffffff, 3), attribute(1, 0xffffffff, 4)]
    : [attribute(0, 3, null), attribute(1, 4, null)];
  const element = Buffer.alloc(36);
  element.writeUInt16LE(0x0102, 0); element.writeUInt16LE(16, 2);
  element.writeUInt32LE(36 + attrs.length * 20, 4);
  element.writeUInt32LE(0xffffffff, 12); // comment
  element.writeUInt32LE(0xffffffff, 16); // namespace
  element.writeUInt32LE(2, 20); // name: manifest
  element.writeUInt16LE(20, 24); element.writeUInt16LE(20, 26); element.writeUInt16LE(attrs.length, 28);
  const body = Buffer.concat([pool, element, ...attrs]);
  const header = Buffer.alloc(8);
  header.writeUInt16LE(0x0003, 0); header.writeUInt16LE(8, 2); header.writeUInt32LE(8 + body.length, 4);
  return Buffer.concat([header, body]);
}

type Entry = { name: string; data: Buffer; deflate?: boolean };

function zip(entries: Entry[]): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const stored = entry.deflate ? deflateRawSync(entry.data) : entry.data;
    const name = Buffer.from(entry.name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(entry.deflate ? 8 : 0, 8);
    local.writeUInt32LE(stored.length, 18); local.writeUInt32LE(entry.data.length, 22); local.writeUInt16LE(name.length, 26);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0); dir.writeUInt16LE(20, 4); dir.writeUInt16LE(20, 6); dir.writeUInt16LE(entry.deflate ? 8 : 0, 10);
    dir.writeUInt32LE(stored.length, 20); dir.writeUInt32LE(entry.data.length, 24); dir.writeUInt16LE(name.length, 28);
    dir.writeUInt32LE(offset, 42);
    locals.push(local, name, stored);
    central.push(dir, name);
    offset += 30 + name.length + stored.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const apk = (extra: Entry[] = [], options = { utf8: false, typed: true }): Buffer =>
  zip([{ name: 'AndroidManifest.xml', data: axml(options), deflate: true }, ...extra]);

// ---- Pure logic ----

test('the manifest reader handles UTF-16 and UTF-8 pools, typed and raw values', () => {
  for (const utf8 of [false, true]) for (const typed of [false, true]) {
    assert.deepEqual(parseManifest(axml({ utf8, typed })), { packageName: 'com.example.demo', versionName: '1.2.3' });
  }
  assert.throws(() => parseManifest(Buffer.from('not xml at all')));
  assert.throws(() => parseManifest(axml({ utf8: false, typed: true }).subarray(0, 40)));
});

test('APK inspection needs a ZIP with a manifest and tolerates a broken manifest', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'apps-test-'));
  try {
    const write = async (name: string, data: Buffer) => { const file = path.join(dir, name); await writeFile(file, data); return file; };
    assert.deepEqual(await inspectApk(await write('a.apk', apk())), { packageName: 'com.example.demo', versionName: '1.2.3' });
    assert.deepEqual(await inspectApk(await write('stored.apk', zip([{ name: 'AndroidManifest.xml', data: axml({ utf8: true, typed: false }) }]))),
      { packageName: 'com.example.demo', versionName: '1.2.3' });
    assert.deepEqual(await inspectApk(await write('broken.apk', zip([{ name: 'AndroidManifest.xml', data: Buffer.from('junk junk junk') }]))), {});
    assert.equal(await inspectApk(await write('nomanifest.apk', zip([{ name: 'classes.dex', data: Buffer.from('x') }]))), null);
    assert.equal(await inspectApk(await write('text.apk', Buffer.from('hello world, not a zip file at all'))), null);
    assert.equal(await inspectApk(path.join(dir, 'missing.apk')), null);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('private, loopback, link-local and reserved addresses are rejected', () => {
  for (const address of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '0.0.0.0',
    '100.64.0.1', '224.0.0.1', '255.255.255.255', '::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', '::ffff:127.0.0.1',
    '::ffff:7f00:1', '::ffff:10.0.0.1', '64:ff9b::a00:1', 'ff02::1', '2001:db8::1', 'garbage']) {
    assert.equal(isPrivateAddress(address), true, address);
  }
  for (const address of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '93.184.216.34', '2606:4700:4700::1111', '::ffff:8.8.8.8']) {
    assert.equal(isPrivateAddress(address), false, address);
  }
});

test('download URLs must be https without credentials and not point at private literals', () => {
  const strict = { allowHttp: false, allowPrivate: false };
  assert.equal(parseDownloadUrl('https://ci.example.com/a.apk?sig=1', strict).hostname, 'ci.example.com');
  for (const bad of ['http://ci.example.com/a.apk', 'ftp://x/a.apk', 'file:///etc/passwd', 'https://user:pw@ci.example.com/a.apk',
    'https://127.0.0.1/a.apk', 'https://[::1]/a.apk', 'https://169.254.169.254/latest', '', 'not a url', 5, 'https://x.com/' + 'a'.repeat(2100)]) {
    assert.throws(() => parseDownloadUrl(bad, strict), undefined, String(bad));
  }
  assert.equal(parseDownloadUrl('http://ci.example.com/a.apk', { allowHttp: true, allowPrivate: false }).protocol, 'http:');
  assert.equal(parseDownloadUrl('https://10.0.0.5/a.apk', { allowHttp: false, allowPrivate: true }).hostname, '10.0.0.5');
  assert.equal(urlHostLabel(new URL('https://ci.example.com/a.apk?token=secret')), 'ci.example.com');
});

test('stored files are addressed by generated ids only', () => {
  const root = path.resolve(os.tmpdir(), 'store-root');
  const user = '11111111-1111-4111-8111-111111111111';
  const id = '22222222-2222-4222-8222-222222222222';
  assert.equal(appFilePath(root, user, id), path.join(root, user, id + '.apk'));
  for (const bad of ['../etc/passwd', '..', id + '/../x', '', 'x'.repeat(36)]) {
    assert.throws(() => appFilePath(root, user, bad));
    assert.throws(() => appFilePath(root, bad, id));
  }
});

test('app store settings have defaults and are validated', () => {
  const base = { DATABASE_URL: 'postgres://x', AGENT_TOKEN: 'a'.repeat(32), BOOTSTRAP_AGENT_ID: 'agent-1', LOCAL_ADMIN_USERNAME: 'a', LOCAL_ADMIN_PASSWORD: 'x'.repeat(12) };
  const defaults = loadConfig(base).apps;
  assert.equal(defaults.maxFileBytes, 200 * 1048576);
  assert.equal(defaults.maxUserBytes, 1024 * 1048576);
  assert.equal(defaults.dir, '/data/apps');
  assert.equal(defaults.allowHttp, false);
  assert.equal(loadAppStoreConfig({ APP_STORE_MAX_FILE_MB: '30', APP_ALLOW_PRIVATE: 'true' }).allowPrivate, true);
  assert.throws(() => loadAppStoreConfig({ APP_STORE_MAX_FILE_MB: '0' }));
  assert.throws(() => loadAppStoreConfig({ APP_STORE_DIR: 'relative/dir' }));
  assert.throws(() => loadAppStoreConfig({ APP_ALLOW_HTTP: 'yes' }));
});

// ---- API ----

const MIGRATIONS = ['001_init', '002_gpu_mode', '003_default_profile_resources', '004_guest_resources', '005_host_settings',
  '006_adb_port_access', '008_user_adb_keys', '009_uploaded_adb_public_keys', '010_user_settings_audit', '011_node_management',
  '012_session_lifecycle', '015_app_store'];

const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';
const ADMIN = '44444444-4444-4444-8444-444444444444';
const SESSION_A = 'a0000000-0000-4000-8000-000000000001';

type Call = { action: string; params: Record<string, unknown> };

async function harness(apps: Partial<Config['apps']> = {}) {
  const db = new PGlite();
  for (const file of MIGRATIONS) await db.exec(await readFile(new URL(`../migrations/${file}.sql`, import.meta.url), 'utf8'));
  await db.query("INSERT INTO users(id,provider,subject,username,display_name) VALUES($1,'local','a','a','A'),($2,'local','b','b','B')", [USER_A, USER_B]);
  await db.query("INSERT INTO users(id,provider,subject,username,display_name,role) VALUES($1,'local','root','root','Root','admin')", [ADMIN]);
  await db.query("INSERT INTO hosts(id,name,slots) VALUES('host-1','Host',3)");
  await db.query("INSERT INTO sessions(id,owner_user_id,host_id,profile_id,state) VALUES($1,$2,'host-1','android-30','running')", [SESSION_A, USER_A]);
  const dir = await mkdtemp(path.join(os.tmpdir(), 'apps-store-'));
  const state = { actor: USER_A };
  const users: Record<string, object> = {
    [USER_A]: { id: USER_A, username: 'a', displayName: 'A', role: 'user', provider: 'local' },
    [USER_B]: { id: USER_B, username: 'b', displayName: 'B', role: 'user', provider: 'local' },
    [ADMIN]: { id: ADMIN, username: 'root', displayName: 'Root', role: 'admin', provider: 'local' },
  };
  const calls: Call[] = [];
  const pool = { query: db.query.bind(db) } as unknown as Pool;
  const auth = { authenticate: async () => ({ user: users[state.actor], via: 'cookie' }) } as unknown as AuthService;
  const hub = {
    hasAgent: () => true,
    command: async (_host: string, _session: string, action: string, params: Record<string, unknown>) => {
      calls.push({ action, params });
      return action === 'app-begin' ? { transferId: 't1' } : { installed: true, output: 'Success' };
    },
  } as unknown as AgentHub;
  const config = {
    maxSessionsPerUser: 3, idleTimeoutMinutes: 0, maxSessionHours: 0,
    apps: { dir, maxFileBytes: 200 * 1048576, maxUserBytes: 1024 * 1048576, maxApps: 50, allowHttp: false, allowPrivate: false, ...apps },
  } as Config;
  const context = createServerContext(pool, config, auth, undefined, hub);
  const app = express();
  app.use(express.json());
  registerAppRoutes(app, context);
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (error instanceof ApiError) res.status(error.status).json({ error: { code: error.code, message: error.message } });
    else { console.error(error); res.status(500).json({ error: { code: 'internal_error' } }); }
  });
  const server = createServer(app);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const send = (p: string, method = 'GET', body?: unknown) => fetch(base + p, {
    method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const upload = (data: Buffer, name = 'demo.apk', note?: string) => {
    const form = new FormData();
    if (note !== undefined) form.append('note', note);
    form.append('file', new Blob([data]), name);
    return fetch(base + '/api/apps', { method: 'POST', body: form });
  };
  const close = async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await db.close();
    await rm(dir, { recursive: true, force: true });
  };
  return { state, send, upload, calls, close, dir, db };
}

type AppBody = { app: { id: string; name: string; packageName: string | null; versionName: string | null; size: number; note: string | null } };
const code = async (response: Response): Promise<string> => ((await response.json()) as { error: { code: string } }).error.code;

test('uploading stores the file, parses the manifest, lists and deletes it', async () => {
  const h = await harness();
  try {
    const response = await h.upload(apk(), 'Моё приложение.apk', 'ночная сборка');
    assert.equal(response.status, 201);
    const created = await response.json() as AppBody & { usage: { usedBytes: number; count: number } };
    assert.equal(created.app.name, 'Моё приложение.apk');
    assert.equal(created.app.packageName, 'com.example.demo');
    assert.equal(created.app.versionName, '1.2.3');
    assert.equal(created.app.note, 'ночная сборка');
    assert.equal(created.usage.count, 1);
    const files = await readdir(path.join(h.dir, USER_A));
    assert.deepEqual(files, [created.app.id + '.apk']);

    const listed = await (await h.send('/api/apps')).json() as { apps: unknown[]; usage: { maxBytes: number } };
    assert.equal(listed.apps.length, 1);
    assert.equal(listed.usage.maxBytes, 1024 * 1048576);

    assert.equal((await h.upload(apk(), 'again.apk')).status, 409, 'same content twice');
    assert.equal((await h.send('/api/apps/' + created.app.id, 'DELETE')).status, 200);
    assert.deepEqual(await readdir(path.join(h.dir, USER_A)), []);
    assert.equal((await h.send('/api/apps/' + created.app.id, 'DELETE')).status, 404);
    const events = await h.db.query("SELECT action FROM audit_events WHERE action LIKE 'app.%' ORDER BY id");
    assert.deepEqual(events.rows.map(row => (row as { action: string }).action), ['app.uploaded', 'app.deleted']);
  } finally { await h.close(); }
});

test('files that are not APKs are refused and leave nothing on disk', async () => {
  const h = await harness();
  try {
    assert.equal(await code(await h.upload(Buffer.from('plain text'), 'a.apk')), 'not_apk');
    assert.equal(await code(await h.upload(zip([{ name: 'classes.dex', data: Buffer.from('x') }]), 'a.apk')), 'not_apk');
    assert.equal(await code(await h.upload(apk(), 'a.zip')), 'not_apk');
    assert.equal(await code(await h.upload(apk(), 'a.apk', 'x'.repeat(201))), 'invalid_note');
    assert.deepEqual(await readdir(path.join(h.dir, USER_A)), []);
  } finally { await h.close(); }
});

test('size, space and count limits are enforced', async () => {
  const filler = (n: number, seed: number) => ({ name: `assets/f${seed}`, data: Buffer.alloc(n, seed) });
  const small = await harness({ maxFileBytes: 2000 });
  try {
    assert.equal(await code(await small.upload(apk([filler(4000, 1)]))), 'app_too_large');
    assert.deepEqual(await readdir(path.join(small.dir, USER_A)), [], 'the partial file is removed');
  } finally { await small.close(); }

  const first = apk([filler(3000, 1)]);
  const quota = await harness({ maxUserBytes: first.length * 2 - 10 });
  try {
    assert.equal((await quota.upload(first, 'one.apk')).status, 201);
    assert.equal(await code(await quota.upload(apk([filler(3000, 2)]), 'two.apk')), 'quota_exceeded');
    assert.equal((await readdir(path.join(quota.dir, USER_A))).length, 1);
  } finally { await quota.close(); }

  const few = await harness({ maxApps: 2 });
  try {
    assert.equal((await few.upload(apk([filler(10, 1)]))).status, 201);
    assert.equal((await few.upload(apk([filler(10, 2)]))).status, 201);
    assert.equal(await code(await few.upload(apk([filler(10, 3)]))), 'app_limit');
  } finally { await few.close(); }
});

test('apps belong to their owner: nobody else can list, delete or install them', async () => {
  const h = await harness();
  try {
    const created = await (await h.upload(apk())).json() as AppBody;
    const install = (id: string) => h.send(`/api/sessions/${SESSION_A}/apps/install`, 'POST', { appId: id });

    h.state.actor = USER_B;
    assert.deepEqual(((await (await h.send('/api/apps')).json()) as { apps: unknown[] }).apps, []);
    assert.equal((await h.send('/api/apps/' + created.app.id, 'DELETE')).status, 404);
    assert.equal((await install(created.app.id)).status, 404, 'foreign session');

    h.state.actor = ADMIN;
    assert.equal((await install(created.app.id)).status, 404, 'an administrator uses only their own library');
    assert.equal((await h.send('/api/apps/' + created.app.id, 'DELETE')).status, 404);
    assert.equal(h.calls.length, 0);

    h.state.actor = USER_A;
    assert.equal((await h.send('/api/apps')).status, 200);
    assert.equal((await install('not-a-uuid')).status, 400);
    assert.equal((await install(created.app.id)).status, 200);
    assert.equal(h.calls[0]!.action, 'file');
    assert.equal(h.calls[0]!.params.install, true);
    assert.match(String(h.calls[0]!.params.name), /^app-[a-f0-9]{8}\.apk$/);
    const events = await h.db.query("SELECT action,target_type FROM audit_events WHERE action='session.app_installed'");
    assert.equal(events.rows.length, 1);

    // An administrator installs their own app into someone else's session.
    h.state.actor = ADMIN;
    const own = await (await h.upload(apk([{ name: 'x', data: Buffer.from('1') }]), 'admin.apk')).json() as AppBody;
    assert.equal((await install(own.app.id)).status, 200);
  } finally { await h.close(); }
});

test('sessions that are not running refuse installs', async () => {
  const h = await harness();
  try {
    const created = await (await h.upload(apk())).json() as AppBody;
    await h.db.query("UPDATE sessions SET state='starting' WHERE id=$1", [SESSION_A]);
    assert.equal(await code(await h.send(`/api/sessions/${SESSION_A}/apps/install`, 'POST', { appId: created.app.id })), 'session_not_ready');
    await h.db.query("UPDATE sessions SET state='stopped' WHERE id=$1", [SESSION_A]);
    assert.equal((await h.send(`/api/sessions/${SESSION_A}/apps/install`, 'POST', { appId: created.app.id })).status, 409);
  } finally { await h.close(); }
});

test('large APKs are sent in bounded chunks', async () => {
  const h = await harness({ maxFileBytes: 80 * 1048576 });
  try {
    const big = apk([{ name: 'assets/big.bin', data: Buffer.alloc(51 * 1048576, 7) }]);
    const created = await (await h.upload(big, 'big.apk')).json() as AppBody;
    const response = await h.send(`/api/sessions/${SESSION_A}/apps/install`, 'POST', { appId: created.app.id });
    assert.equal(response.status, 200);
    const actions = h.calls.map(call => call.action);
    assert.equal(actions[0], 'app-begin');
    assert.equal(actions.at(-1), 'app-finish');
    const chunks = h.calls.filter(call => call.action === 'app-chunk');
    assert.equal(chunks.length, Math.ceil(big.length / (4 * 1048576)));
    assert.ok(chunks.every((call, i) => call.params.index === i && String(call.params.contentBase64).length <= Math.ceil(4 * 1048576 / 3) * 4));
    assert.equal(h.calls[0]!.params.size, big.length);
  } finally { await h.close(); }
});

test('install from URL downloads, validates and installs without keeping the file', async () => {
  const served = apk();
  const origin: Server = createServer((req, res) => {
    if (req.url?.startsWith('/app.apk')) { res.writeHead(200, { 'Content-Type': 'application/octet-stream' }); res.end(served); }
    else if (req.url === '/redirect') { res.writeHead(302, { Location: '/app.apk' }); res.end(); }
    else if (req.url === '/text') { res.writeHead(200); res.end('hello, not an apk'); }
    else { res.writeHead(404); res.end(); }
  });
  origin.listen(0, '127.0.0.1');
  await once(origin, 'listening');
  const port = (origin.address() as { port: number }).port;
  const h = await harness({ allowHttp: true, allowPrivate: true, maxFileBytes: 1000 * 1000 });
  try {
    const install = (url: unknown, extra: object = {}) => h.send(`/api/sessions/${SESSION_A}/apps/install-url`, 'POST', { url, ...extra });
    assert.equal((await install(`http://127.0.0.1:${port}/app.apk?token=secret`)).status, 200);
    assert.equal(h.calls[0]!.action, 'file');
    assert.equal((await install(`http://127.0.0.1:${port}/redirect`)).status, 200);
    assert.equal(await code(await install(`http://127.0.0.1:${port}/text`)), 'not_apk');
    assert.equal(await code(await install(`http://127.0.0.1:${port}/missing`)), 'download_failed');
    assert.equal(await code(await install(`http://127.0.0.1:${port}/app.apk`, { headers: { Authorization: 'Bearer x' } })), 'headers_unsupported');
    assert.equal(await code(await install('ftp://example.com/a.apk')), 'url_not_https');
    const events = await h.db.query("SELECT target_type,target_id FROM audit_events WHERE action='session.app_installed'");
    assert.deepEqual(events.rows, [{ target_type: 'host', target_id: '127.0.0.1' }, { target_type: 'host', target_id: '127.0.0.1' }]);
    assert.deepEqual(await readdir(path.join(h.dir, '_tmp')), [], 'temporary downloads are removed');
  } finally {
    await new Promise<void>(resolve => origin.close(() => resolve()));
    await h.close();
  }

  const strict = await harness();
  try {
    const install = (url: string) => strict.send(`/api/sessions/${SESSION_A}/apps/install-url`, 'POST', { url });
    assert.equal(await code(await install('https://127.0.0.1/a.apk')), 'url_private');
    assert.equal(await code(await install('https://localhost/a.apk')), 'url_private', 'checked after DNS resolution');
    assert.equal(await code(await install('http://example.com/a.apk')), 'url_not_https');
    assert.equal(strict.calls.length, 0);
  } finally { await strict.close(); }
});
