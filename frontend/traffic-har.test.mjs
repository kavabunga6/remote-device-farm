import test from 'node:test';
import assert from 'node:assert/strict';
import { trafficHar } from '../shared/traffic-har.mjs';
const row = extra => ({ id: 1, method: 'GET', url: 'http://example.test/api?token=%5Bredacted%5D', startedAt: 1,
  status: 200, statusSource: 'upstream', outcome: 'complete', durationMs: 10, elapsedMs: 10, bytes: 8, bytesSent: 3, bytesReceived: 5,
  requestHeaders: [], responseHeaders: [], timings: { connect: 1, send: 2, wait: 3, receive: 4 }, ...extra });
test('HAR preserves measured phases and distinguishes a failed transfer after HTTP 200', () => {
  const result = trafficHar({ entries: [row({ outcome: 'error', errorKind: 'incomplete', errorPhase: 'receive' })] }).log.entries[0];
  assert.equal(result.time, 10);
  assert.deepEqual(result.timings, { connect: 1, send: 2, wait: 3, receive: 4 });
  assert.equal(result.response.status, 200);
  assert.equal(result._error, 'incomplete');
  assert.equal(result._statusSource, 'upstream');
  assert.equal(result._incomplete, true);
  assert.equal(result.response.bodySize, 5);
  assert.equal(result.request.bodySize, 3);
});
test('encrypted tunnel transfer is never represented as an HTTP response body', () => {
  const result = trafficHar({ entries: [row({ method: 'CONNECT', outcome: 'open', statusSource: 'proxy', durationMs: null, elapsedMs: 2000 })] }).log.entries[0];
  assert.equal(result._encrypted, true);
  assert.equal(result.response.content.size, 0);
  assert.equal(result.response.bodySize, -1);
  assert.equal(result._tunnel.elapsedMs, 2000);
  assert.equal(result._tunnel.bytesSent, 3);
  assert.equal(result.time, 1);
  assert.equal(result._incomplete, true);
});
test('unknown phases remain explicitly unmeasured, and optional previews retain truncation flags', () => {
  const result = trafficHar({ entries: [row({ timings: undefined, responseBody: { text: 'partial', capturedBytes: 7, truncated: true } })] }, { unmeasured: 'not measured' }).log.entries[0];
  assert.equal(result.time, 0);
  assert.equal(result._elapsedMs, 10);
  assert.equal(result._timingsMeasured, false);
  assert.equal(result.comment, 'not measured');
  assert.equal(result.response.content.text, 'partial');
  assert.equal(result.response.content._previewTruncated, true);
});
test('compressed transferred bytes do not invent an uncompressed size', () => {
  const result = trafficHar({ entries: [row({ responseHeaders: [{ name: 'content-encoding', value: 'gzip' }] })] }).log.entries[0];
  assert.equal(result.response.content._sizeKnown, false);
  assert.equal(result.response.content.size, 0);
  assert.equal(result.response.content._transferredBodyBytes, 5);
});
