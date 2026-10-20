import { agentMessage } from './messages.mjs';
import { installApkSet } from './apk-sets.mjs';
import { loadAdbTokenSigner } from './adb-device-auth.mjs';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { logcatArgv, pageLogcat, parseLogcat, validateLogcatParams } from './logcat.mjs';
import { parseLogcatApps, parseAppPids, parseUidLogcat, appUidTokens } from './logcat-apps.mjs';
import { DEVICE_INFO_SCRIPT, parseDeviceInfo } from './device-info.mjs';

const ALLOWED_ADB_COMMANDS = new Set(['shell', 'exec-out', 'logcat', 'uninstall', 'get-state', 'get-serialno', 'reboot', 'devices', 'version']);

export function validateAdbArgv(argv) {
  if (!Array.isArray(argv) || argv.length < 1 || argv.length > 64 ||
      !argv.every((item) => typeof item === 'string' && item.length > 0 && item.length <= 4096 && !item.includes('\0'))) {
    throw new Error('Invalid ADB command');
  }
  if (!ALLOWED_ADB_COMMANDS.has(argv[0])) {
    throw new Error('Use the session ADB tunnel for this command');
  }
  // `reboot bootloader|recovery|sideload|fastboot` would take a physical phone out of reach of the farm.
  if (['devices', 'version', 'get-state', 'get-serialno', 'reboot'].includes(argv[0]) && argv.length !== 1) {
    throw new Error('This ADB command accepts no extra arguments');
  }
  return argv;
}

export function runProcess(command, args, { timeoutMs = 30000, maxOutputBytes = 2 * 1024 * 1024, encoding = 'utf8', signal } = {}) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], signal, killSignal: 'SIGKILL' });
    const stdout = [];
    const stderr = [];
    let outSize = 0;
    let errSize = 0;
    let settled = false;
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    };
    child.on('error', fail);
    child.stdout.on('data', (chunk) => {
      outSize += chunk.length;
      if (outSize > maxOutputBytes) return child.kill('SIGKILL');
      stdout.push(chunk);
    });
    child.stderr.on('data', (chunk) => {
      errSize += chunk.length;
      if (errSize > maxOutputBytes) return child.kill('SIGKILL');
      stderr.push(chunk);
    });
    child.on('close', (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) return reject(new Error(`Command stopped (${signal}) or exceeded limits`));
      const out = Buffer.concat(stdout);
      const err = Buffer.concat(stderr);
      resolve({ stdout: encoding === null ? out : out.toString(encoding), stderr: encoding === null ? err : err.toString(encoding), exitCode: exitCode ?? 1 });
    });
  });
}

export class AdbClient {
  constructor(execute = runProcess) { this.execute = execute; }

  publicKeyPath() { return process.env.ADB_PUBLIC_KEY_FILE || path.join(os.homedir(), '.android', 'adbkey.pub'); }

  async authSigner() {
    await this.publicKey();
    return loadAdbTokenSigner(this.publicKeyPath());
  }

  async publicKey() {
    const keyPath = this.publicKeyPath();
    try { return await readFile(keyPath, 'utf8'); }
    catch {
      await this.execute('adb', ['start-server'], { timeoutMs: 15000 });
      return readFile(keyPath, 'utf8');
    }
  }

  async connect(serial, { signal } = {}) {
    signal?.throwIfAborted();
    // `adb connect` is for network endpoints (host:port). USB devices and emulators are already attached; running it
    // with a USB serial fails every time and would stall each operation for the full retry loop.
    if (!serial.includes(':')) return;
    for (let attempt = 0; attempt < 15; attempt++) {
      signal?.throwIfAborted();
      const result = await this.execute('adb', ['connect', serial], { timeoutMs: 5000, signal }).catch(() => null);
      signal?.throwIfAborted();
      if (result?.exitCode === 0 && !/failed|unable|cannot/i.test(result.stdout)) return;
      await delay(1000, undefined, { signal });
    }
    throw new Error('Emulator ADB is not ready');
  }

  async run(serial, argv, options) {
    const result = await this.execute('adb', ['-s', serial, ...argv], options);
    return result;
  }

  async command(serial, argv) {
    validateAdbArgv(argv);
    if (argv[0] === 'devices') {
      await this.connect(serial);
      return this.devices(serial);
    }
    if (argv[0] === 'version') return this.version();
    await this.connect(serial);
    return this.run(serial, argv, { timeoutMs: 30000 });
  }

  async devices(serial) {
    const result = await this.execute('adb', ['devices'], { timeoutMs: 5000, maxOutputBytes: 64 * 1024 });
    if (result.exitCode !== 0) return { stdout: '', stderr: 'ADB device list is unavailable', exitCode: result.exitCode };
    const line = String(result.stdout).split(/\r?\n/).find((item) => item.startsWith(serial + '\t'));
    const state = line?.slice(serial.length + 1).trim();
    const visible = state && /^(device|offline|unauthorized|recovery|bootloader|sideload)$/.test(state)
      ? serial + '\t' + state + '\n' : '';
    return { stdout: 'List of devices attached\n' + visible, stderr: '', exitCode: 0 };
  }

  async version() {
    const result = await this.execute('adb', ['version'], { timeoutMs: 5000, maxOutputBytes: 64 * 1024 });
    if (result.exitCode !== 0) return { stdout: '', stderr: 'ADB version is unavailable', exitCode: result.exitCode };
    const lines = String(result.stdout).split(/\r?\n/);
    const protocol = lines.find((line) => /^Android Debug Bridge version [0-9.]+$/.test(line));
    const build = lines.find((line) => /^Version [0-9A-Za-z.+_-]+$/.test(line));
    if (!protocol) return { stdout: '', stderr: 'ADB version is unavailable', exitCode: 1 };
    return { stdout: protocol + '\n' + (build ? build + '\n' : ''), stderr: '', exitCode: 0 };
  }

  async logcatApps(serial) {
    await this.connect(serial);
    return { apps: await this.readLogcatApps(serial) };
  }

  async readLogcatApps(serial) {
    const result = await this.run(serial, ['shell', 'pm', 'list', 'packages', '-U', '--user', 'current'], { timeoutMs: 10000, maxOutputBytes: 2 * 1024 * 1024 });
    if (result.exitCode !== 0) throw new Error('Не удалось получить приложения Android');
    return parseLogcatApps(result.stdout);
  }

  async logcat(serial, params) {
    const options = validateLogcatParams(params);
    await this.connect(serial);
    let app = null;
    let uidTokens = null;
    if (options.packageName) {
      const apps = await this.readLogcatApps(serial);
      const selected = apps.find(item => item.packageName === options.packageName);
      if (!selected) throw new Error('Приложение не установлено. Обновите список приложений.');
      options.uid = selected.uid;
      let uidName = '';
      if (selected.uid % 100000 < 10000) {
        const identity = await this.run(serial, ['shell', 'id', '-nu', String(selected.uid)], { timeoutMs: 5000, maxOutputBytes: 1024 }).catch(() => null);
        if (identity?.exitCode === 0) uidName = String(identity.stdout).trim();
      }
      uidTokens = appUidTokens(selected.uid, uidName);
      const processes = await this.run(serial, ['shell', 'ps', '-A', '-o', 'PID,UID,NAME'], { timeoutMs: 5000, maxOutputBytes: 2 * 1024 * 1024 }).catch(() => null);
      app = { ...selected,
        pids: processes?.exitCode === 0 ? parseAppPids(processes.stdout, uidTokens) : null,
        sharedPackages: apps.filter(item => item.uid === selected.uid && item.packageName !== selected.packageName).map(item => item.packageName),
      };
    }
    const result = await this.run(serial, logcatArgv(options), { timeoutMs: 20000, maxOutputBytes: 16 * 1024 * 1024 });
    if (result.exitCode !== 0) throw new Error(result.stderr || 'Logcat is unavailable');
    const page = pageLogcat(app ? parseUidLogcat(result.stdout) : parseLogcat(result.stdout), options);
    if (app) page.entries = page.entries.filter(entry => uidTokens.has(entry.uid)).map(({ uid: _uid, ...entry }) => entry);
    return { ...page, ...(app ? { app } : {}) };
  }

  async clearLogcat(serial) {
    await this.connect(serial);
    const result = await this.run(serial, ['logcat', '-b', 'all', '-c'], { timeoutMs: 10000 });
    if (result.exitCode !== 0) throw new Error(result.stderr || 'Logcat clear failed');
    return { cleared: true };
  }

  async deviceInfo(serial) {
    await this.connect(serial);
    const result = await this.run(serial, ['shell', DEVICE_INFO_SCRIPT], { timeoutMs: 30000, maxOutputBytes: 4 * 1024 * 1024 });
    if (result.exitCode !== 0 && !String(result.stdout).includes('##props')) throw new Error(result.stderr || 'Device information is unavailable');
    return parseDeviceInfo(result.stdout);
  }

  async screenshot(serial) {
    await this.connect(serial);
    const result = await this.run(serial, ['exec-out', 'screencap', '-p'], { timeoutMs: 30000, maxOutputBytes: 16 * 1024 * 1024, encoding: null });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString('utf8') || 'Screenshot failed');
    const png = result.stdout;
    if (png.length < 24 || !png.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) throw new Error('Invalid screenshot');
    return { type: 'frame', mime: 'image/png', data: png.toString('base64'), width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
  }

  async input(serial, params) {
    const kind = params?.kind;
    const coord = (value) => {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 0 || n > 8192) throw new Error('Invalid screen coordinate');
      return String(n);
    };
    let argv;
    if (kind === 'tap') argv = ['shell', 'input', 'tap', coord(params.x), coord(params.y)];
    else if (kind === 'swipe') {
      const duration = Number(params.durationMs ?? 300);
      if (!Number.isInteger(duration) || duration < 50 || duration > 5000) throw new Error('Invalid swipe duration');
      argv = ['shell', 'input', 'swipe', coord(params.x1), coord(params.y1), coord(params.x2), coord(params.y2), String(duration)];
    } else if (kind === 'key') {
      const code = Number(params.keyCode);
      if (!Number.isInteger(code) || code < 1 || code > 300) throw new Error('Invalid Android keycode');
      argv = ['shell', 'input', 'keyevent', String(code)];
    } else if (kind === 'text') {
      if (typeof params.text !== 'string' || params.text.length > 1000 || /[\r\n\0]/.test(params.text)) throw new Error('Invalid input text');
      argv = ['shell', 'input', 'text', params.text.replaceAll(' ', '%s')];
    } else throw new Error('Unknown input kind');
    await this.connect(serial);
    const result = await this.run(serial, argv, { timeoutMs: 10000 });
    if (result.exitCode !== 0) throw new Error(result.stderr || 'Input injection failed');
    return { ok: true };
  }

  async rotate(serial, orientation) {
    if (!['portrait', 'landscape'].includes(orientation)) throw new Error('Invalid orientation');
    await this.connect(serial);
    const rotation = orientation === 'portrait' ? '0' : '1';
    const a = await this.run(serial, ['shell', 'settings', 'put', 'system', 'accelerometer_rotation', '0']);
    const b = await this.run(serial, ['shell', 'settings', 'put', 'system', 'user_rotation', rotation]);
    if (a.exitCode !== 0 || b.exitCode !== 0) throw new Error(a.stderr || b.stderr || 'Rotation failed');
    return { orientation };
  }

  async file(serial, { name, contentBase64, install = false }) {
    if (typeof name !== 'string' || !name || name === '.' || name === '..' ||
        Buffer.byteLength(name, 'utf8') > 240 || /[\\/\p{C}]/u.test(name)) {
      throw new Error('Invalid upload name');
    }
    if (typeof contentBase64 !== 'string' || contentBase64.length > 70_000_000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(contentBase64)) throw new Error('Invalid upload data');
    const data = Buffer.from(contentBase64, 'base64');
    if (data.length === 0 || data.length > 50 * 1024 * 1024) throw new Error('Upload must be 1 byte–50 MiB');
    if (install && !/\.(apk|apks|zip)$/i.test(name)) throw new Error(agentMessage('apps.invalidSet'));
    await this.connect(serial);
    const directory = await mkdtemp(path.join(os.tmpdir(), 'rdf-upload-'));
    const local = path.join(directory, name);
    try {
      await writeFile(local, data, { mode: 0o600 });
      if (install && !/\.apk$/i.test(name)) return await installApkSet(this, serial, { name, local, directory }, this.execute);
      const remote = `/sdcard/Download/${name}`;
      const result = await this.run(serial, install ? ['install', '-r', local] : ['push', local, remote], { timeoutMs: 120000 });
      if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout || 'File transfer failed');
      return { path: install ? null : remote, installed: Boolean(install), output: result.stdout };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}
