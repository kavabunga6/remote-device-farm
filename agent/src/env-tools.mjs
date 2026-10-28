import { diagnostic } from './diagnostics.mjs';
import { agentMessage } from './messages.mjs';
// Emulator environment tools. The server sends {op, params}; every value is validated here and turned
// into a fixed adb argv. There is no raw shell passthrough: user data only ever appears as a single,
// quoted argument of a fixed command template.

import { EMU_UNAVAILABLE_PREFIX, NETWORK_DELAYS, NETWORK_SPEEDS } from './emu-console.mjs';

// Friendly profiles map to a (speed, delay) pair of the emulator console.
export const NETWORK_PROFILES = {
  full: ['full', 'none'],
  lte: ['lte', 'none'],
  '4g': ['lte', 'none'],
  '3g': ['hsdpa', 'umts'],
  '3g-slow': ['umts', 'umts'],
  '2g': ['gprs', 'gprs'],
  edge: ['edge', 'edge'],
  gsm: ['gsm', 'gprs'],
};

const PACKAGE_RE = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/;
const SCHEME_RE = /^[a-z][a-z0-9+.-]{1,30}$/;
// Characters allowed after the scheme. Quotes, whitespace, backticks, $, \, ;, |, <, >, (, ), {, }, *, ^ are out.
const URI_BODY_RE = /^[A-Za-z0-9\-._~:/?#@!&+,=%]+$/;
const BLOCKED_SCHEMES = new Set(['javascript', 'file', 'content', 'intent', 'data', 'vbscript']);

export const TIME_ZONES = [
  'UTC', 'Europe/London', 'Europe/Dublin', 'Europe/Lisbon', 'Europe/Paris', 'Europe/Berlin', 'Europe/Madrid', 'Europe/Rome',
  'Europe/Amsterdam', 'Europe/Warsaw', 'Europe/Kyiv', 'Europe/Kaliningrad', 'Europe/Istanbul', 'Europe/Moscow', 'Europe/Samara',
  'Asia/Dubai', 'Asia/Tehran', 'Asia/Karachi', 'Asia/Tashkent', 'Asia/Yekaterinburg', 'Asia/Kolkata', 'Asia/Almaty', 'Asia/Bangkok',
  'Asia/Novosibirsk', 'Asia/Krasnoyarsk', 'Asia/Shanghai', 'Asia/Hong_Kong', 'Asia/Singapore', 'Asia/Irkutsk', 'Asia/Tokyo',
  'Asia/Seoul', 'Asia/Yakutsk', 'Asia/Vladivostok', 'Asia/Jerusalem', 'Africa/Cairo', 'Africa/Lagos', 'Africa/Johannesburg',
  'Africa/Nairobi', 'Australia/Sydney', 'Australia/Perth', 'Pacific/Auckland', 'Pacific/Honolulu', 'America/Anchorage',
  'America/Los_Angeles', 'America/Denver', 'America/Chicago', 'America/New_York', 'America/Toronto', 'America/Halifax',
  'America/Mexico_City', 'America/Bogota', 'America/Lima', 'America/Sao_Paulo', 'America/Argentina/Buenos_Aires',
];
const TIME_ZONE_SET = new Set(TIME_ZONES);

function fail(message) { throw new Error(message); }

function plainObject(value) {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) fail(diagnostic('env-tools.e20204115c'));
  return value;
}

function only(params, allowed) {
  for (const key of Object.keys(params)) if (!allowed.includes(key)) fail(diagnostic('env-tools.a042fd8713', { p0: key.slice(0, 40) }));
}

function oneOf(value, list, name) {
  if (typeof value !== 'string' || !list.includes(value)) fail(diagnostic('env-tools.0e68a3276b', { p0: name }));
  return value;
}

function boolean(value, name) {
  if (typeof value !== 'boolean') fail(name + ' must be boolean');
  return value;
}

function number(value, min, max, name, { integer = false } = {}) {
  const n = typeof value === 'string' && /^-?\d{1,6}(\.\d{1,8})?$/.test(value) ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n))) {
    fail(diagnostic('env-tools.1d82373cb6', { p0: name + ' must be between ', p1: min, p2: max }));
  }
  return n;
}

function trimNumber(n, digits) { return String(Number(n.toFixed(digits))); }

export function validPackage(value, name = 'package') {
  if (typeof value !== 'string' || value.length > 255 || !PACKAGE_RE.test(value)) fail(diagnostic('env-tools.21a817dea2', { p0: name }));
  return value;
}

export function validDeepLink(value) {
  if (typeof value !== 'string' || value.length > 2000) fail(diagnostic('env-tools.ae247db41c'));
  const colon = value.indexOf(':');
  const scheme = colon > 0 ? value.slice(0, colon) : '';
  if (!SCHEME_RE.test(scheme) && !['http', 'https'].includes(scheme)) fail(diagnostic('env-tools.006b7b34cc'));
  if (BLOCKED_SCHEMES.has(scheme)) fail(diagnostic('env-tools.0a55cca8c4'));
  const rest = value.slice(colon + 1);
  if (!rest || !URI_BODY_RE.test(rest)) fail(diagnostic('env-tools.4c95830244'));
  if (['http', 'https'].includes(scheme) && !rest.startsWith('//')) fail(diagnostic('env-tools.8a21e20588'));
  return value;
}

// `adb shell` joins its arguments and the device shell parses them again, so quote anything unusual.
export function quoteDevice(arg) {
  if (/^[A-Za-z0-9_.:/@%+=,-]+$/.test(arg)) return arg;
  return "'" + arg.replaceAll("'", "'\\''") + "'";
}

const shell = (...args) => ({ kind: 'shell', argv: ['shell', ...args.map((a) => quoteDevice(String(a)))] });
const emu = (...args) => ({ kind: 'emu', argv: ['emu', ...args.map(String)] });
const flag = (on) => (on ? '1' : '0');

// System settings are per Android user. Explicitly target the foreground user
// for both updates and readback, independently of the shell command default.
const setting = (action, namespace, key, value) => shell('settings',
  ...(namespace === 'system' ? ['--user', 'current'] : []), action, namespace, key,
  ...(value === undefined ? [] : [value]));

function settingsPlan(namespace, values) {
  return {
    steps: values.map(([key, value]) => setting('put', namespace, key, value)),
    verify: values.map(([key, value]) => ({ step: setting('get', namespace, key), key, value: Number(value) })),
  };
}

// Returns { steps, verify? }. Each step is { kind: 'shell'|'emu', argv }.
export function buildEnvOp(op, rawParams) {
  const p = plainObject(rawParams);
  switch (op) {
    case 'network': {
      only(p, ['profile', 'speed', 'delay']);
      if (p.profile !== undefined) {
        if (p.speed !== undefined || p.delay !== undefined) fail(diagnostic('env-tools.1dc12cbd9f'));
        if (typeof p.profile !== 'string' || !Object.hasOwn(NETWORK_PROFILES, p.profile)) fail(diagnostic('env-tools.8db2b91976'));
        const [speed, delay] = NETWORK_PROFILES[p.profile];
        return { steps: [emu('network', 'speed', speed), emu('network', 'delay', delay)] };
      }
      const speed = oneOf(p.speed, NETWORK_SPEEDS, 'speed');
      const delay = oneOf(p.delay ?? 'none', NETWORK_DELAYS, 'delay');
      return { steps: [emu('network', 'speed', speed), emu('network', 'delay', delay)] };
    }
    case 'proxy': {
      only(p, ['host', 'port', 'reset']);
      let value;
      if (p.reset !== undefined) {
        if (boolean(p.reset, 'reset') !== true || p.host !== undefined || p.port !== undefined) fail(diagnostic('env-tools.9f007330a5'));
        value = ':0';
      } else {
        const host = p.host;
        if (typeof host !== 'string' || host.length > 253 || host !== host.trim() ||
            !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/.test(host)) {
          fail(diagnostic('env-tools.0c0e4b332b'));
        }
        value = host.toLowerCase() + ':' + number(p.port, 1, 65535, 'port', { integer: true });
      }
      return { steps: [setting('put', 'global', 'http_proxy', value)],
        verify: [{ step: setting('get', 'global', 'http_proxy'), key: 'http_proxy', value }] };
    }
    case 'geo': {
      only(p, ['lat', 'lon', 'alt']);
      const lat = number(p.lat, -90, 90, 'lat');
      const lon = number(p.lon, -180, 180, 'lon');
      const steps = [emu('geo', 'fix', trimNumber(lon, 6), trimNumber(lat, 6))];
      if (p.alt !== undefined) steps[0].argv.push(trimNumber(number(p.alt, -1000, 10000, 'alt'), 1));
      return { steps };
    }
    case 'dark_mode': {
      only(p, ['mode']);
      return { steps: [shell('cmd', 'uimode', 'night', oneOf(p.mode, ['yes', 'no', 'auto'], 'mode'))] };
    }
    case 'font_scale': {
      only(p, ['scale']);
      return settingsPlan('system', [['font_scale', trimNumber(number(p.scale, 0.85, 2.0, 'scale'), 2)]]);
    }
    case 'display_size': {
      only(p, ['reset', 'width', 'height']);
      if (p.reset !== undefined) {
        if (boolean(p.reset, 'reset') !== true || p.width !== undefined || p.height !== undefined) fail(diagnostic('env-tools.700973f5d6'));
        return { steps: [shell('wm', 'size', 'reset')] };
      }
      const w = number(p.width, 320, 4096, 'width', { integer: true });
      const h = number(p.height, 320, 4096, 'height', { integer: true });
      return { steps: [shell('wm', 'size', `${w}x${h}`)] };
    }
    case 'display_density': {
      only(p, ['reset', 'dpi']);
      if (p.reset !== undefined) {
        if (boolean(p.reset, 'reset') !== true || p.dpi !== undefined) fail(diagnostic('env-tools.caf185c401'));
        return { steps: [shell('wm', 'density', 'reset')] };
      }
      return { steps: [shell('wm', 'density', number(p.dpi, 120, 640, 'dpi', { integer: true }))] };
    }
    case 'animations': {
      only(p, ['enabled']);
      const v = flag(boolean(p.enabled, 'enabled'));
      return settingsPlan('global', ['window_animation_scale', 'transition_animation_scale', 'animator_duration_scale']
        .map((key) => [key, v]));
    }
    case 'show_touches':
      only(p, ['enabled']);
      return settingsPlan('system', [['show_touches', flag(boolean(p.enabled, 'enabled'))]]);
    case 'pointer_location':
      only(p, ['enabled']);
      return settingsPlan('system', [['pointer_location', flag(boolean(p.enabled, 'enabled'))]]);
    case 'battery': {
      only(p, ['reset', 'level', 'charging']);
      if (p.reset !== undefined) {
        if (boolean(p.reset, 'reset') !== true || p.level !== undefined || p.charging !== undefined) fail(diagnostic('env-tools.ee18babbd3'));
        return { steps: [shell('dumpsys', 'battery', 'reset')] };
      }
      if (p.level === undefined && p.charging === undefined) fail(diagnostic('env-tools.b007a45f1f'));
      const steps = [];
      if (p.level !== undefined) steps.push(shell('dumpsys', 'battery', 'set', 'level', number(p.level, 0, 100, 'level', { integer: true })));
      if (p.charging !== undefined) {
        const mode = oneOf(p.charging, ['ac', 'usb', 'none'], 'charging');
        steps.push(shell('dumpsys', 'battery', 'set', 'ac', flag(mode === 'ac')));
        steps.push(shell('dumpsys', 'battery', 'set', 'usb', flag(mode === 'usb')));
      }
      return { steps };
    }
    case 'timezone': {
      only(p, ['zone']);
      if (typeof p.zone !== 'string' || !TIME_ZONE_SET.has(p.zone)) fail(diagnostic('env-tools.7b84616a1d'));
      return { steps: [shell('cmd', 'alarm', 'set-timezone', p.zone)] };
    }
    case 'deeplink': {
      only(p, ['uri']);
      return { steps: [shell('am', 'start', '-a', 'android.intent.action.VIEW', '-d', validDeepLink(p.uri))] };
    }
    case 'app_clear':
      only(p, ['package']);
      return { steps: [shell('pm', 'clear', validPackage(p.package))] };
    case 'app_stop':
      only(p, ['package']);
      return { steps: [shell('am', 'force-stop', validPackage(p.package))] };
    case 'app_grant':
    case 'app_revoke': {
      only(p, ['package', 'permission']);
      const pkg = validPackage(p.package);
      const permission = validPackage(p.permission, 'permission');
      return { steps: [shell('pm', op === 'app_grant' ? 'grant' : 'revoke', pkg, permission)] };
    }
    default: fail(diagnostic('env-tools.934817024c'));
  }
}

// Fixed read-only script: no user input is interpolated.
export const ENV_READ_SCRIPT = [
  'echo night=$(cmd uimode night)',
  'echo font=$(settings --user current get system font_scale)',
  'echo wa=$(settings get global window_animation_scale)',
  'echo ta=$(settings get global transition_animation_scale)',
  'echo da=$(settings get global animator_duration_scale)',
  'echo touches=$(settings --user current get system show_touches)',
  'echo pointer=$(settings --user current get system pointer_location)',
  'echo tz=$(getprop persist.sys.timezone)',
  'echo proxy=$(settings get global http_proxy)',
  'wm size', 'wm density', 'dumpsys battery',
].join('; ');

export function parseProxyState(raw) {
  if (raw === undefined) return null;
  if (['', 'null', ':0', ':-1'].includes(raw)) return { enabled: false, host: '', port: 0 };
  const match = /^([A-Za-z0-9.-]+):(\d{1,5})$/.exec(raw);
  if (!match || Number(match[2]) < 1 || Number(match[2]) > 65535) return null;
  return { enabled: true, host: match[1], port: Number(match[2]) };
}

export function parseEnvState(stdout) {
  const text = String(stdout);
  const value = (re) => re.exec(text)?.[1]?.trim();
  const night = value(/^night=.*?(yes|no|auto)\s*$/im);
  const num = (key) => {
    const raw = value(new RegExp('^' + key + '=([0-9.]+)\\s*$', 'm'));
    return raw === undefined || !Number.isFinite(Number(raw)) ? null : Number(raw);
  };
  const wa = num('wa'); const ta = num('ta'); const da = num('da');
  const physSize = value(/Physical size:\s*(\d+x\d+)/);
  const overSize = value(/Override size:\s*(\d+x\d+)/);
  const physDpi = Number(value(/Physical density:\s*(\d+)/));
  const overDpi = Number(value(/Override density:\s*(\d+)/));
  const level = Number(value(/^\s*level:\s*(\d+)/m));
  const ac = value(/AC powered:\s*(true|false)/);
  const usb = value(/USB powered:\s*(true|false)/);
  const tz = value(/^tz=([A-Za-z0-9_/+-]{1,64})\s*$/m);
  return {
    proxy: parseProxyState(value(/^proxy=(.*)$/m)),
    darkMode: night ?? null,
    fontScale: num('font'),
    animations: wa === null && ta === null && da === null ? null : [wa, ta, da].every((x) => x === 0) ? false : true,
    showTouches: num('touches') === null ? null : num('touches') === 1,
    pointerLocation: num('pointer') === null ? null : num('pointer') === 1,
    timezone: tz ?? null,
    size: physSize ? { physical: physSize, override: overSize ?? null } : null,
    density: Number.isFinite(physDpi) && physDpi > 0 ? { physical: physDpi, override: Number.isFinite(overDpi) && overDpi > 0 ? overDpi : null } : null,
    battery: Number.isFinite(level) && ac ? { level, charging: ac === 'true' ? 'ac' : usb === 'true' ? 'usb' : 'none' } : null,
  };
}

function consoleReply(result, fallback) {
  const out = String(result.stdout || '').replaceAll('\r', '').trim();
  const err = String(result.stderr || '').trim();
  const rejected = /^KO\b(?::[ \t]*|[ \t]+)?(.*)$/m.exec(out);
  if (rejected) throw new Error((rejected[1]?.trim() || err || fallback).slice(0, 240));
  if (result.exitCode !== 0) {
    // adb and emulator images may write connection errors to stdout, with an empty stderr.
    throw new Error((err || out || agentMessage('agent.console.exitCode', { p0: fallback, p1: result.exitCode }, 'ru')).slice(0, 240));
  }
  if (!/^OK\s*$/m.test(out)) throw new Error(agentMessage('agent.console.unconfirmed', {}, 'ru'));
}

function shellReply(result) {
  const stdout = String(result.stdout || '').trim();
  const stderr = String(result.stderr || '').trim();
  if (result.exitCode !== 0) throw new Error((stderr || stdout || 'Command failed').slice(0, 200));
  // Some Android shell services print their exception but still return exit status 0.
  const failure = /^(?:Error\b|Exception\b|Failure\b|Failed\b|java\.lang\.|android\.[\w.]*Exception\b|Security exception\b|Permission (?:denial|denied)\b).*$/mi.exec(stderr + '\n' + stdout);
  if (failure) throw new Error(failure[0].trim().slice(0, 200));
}

export const EMU_MODES = ['auto', 'control', 'adb'];

export class EnvTools {
  // `adb` is an AdbClient (connect/run). `control` is a ControlClient (emuConsole op); `emuMode` is
  // AGENT_EMU_CONSOLE: 'control' = only the control container, 'adb' = only `adb emu` (legacy, fails for
  // TCP serials), 'auto' = control first, adb only when the control exec path is unavailable.
  constructor(adb, { control = null, emuMode = 'auto' } = {}) {
    if (!EMU_MODES.includes(emuMode)) throw new Error(diagnostic('env-tools.b554dbae59'));
    this.adb = adb;
    this.control = control;
    this.emuMode = control ? emuMode : 'adb';
  }

  // Runs one `emu` step. ctx = { sessionId }. Returns { stdout, stderr, exitCode }.
  async runEmu(serial, argv, timeoutMs, ctx = {}) {
    if (this.emuMode !== 'adb' && ctx.sessionId) {
      try {
        const result = await this.control.emuConsole(ctx.sessionId, argv.slice(1));
        return { stdout: String(result?.stdout ?? ''), stderr: String(result?.stderr ?? ''), exitCode: Number(result?.exitCode ?? 1) };
      } catch (error) {
        const message = String(error?.message ?? error);
        // An older control container does not know the op; treat it like an unavailable exec path.
        const unavailable = message.startsWith(EMU_UNAVAILABLE_PREFIX) || /Invalid control operation|ENOENT|ECONNREFUSED/.test(message);
        if (this.emuMode === 'control' || !unavailable) {
          throw new Error(message.startsWith(EMU_UNAVAILABLE_PREFIX)
            ? diagnostic('env-tools.db0f1a6292', { p0: message.slice(EMU_UNAVAILABLE_PREFIX.length).trim() })
            : message);
        }
      }
    }
    return this.adb.run(serial, argv, { timeoutMs });
  }

  async read(serial) {
    await this.adb.connect(serial);
    const info = await this.adb.run(serial, ['shell', ENV_READ_SCRIPT], { timeoutMs: 20000 });
    if (info.exitCode !== 0 && !String(info.stdout).includes('night=')) throw new Error(diagnostic('env-tools.a089cd5a0f'));
    return parseEnvState(info.stdout);
  }

  async apply(serial, op, params, ctx) {
    const plan = buildEnvOp(op, params);
    await this.adb.connect(serial);
    const timeoutMs = 20000;
    for (const step of plan.steps) {
      const result = step.kind === 'emu'
        ? await this.runEmu(serial, step.argv, timeoutMs, ctx)
        : await this.adb.run(serial, step.argv, { timeoutMs });
      if (step.kind === 'emu') consoleReply(result, agentMessage('agent.console.failed', {}, 'ru'));
      else shellReply(result);
    }
    // A successful shell process does not prove that SettingsProvider accepted the
    // value. Confirm every animation scale separately before reporting success.
    for (const check of plan.verify || []) {
      const result = await this.adb.run(serial, check.step.argv, { timeoutMs });
      shellReply(result);
      const actual = String(result.stdout || '').trim();
      const confirmed = typeof check.value === 'number'
        ? /^\d+(?:\.\d+)?$/.test(actual) && Number(actual) === check.value : actual === check.value;
      if (!confirmed) {
        throw new Error(agentMessage('agent.settings.unconfirmed', { p0: check.key }, 'ru'));
      }
    }
    return { op, applied: true };
  }
}
