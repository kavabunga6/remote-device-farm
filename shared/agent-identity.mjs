import { createHash } from 'node:crypto';

/** Stable, non-secret node identity for credentials issued without an explicit ID. */
export function agentIdForToken(token) {
  return 'node-' + createHash('sha256').update(token).digest('hex').slice(0, 24);
}
