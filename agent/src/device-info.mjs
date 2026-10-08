// Facts about the running emulator that testers and developers usually ask for.
// The script is a constant: no user input reaches the device shell.

export const DEVICE_INFO_SCRIPT = [
  "echo '##props'; getprop",
  "echo '##wm'; wm size; wm density",
  "echo '##uptime'; cat /proc/uptime",
  "echo '##mem'; grep -E '^(MemTotal|MemAvailable):' /proc/meminfo",
  "echo '##df'; df -k /data | tail -n 1",
  "echo '##battery'; dumpsys battery | grep -E '^ *(level|status|AC powered|USB powered):'",
  "echo '##ip'; ip -4 -o addr show 2>/dev/null",
  "echo '##id'; id",
  "echo '##kernel'; uname -r",
  "echo '##pkgs'; pm list packages -3 --show-versioncode 2>/dev/null",
  "echo '##chrome'; dumpsys package com.android.chrome 2>/dev/null | grep -m1 versionName",
].join('; ');

const BATTERY_STATUS = { 1: 'unknown', 2: 'charging', 3: 'discharging', 4: 'not charging', 5: 'full' };

function sections(text) {
  const result = {};
  let name = null;
  for (const line of String(text).split(/\r?\n/)) {
    const header = /^##(\w+)$/.exec(line);
    if (header) { name = header[1]; result[name] = []; continue; }
    if (name && line.trim()) result[name].push(line);
  }
  return result;
}

function properties(lines = []) {
  const props = {};
  for (const line of lines) {
    const match = /^\[([^\]]+)\]: \[(.*)\]$/.exec(line);
    if (match) props[match[1]] = match[2];
  }
  return props;
}

function size(value) {
  const match = /(\d+)x(\d+)/.exec(value || '');
  return match ? { width: Number(match[1]), height: Number(match[2]) } : null;
}

function number(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function parseDeviceInfo(text, now = new Date()) {
  const s = sections(text);
  const p = properties(s.props);
  const wm = s.wm || [];
  const wmValue = (label) => wm.find((line) => line.startsWith(label + ':'))?.split(':')[1]?.trim();
  const abis = (p['ro.product.cpu.abilist'] || p['ro.product.cpu.abi'] || '').split(',').filter(Boolean);
  const gles = number(p['ro.opengles.version']);
  const mem = Object.fromEntries((s.mem || []).map((line) => {
    const [key, value] = line.split(':');
    return [key, number(String(value).trim().split(/\s+/)[0])];
  }));
  const df = (s.df?.[0] || '').trim().split(/\s+/);
  const uid = /uid=(\d+)/.exec(s.id?.[0] || '')?.[1];
  const battery = {};
  for (const line of s.battery || []) {
    const [key, value] = line.split(':').map((part) => part.trim());
    if (key === 'level') battery.level = number(value);
    if (key === 'status') battery.status = BATTERY_STATUS[Number(value)] || 'unknown';
    if (key === 'AC powered') battery.acPowered = value === 'true';
    if (key === 'USB powered') battery.usbPowered = value === 'true';
  }
  const addresses = (s.ip || []).map((line) => {
    const match = /^\d+:\s+(\S+)\s+inet\s+([\d.]+)\/(\d+)/.exec(line);
    return match ? { interface: match[1], address: match[2] } : null;
  }).filter((item) => item && item.interface !== 'lo');
  const apps = (s.pkgs || []).map((line) => {
    const match = /^package:(\S+)\s+versionCode:(\d+)/.exec(line) || /^package:(\S+)/.exec(line);
    return match ? { package: match[1], versionCode: match[2] ? Number(match[2]) : null } : null;
  }).filter(Boolean).sort((a, b) => a.package.localeCompare(b.package));
  const sdk = number(p['ro.build.version.sdk']);
  return {
    collectedAt: now.toISOString(),
    device: {
      manufacturer: p['ro.product.manufacturer'] || null, brand: p['ro.product.brand'] || null,
      model: p['ro.product.model'] || null, name: p['ro.product.name'] || null,
      codename: p['ro.product.device'] || null, hardware: p['ro.hardware'] || null,
      board: p['ro.product.board'] || null, abi: abis[0] || null, abis,
      serial: p['ro.serialno'] || p['ro.boot.serialno'] || null,
    },
    android: {
      release: p['ro.build.version.release'] || null, sdk,
      securityPatch: p['ro.build.version.security_patch'] || null,
      buildId: p['ro.build.id'] || null, incremental: p['ro.build.version.incremental'] || null,
      buildType: p['ro.build.type'] || null, tags: p['ro.build.tags'] || null,
      fingerprint: p['ro.build.fingerprint'] || null,
      debuggable: p['ro.debuggable'] === '1', rooted: uid === '0',
    },
    display: {
      physical: size(wmValue('Physical size')), override: size(wmValue('Override size')),
      density: number(wmValue('Physical density')), overrideDensity: number(wmValue('Override density')),
    },
    system: {
      kernel: s.kernel?.[0]?.trim() || null,
      uptimeSeconds: number((s.uptime?.[0] || '').split(' ')[0]),
      timezone: p['persist.sys.timezone'] || null,
      locale: p['persist.sys.locale'] || (p['ro.product.locale'] || null),
    },
    memory: { totalKb: mem.MemTotal ?? null, availableKb: mem.MemAvailable ?? null },
    storage: df.length >= 4 ? { totalKb: number(df[1]), usedKb: number(df[2]), availableKb: number(df[3]) } : null,
    battery: Object.keys(battery).length ? battery : null,
    network: { addresses },
    graphics: {
      openGl: gles == null ? null : `${gles >> 16}.${gles & 0xffff}`,
      egl: p['ro.hardware.egl'] || null, vulkan: p['ro.hardware.vulkan'] || null,
    },
    chrome: /versionName=(\S+)/.exec(s.chrome?.[0] || '')?.[1] || null,
    apps,
  };
}
