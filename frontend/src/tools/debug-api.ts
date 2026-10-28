import { apiRequest, jsonBody } from '../api';
export type TrafficBody = { text: string | null; mimeType: string; truncated: boolean; reason: 'disabled' | 'encoded' | 'binary' | null; capturedBytes: number; limit: number };
export type TrafficEntry = {
  id: number; captureId?: string; method: string; url: string; startedAt: number;
  status: number | null; statusSource?: 'proxy' | 'upstream' | null;
  outcome?: 'pending' | 'open' | 'complete' | 'error' | 'stopped'; phase?: 'connect' | 'send' | 'wait' | 'receive' | 'tunnel' | 'done';
  errorKind?: 'dns' | 'timeout' | 'refused' | 'incomplete' | 'reset' | 'protocol' | 'io' | null; errorPhase?: string | null;
  durationMs: number | null; elapsedMs?: number; bytes: number; bytesSent?: number; bytesReceived?: number;
  timings?: { connect: number; send: number; wait: number; receive: number };
  requestHeaders: { name: string; value: string }[]; responseHeaders: { name: string; value: string }[];
  requestBody?: TrafficBody; responseBody?: TrafficBody;
};
export type TrafficState = {
  available: boolean; recording: boolean; proxyActive?: boolean; entries: TrafficEntry[]; protocolVersion?: number; runtimeCompatible?: boolean;
  captureId?: string | null; startedAt?: number | null; stoppedAt?: number | null;
  stopReason?: 'manual' | 'time_limit' | 'size_limit' | 'recovery' | 'start_failed' | null;
  finalizing?: boolean; captureBodies?: boolean; pcapRequested?: boolean; pcapAvailable?: boolean; packetCount?: number;
  pcapState?: 'none' | 'starting' | 'recording' | 'finalizing' | 'stopped' | 'error'; pcapBytes?: number;
  limit?: number; totalCaptured?: number; evicted?: number; rejectedConnections?: number; activeConnections?: number; connectionLimit?: number;
};

export const debugApi = <T,>(sessionId: string, feature: 'network-inspector' | 'webviews', params?: object, signal?: AbortSignal): Promise<T> =>
  feature === 'network-inspector'
    ? params ? apiRequest<T>(`/sessions/${encodeURIComponent(sessionId)}/network-inspector`, { method: 'POST', body: jsonBody(params), signal })
      : apiRequest<T>(`/sessions/${encodeURIComponent(sessionId)}/network-inspector`, { signal })
    : params ? apiRequest<T>(`/sessions/${encodeURIComponent(sessionId)}/webviews`, { method: 'POST', body: jsonBody(params), signal })
      : apiRequest<T>(`/sessions/${encodeURIComponent(sessionId)}/webviews`, { signal });
export function downloadDebug(name: string, data: BlobPart[], type: string) {
  const url = URL.createObjectURL(new Blob(data, { type }));
  const link = document.createElement('a'); link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
