import { diagnostic } from './diagnostics.js';
import type WebSocket from 'ws';
const connections = new Map<string, Set<() => void>>();
export function registerAccessResource(userId: string, close: () => void): () => void {
 const set = connections.get(userId) ?? new Set<() => void>(); connections.set(userId, set); set.add(close);
 return () => { set.delete(close); if (!set.size && connections.get(userId) === set) connections.delete(userId); };
}
export function registerAccessConnection(userId: string, ws: WebSocket, beforeClose?: () => void): void {
 const unregister = registerAccessResource(userId, () => { beforeClose?.(); ws.close(4003, 'permissions changed'); ws.terminate(); });
 ws.once('close', unregister);
}
export function revokeAccessConnections(userIds: readonly string[]): void {
 for (const id of userIds) {
  const resources = [...(connections.get(id) ?? [])]; connections.delete(id);
  for (const close of resources) { try { close(); } catch { console.error(diagnostic('access-connections.4c86d65188')); } }
 }
}
