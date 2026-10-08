import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const entry = fileURLToPath(new URL('./src/logcat.ts', import.meta.url));
const bundle = await build({ entryPoints: [entry], bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent' });
const m = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].contents).toString('base64'));
const { buildMatcher, filterEntries, highlightParts, appendEntries, MAX_BUFFERED_ENTRIES } = m;

const mk = (level, tag, message, pid = 1) => ({ ts: '10-02 20:57:22.101', pid, tid: pid, level, tag, message });
const rows = [
  mk('I', 'ActivityManager', 'Start proc com.android.chrome', 10),
  mk('W', 'WifiService', 'rssi -61', 20),
  mk('E', 'AndroidRuntime', 'FATAL EXCEPTION: main', 30),
  mk('D', 'chromium', 'Network error code 7', 10),
];
const base = { query: '', regex: false, matchCase: false, minLevel: 'V', tag: null, pid: null };

test('minimum level keeps warnings and above', () => {
  const result = filterEntries(rows, { ...base, minLevel: 'W' }, buildMatcher('', false, false));
  assert.deepEqual(result.map(r => r.level), ['W', 'E']);
});

test('plain search is case-insensitive and treats special characters literally', () => {
  const m1 = buildMatcher('CHROME', false, false);
  assert.deepEqual(filterEntries(rows, { ...base, query: 'CHROME' }, m1).length, 1);
  const m2 = buildMatcher('(code)', false, false);
  assert.equal(m2.error, null);
  assert.equal(filterEntries(rows, base, buildMatcher('rssi -61', false, true)).length, 1);
  assert.equal(filterEntries(rows, base, buildMatcher('rssi -61', false, true)).length, 1);
});

test('regular expressions search tag and message and respect case sensitivity', () => {
  const m1 = buildMatcher('error code [0-9]+|FATAL', true, false);
  assert.deepEqual(filterEntries(rows, base, m1).map(r => r.tag), ['AndroidRuntime', 'chromium']);
  const m2 = buildMatcher('^fatal', true, true);
  assert.equal(filterEntries(rows, base, m2).length, 0);
});

test('an invalid regular expression reports an error and keeps every row', () => {
  const matcher = buildMatcher('(unclosed', true, false);
  assert.ok(matcher.error);
  assert.equal(filterEntries(rows, base, matcher).length, 4);
});

test('tag and process filters narrow the list', () => {
  const matcher = buildMatcher('', false, false);
  assert.equal(filterEntries(rows, { ...base, tag: 'WifiService' }, matcher).length, 1);
  assert.equal(filterEntries(rows, { ...base, pid: 10 }, matcher).length, 2);
});

test('highlight returns matched fragments in order', () => {
  const { pattern } = buildMatcher('o', false, false);
  const parts = highlightParts('foo bar', pattern);
  assert.equal(parts.map(p => p.text).join(''), 'foo bar');
  assert.deepEqual(parts.filter(p => p.hit).map(p => p.text), ['o', 'o']);
  assert.deepEqual(highlightParts('abc', null), [{ text: 'abc', hit: false }]);
});

test('the buffer keeps only the newest entries', () => {
  const many = Array.from({ length: MAX_BUFFERED_ENTRIES + 10 }, (_, i) => mk('I', 'T', String(i)));
  const result = appendEntries([], many);
  assert.equal(result.length, MAX_BUFFERED_ENTRIES);
  assert.equal(result.at(-1).message, String(MAX_BUFFERED_ENTRIES + 9));
});
