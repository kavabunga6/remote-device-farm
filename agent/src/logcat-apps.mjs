import { diagnostic } from './diagnostics.mjs';
import { agentMessage } from './messages.mjs';
// Only identifiers from Android's package manager reach fixed ADB arguments.
export const PACKAGE_NAME = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+$/;
export function validatePackageName(value) {
  if (typeof value !== 'string' || value.length > 255 || !PACKAGE_NAME.test(value)) throw new Error(diagnostic('logcat-apps.c0e311d59d'));
  return value;
}
export function parseLogcatApps(text) {
  const packages = new Map();
  for (const line of String(text).split(/\r?\n/)) {
    const match = /^package:(\S+)\s+uid:(\d+)\s*$/.exec(line.trim());
    if (!match || !PACKAGE_NAME.test(match[1]) || match[1].length > 255) continue;
    const uid = Number(match[2]);
    if (!Number.isSafeInteger(uid) || uid < 0 || uid > 2147483647) continue;
    packages.set(match[1], { packageName: match[1], uid });
  }
  return [...packages.values()].sort((a, b) => a.packageName.localeCompare(b.packageName));
}
export function parseAppPids(text, uidTokens) {
  const pids = new Set();
  for (const line of String(text).split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\S+)\s+\S+\s*$/.exec(line);
    if (match && uidTokens.has(match[2])) {
      const pid = Number(match[1]);
      if (Number.isSafeInteger(pid) && pid > 0 && pid <= 2147483647) pids.add(pid);
    }
  }
  return [...pids].sort((a, b) => a - b);
}

// Android 11 supports the uid output modifier, but not logcat --uid.
// Keep the global log cursor before filtering so identical timestamps cannot duplicate entries.
export function parseUidLogcat(text) {
  const entries = [];
  const linePattern = /^(\d\d-\d\d \d\d:\d\d:\d\d\.\d{3})\s+(\S+)\s+(\d+)\s+(\d+)\s+([VDIWEFA])\s+(.+?)\s*: ?(.*)$/;
  for (const raw of String(text).split(/\r?\n/)) {
    if (!raw || raw.startsWith('--------- ')) continue;
    const match = linePattern.exec(raw);
    if (match) entries.push({ ts: match[1], uid: match[2], pid: Number(match[3]), tid: Number(match[4]), level: match[5] === 'A' ? 'F' : match[5], tag: match[6], message: match[7] });
    else if (/^\d\d-\d\d \d\d:\d\d:\d\d\.\d{3}\s+\d+\s+\d+\s+[VDIWEFA]\s/.test(raw)) throw new Error(agentMessage('agent.apps.uidUnavailable', {}, 'ru'));
    else if (entries.length) entries[entries.length - 1].message += '\n' + raw;
  }
  return entries;
}
export function appUidTokens(uid, name = '') {
  const tokens = new Set([String(uid)]);
  const appId = uid % 100000;
  if (appId >= 10000 && appId <= 19999) tokens.add('u' + Math.floor(uid / 100000) + '_a' + (appId - 10000));
  if (/^[A-Za-z_][A-Za-z0-9_]{0,4}$/.test(name)) tokens.add(name);
  return tokens;
}
