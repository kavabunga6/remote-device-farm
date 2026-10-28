import { diagnostic } from './diagnostics.mjs';
import { isIP } from 'node:net';

export function loadRtcConfig(env = process.env) {
  const enabled = env.AGENT_WEBRTC_ENABLED === '1';
  const min = Number(env.AGENT_WEBRTC_PORT_MIN || 50000);
  const max = Number(env.AGENT_WEBRTC_PORT_MAX || 50100);
  if (![min, max].every(p => Number.isInteger(p) && p >= 1024 && p <= 65535) || min >= max) {
    throw new Error(diagnostic('rtc-config.cb00aae66d'));
  }
  const addresses = (env.AGENT_WEBRTC_HOST_IP || '').split(',').map(s => s.trim()).filter(Boolean);
  if (addresses.some(ip => !isIP(ip))) throw new Error(diagnostic('rtc-config.d5b54494e9'));
  let iceServers;
  try { iceServers = JSON.parse(env.AGENT_WEBRTC_ICE_SERVERS || '[]'); }
  catch { throw new Error(diagnostic('rtc-config.4482a5aa83')); }
  if (!Array.isArray(iceServers) || iceServers.length > 8) throw new Error(diagnostic('rtc-config.86c7391a9d'));
  iceServers = iceServers.map(server => {
    if (!server || typeof server !== 'object') throw new Error(diagnostic('rtc-config.a2ec66221c'));
    const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
    if (!urls.length || urls.length > 8 || urls.some(url => typeof url !== 'string' || url.length > 512 ||
        !/^(stun|stuns|turn|turns):[^\s]+$/.test(url))) throw new Error(diagnostic('rtc-config.41d5f2cf29'));
    for (const field of ['username', 'credential']) {
      if (server[field] !== undefined && (typeof server[field] !== 'string' || server[field].length > 512)) throw new Error(diagnostic('rtc-config.bfcd1dcd13'));
    }
    return { urls, ...(server.username === undefined ? {} : { username: server.username }),
      ...(server.credential === undefined ? {} : { credential: server.credential }) };
  });
  return { enabled, iceServers, icePortRange: [min, max], addresses };
}
