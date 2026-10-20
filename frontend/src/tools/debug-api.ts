import { apiRequest, jsonBody } from '../api';
export type TrafficEntry = { id: number; method: string; url: string; startedAt: number; status: number | null; durationMs: number | null; bytes: number; requestHeaders: { name: string; value: string }[]; responseHeaders: { name: string; value: string }[] };
export type TrafficState = { available: boolean; recording: boolean; proxyActive?: boolean; entries: TrafficEntry[]; pcapBytes?: number };
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
