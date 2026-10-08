import assert from 'node:assert/strict';
import test from 'node:test';
import { countRequest, escapeLabelValue, histogramFamily, renderMetrics, resetHttpCounters, httpFamilies, statusClass, tokenMatches } from '../src/metrics.js';

test('label values are escaped', () => {
  assert.equal(escapeLabelValue('a"b\\c\nd'), 'a\\"b\\\\c\\nd');
  const text = renderMetrics([{ name: 'x', help: 'line\nbreak', type: 'gauge', samples: [{ name: 'x', labels: { host: 'h"1' }, value: 3 }] }]);
  assert.equal(text, '# HELP x line\\nbreak\n# TYPE x gauge\nx{host="h\\"1"} 3\n');
});

test('histogram buckets are cumulative with +Inf, sum and count', () => {
  const family = histogramFamily('d', 'help', [30, 60, 100, 4000], [60, 300]);
  const lines = renderMetrics([family]).trim().split('\n');
  assert.deepEqual(lines.slice(2), ['d_bucket{le="60"} 2', 'd_bucket{le="300"} 3', 'd_bucket{le="+Inf"} 4', 'd_sum 4190', 'd_count 4']);
  assert.equal(family.type, 'histogram');
});

test('empty histogram still renders zeros', () => {
  assert.match(renderMetrics([histogramFamily('d', 'h', [], [60])]), /d_bucket\{le="\+Inf"\} 0\nd_sum 0\nd_count 0\n/);
});

test('http counters keep labels bounded and count login failures', () => {
  resetHttpCounters();
  countRequest('GET', 200, '/api/x');
  countRequest('GET', 204, '/api/y');
  countRequest('BREW', 418, '/z');
  countRequest('POST', 401, '/api/login');
  assert.equal(statusClass(503), '5xx');
  assert.equal(statusClass(0), 'other');
  const text = renderMetrics(httpFamilies());
  assert.match(text, /rdf_http_requests_total\{method="GET",status_class="2xx"\} 2/);
  assert.match(text, /rdf_http_requests_total\{method="OTHER",status_class="4xx"\} 1/);
  assert.match(text, /rdf_login_failures_total 1/);
  resetHttpCounters();
});

test('bearer token compare accepts only the exact token', () => {
  assert.equal(tokenMatches('Bearer secret-token-123456', 'secret-token-123456'), true);
  assert.equal(tokenMatches('Bearer secret-token-12345', 'secret-token-123456'), false);
  assert.equal(tokenMatches('secret-token-123456', 'secret-token-123456'), false);
  assert.equal(tokenMatches(undefined, 'secret-token-123456'), false);
});
