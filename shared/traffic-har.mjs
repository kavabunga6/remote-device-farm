// Shared by browser snapshot exports and the authenticated HTTP endpoint.
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;

export function trafficHar(raw, notes = {}) {
  const rows = Array.isArray(raw.entries) ? raw.entries.slice(-200) : [];
  return { log: { version: '1.2', creator: { name: 'Remote Device Farm', version: '0.1.0' },
    _captureId: raw.captureId, _totalCaptured: raw.totalCaptured, _evicted: raw.evicted,
    entries: rows.map(item => {
      const tunnel = item.method === 'CONNECT';
      const measured = item.timings && typeof item.timings === 'object';
      const timings = Object.fromEntries(['connect', 'send', 'wait', 'receive'].map(key => [key,
        tunnel && key !== 'connect' ? 0 : finite(item.timings?.[key]) ?? 0]));
      const sent = finite(item.bytesSent), received = finite(item.bytesReceived);
      const responseBody = item.responseBody;
      const encoded = item.responseHeaders?.some(h => h.name.toLowerCase() === 'content-encoding' && h.value.toLowerCase() !== 'identity');
      const requestBody = item.requestBody;
      let queryString = [];
      try { queryString = [...new URL(item.url).searchParams].map(([name, value]) => ({ name, value })); } catch { /* Preserve the recorded URL. */ }
      const content = { size: tunnel || encoded ? 0 : received ?? finite(item.bytes) ?? 0,
        _sizeKnown: !tunnel && !encoded, _transferredBodyBytes: tunnel ? 0 : received ?? finite(item.bytes) ?? 0,
        mimeType: item.responseHeaders?.find(h => h.name.toLowerCase() === 'content-type')?.value ?? '',
        ...(typeof responseBody?.text === 'string' ? { text: responseBody.text, _previewTruncated: responseBody.truncated, _capturedBytes: responseBody.capturedBytes } : {}) };
      const outcome = item.outcome ?? 'unknown';
      return {
        startedDateTime: new Date(item.startedAt * 1000).toISOString(),
        time: Math.round(Object.values(timings).reduce((sum, value) => sum + value, 0) * 1000) / 1000,
        request: { method: item.method, url: item.url, httpVersion: tunnel ? '' : 'HTTP/1.1',
          cookies: [], headers: item.requestHeaders ?? [], queryString, headersSize: -1, bodySize: tunnel ? -1 : sent ?? -1,
          ...(typeof requestBody?.text === 'string' ? { postData: { mimeType: requestBody.mimeType, text: requestBody.text, _previewTruncated: requestBody.truncated } } : {}) },
        response: { status: item.status ?? 0, statusText: '', httpVersion: tunnel ? '' : 'HTTP/1.1',
          cookies: [], headers: item.responseHeaders ?? [], content, redirectURL: '', headersSize: -1,
          bodySize: tunnel ? -1 : received ?? finite(item.bytes) ?? -1 },
        cache: {}, timings,
        ...(tunnel ? { comment: notes.tunnel, _tunnel: { durationMs: item.durationMs, elapsedMs: item.elapsedMs, bytesSent: sent, bytesReceived: received } }
          : !measured ? { comment: notes.unmeasured } : {}),
        _encrypted: tunnel, _outcome: outcome, _phase: item.phase, _statusSource: item.statusSource,
        _error: item.errorKind ?? null, _errorPhase: item.errorPhase ?? null,
        _incomplete: outcome !== 'complete', _timingsMeasured: Boolean(measured),
        _elapsedMs: item.elapsedMs ?? item.durationMs ?? null,
      };
    }) } };
}
