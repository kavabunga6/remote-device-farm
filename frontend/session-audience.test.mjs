import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
const bundle = await build({ entryPoints: [fileURLToPath(new URL('./src/session-audience.ts', import.meta.url))], bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent' });
const { deriveSessionAudience, audienceDescription, AUDIENCE_STALE_MS } = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].contents).toString('base64'));
const now = Date.parse('2026-10-03T10:00:00Z');
const iso = delta => new Date(now + delta).toISOString();
const person = (id, patch = {}) => ({ grantId: id, userId: id, username: id, name: id, mode: 'view', redeemedAt: iso(-1000), expiresAt: iso(10000), connected: true, ...patch });
const share = (id, redeemers = [], patch = {}) => ({ id, mode: 'view', createdAt: iso(-1000), expiresAt: iso(20000), maxRecipients: 5, recipientsUsed: redeemers.length, redeemers, ...patch });
const ready = shares => ({ status: 'ready', shares, updatedAt: now, error: '' });

test('separates active links, granted accounts and connected accounts; deduplicates the same account across links', () => {
  const audience = deriveSessionAudience(ready([share('one', [person('alice'), person('bob', { connected: false })]), share('two', [person('alice-copy', { userId: 'alice', username: 'alice' })]), share('empty')]), now);
  assert.equal(audience.activeLinks, 3); assert.equal(audience.recipients, 2); assert.equal(audience.connected, 1);
  assert.match(audienceDescription(audience), /Активных ссылок: 3 · Получили доступ: 2 · Сейчас подключено: 1/);
});
test('expiry and revocation remove access even before the next successful poll', () => {
  const audience = deriveSessionAudience(ready([share('expired', [person('x')], { expiresAt: iso(0) }), share('revoked', [person('y')], { revokedAt: iso(-5) }), share('active', [person('a', { expiresAt: iso(0) }), person('b', { revokedAt: iso(-5) }), person('c')])]), now);
  assert.equal(audience.activeLinks, 1); assert.equal(audience.recipients, 1); assert.equal(audience.connected, 1);
  const expired = deriveSessionAudience(ready([share('soon', [person('a')], { expiresAt: iso(5) })]), now + 6);
  assert.equal(expired.activeLinks, 0); assert.equal(expired.recipients, 0);
});
test('disconnect keeps the grant and link; reconnect changes only the connected count', () => {
  const disconnected = deriveSessionAudience(ready([share('one', [person('a', { connected: false })])]), now);
  assert.equal(disconnected.activeLinks, 1); assert.equal(disconnected.recipients, 1); assert.equal(disconnected.connected, 0);
  assert.match(audienceDescription(disconnected), /Получили доступ: 1 · Сейчас подключено: 0/);
});
test('loading, error, non-owner access and stale snapshots never claim there are no guests', () => {
  for (const status of ['loading', 'error', 'unavailable']) {
    const text = audienceDescription(deriveSessionAudience({ ...ready([]), status }, now));
    assert.doesNotMatch(text, /ссылок нет|подключено: 0|Получили доступ: 0|никого/i);
  }
  const stale = deriveSessionAudience(ready([]), now + AUDIENCE_STALE_MS + 1);
  assert.equal(stale.status, 'error'); assert.match(audienceDescription(stale), /статус неизвестен/);
});
test('bad expiry data cannot be reported as an empty private session', () => {
  const audience = deriveSessionAudience(ready([share('bad', [], { expiresAt: 'invalid' })]), now);
  assert.equal(audience.status, 'error'); assert.match(audienceDescription(audience), /статус неизвестен/);
});
test('legacy redeemers without account identifiers are not merged by display name', () => {
  const audience = deriveSessionAudience(ready([share('one', [person('first', { userId: undefined, username: 'qa', name: 'QA' }), person('second', { userId: undefined, username: 'qa', name: 'QA' })])]), now);
  assert.equal(audience.recipients, 2);
  assert.equal(audience.recipientUnit, 'grants');
  assert.match(audienceDescription(audience), /Гостевых доступов: 2/);
});

test('different accounts with the same username remain separate people', () => {
  const audience = deriveSessionAudience(ready([share('one', [person('local-qa', { username: 'qa' }), person('ldap-qa', { username: 'qa' })])]), now);
  assert.equal(audience.recipients, 2); assert.equal(audience.connected, 2); assert.equal(audience.recipientUnit, 'people');
});
