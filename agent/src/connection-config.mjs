import { diagnostic } from './diagnostics.mjs';
import { agentIdForToken } from './generated/agent-identity.mjs';

export function agentIdentity(env) {
  return env.AGENT_ID || (env.AGENT_TOKEN ? agentIdForToken(env.AGENT_TOKEN) : undefined);
}

export function agentBrokerUrl(env) {
  if (!env.AGENT_SERVER_URL) return env.AGENT_BROKER_URL;
  try {
    const url = new URL(env.AGENT_SERVER_URL);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error();
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.pathname = '/agent/connect';
    if (env.AGENT_BROKER_URL && new URL(env.AGENT_BROKER_URL).href !== url.href) throw new Error();
    return url.href;
  } catch { throw new Error(diagnostic('connection.serverUrlInvalid')); }
}
