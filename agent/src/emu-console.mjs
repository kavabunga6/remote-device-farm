import { diagnostic } from './diagnostics.mjs';
// Console access stays inside the emulator container: Google images use internal port
// 5556; compatible images commonly use 5554. A protocol client consumes greeting,
// authentication and command replies separately, so a greeting OK is never success.
import { readFileSync } from 'node:fs';

export const EMU_UNAVAILABLE_PREFIX = 'emu-console-unavailable:';
export const NETWORK_SPEEDS = ['full', 'gsm', 'hscsd', 'gprs', 'edge', 'umts', 'hsdpa', 'lte', 'evdo'];
export const NETWORK_DELAYS = ['none', 'gprs', 'edge', 'umts'];

const NUM_RE = /^-?\d{1,5}(\.\d{1,8})?$/;
const MAX_OUTPUT_BYTES = 64 * 1024;
const CONSOLE_TIMEOUT_MS = 20_000;
// Exit code used when the console client or an internal listener is unavailable.
const EXIT_NO_CONSOLE = 69;

function bad(message) { throw new Error(message); }

function num(value, min, max, name) {
  if (typeof value !== 'string' || !NUM_RE.test(value)) bad(diagnostic('emu-console.0e68a3276b', { p0: name }));
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) bad(diagnostic('emu-console.0e68a3276b', { p0: name }));
}

// Strict allowlist of console command shapes. Returns a fresh copy of the arguments.
export function validateEmuConsoleArgs(args) {
  if (!Array.isArray(args) || args.length < 2 || args.length > 5 || args.some((a) => typeof a !== 'string')) {
    bad(diagnostic('emu-console.aca295d130'));
  }
  const [a, b, c, d, e] = args;
  const exact = (n) => { if (args.length !== n) bad(diagnostic('emu-console.aca295d130')); };
  if (a === 'network') {
    if (b === 'status') exact(2);
    else if (b === 'capture' && c === 'start' && d === 'rdf-capture.pcap') exact(4);
    else if (b === 'capture' && c === 'stop') exact(3);
    else if (b === 'speed' && NETWORK_SPEEDS.includes(c)) exact(3);
    else if (b === 'delay' && NETWORK_DELAYS.includes(c)) exact(3);
    else bad(diagnostic('emu-console.aca295d130'));
  } else if (a === 'geo' && b === 'fix') {
    if (args.length !== 4 && args.length !== 5) bad(diagnostic('emu-console.aca295d130'));
    num(c, -180, 180, 'longitude');
    num(d, -90, 90, 'latitude');
    if (e !== undefined) num(e, -1000, 10000, 'altitude');
  } else if (a === 'virtualscene-image' && b === 'wall') {
    if (args.length !== 2 && !(args.length === 3 && c === '/android-home/rdf-camera.png')) bad(diagnostic('emu-console.aca295d130'));
  } else if (a === 'automation' && b === 'play' && c === '/opt/android/emulator/resources/macros/Walk_to_image_room') exact(3);
  else bad(diagnostic('emu-console.aca295d130'));
  return [...args];
}

// Docker multiplexed stream: repeated [type, 0, 0, 0, size(uint32 BE)] + payload. 1 = stdout, 2 = stderr.
export function parseDockerStream(buffer, maxBytes = MAX_OUTPUT_BYTES) {
  const out = { stdout: [], stderr: [] };
  const used = { stdout: 0, stderr: 0 };
  let truncated = false;
  let pos = 0;
  while (pos < buffer.length) {
    if (pos + 8 > buffer.length) throw new Error(diagnostic('emu-console.654d51a035'));
    const type = buffer[pos];
    const size = buffer.readUInt32BE(pos + 4);
    if (type > 2 || buffer[pos + 1] || buffer[pos + 2] || buffer[pos + 3] ||
        size > buffer.length - pos - 8) throw new Error(diagnostic('emu-console.654d51a035'));
    const end = pos + 8 + size;
    const key = type === 2 ? 'stderr' : 'stdout';
    if (type !== 0) {
      const room = Math.max(0, maxBytes - used[key]);
      const chunk = buffer.subarray(pos + 8, end);
      if (chunk.length > room) truncated = true;
      out[key].push(chunk.subarray(0, room));
      used[key] += Math.min(chunk.length, room);
    }
    pos = end;
  }
  return {
    stdout: Buffer.concat(out.stdout).toString('utf8').replaceAll('\r', ''),
    stderr: Buffer.concat(out.stderr).toString('utf8').replaceAll('\r', ''),
    truncated,
  };
}

// Fixed script; only allowlisted commands and agent-owned connection limits enter its environment.
export const CONSOLE_SCRIPT = readFileSync(new URL('./emu-console-client.sh', import.meta.url), 'utf8');

export async function execInContainer(docker, containerId, cmd, env, timeoutMs, maxOutputBytes = MAX_OUTPUT_BYTES) {
  const deadline = Date.now() + timeoutMs;
  const left = () => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(diagnostic('emu-console.d393397714'));
    return remaining;
  };
  const created = await docker.request('POST', `/containers/${encodeURIComponent(containerId)}/exec`, {
    AttachStdout: true, AttachStderr: true, AttachStdin: false, Tty: false, Cmd: cmd, Env: env,
  }, { timeoutMs: left() });
  if (!created?.Id || !/^[a-f0-9]{8,128}$/i.test(String(created.Id))) throw new Error(diagnostic('emu-console.f9dff4d23d'));
  const raw = await docker.requestRaw('POST', `/exec/${created.Id}/start`, { Detach: false, Tty: false },
    { maxBytes: 4 * maxOutputBytes, timeoutMs: left() });
  const parsed = parseDockerStream(Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw ?? '')), maxOutputBytes);
  let exitCode = null;
  for (let i = 0; i < 10; i += 1) {
    const info = await docker.request('GET', `/exec/${created.Id}/json`, undefined, { timeoutMs: left() });
    if (info && !info.Running) { exitCode = Number.isInteger(info.ExitCode) ? info.ExitCode : null; break; }
    await new Promise((resolve) => setTimeout(resolve, Math.min(100, left())));
  }
  if (exitCode === null) throw new Error(diagnostic('emu-console.997eb029b3'));
  return { ...parsed, exitCode };
}

// No command is retried after it reaches a console, even when it returns KO or loses
// its connection. Replaying a geo fix after an ambiguous reply is unsafe.
export async function runEmuConsole(docker, containerId, args, { timeoutMs } = {}) {
  const valid = validateEmuConsoleArgs(args);
  timeoutMs ??= CONSOLE_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 3000 || timeoutMs > CONSOLE_TIMEOUT_MS) {
    throw new Error(diagnostic('emu-console.e5dd6dafad'));
  }
  const result = await execInContainer(docker, containerId, ['sh', '-c', CONSOLE_SCRIPT], [
    'EMU_CMD=' + valid.join(' '), 'EMU_CONSOLE_PORTS=5556 5554',
    // Let the in-container watchdog terminate before Docker's outer request deadline.
    'EMU_TIMEOUT_SECONDS=' + Math.max(1, Math.floor(timeoutMs / 1000) - 2),
  ], timeoutMs);
  if (result.exitCode === EXIT_NO_CONSOLE || result.exitCode === 126 || result.exitCode === 127) {
    throw new Error(EMU_UNAVAILABLE_PREFIX + ' ' + (result.stderr.trim() || 'No console client or listener in the emulator container').slice(0, 200));
  }
  if (result.exitCode === 124 || result.exitCode === 137) throw new Error(diagnostic('emu-console.d393397714'));
  if (result.truncated) throw new Error(diagnostic('emu-console.93af68a3a2'));
  if (result.exitCode === 0 && !/^OK$/m.test(result.stdout)) throw new Error(diagnostic('emu-console.fca0908ca2'));
  return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode, path: 'console' };
}
