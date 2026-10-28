import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = path => JSON.parse(readFileSync(resolve(root, path), 'utf8'));
export const placeholders = value => [...value.matchAll(/\{[a-zA-Z]\w*\}/g)].map(match => match[0]).sort();
export function validateLocale(source, translated, name) {
  const errors = [];
  for (const key of Object.keys(translated)) if (!Object.hasOwn(source, key)) errors.push(name + ': unexpected key ' + key);
  for (const [key, reference] of Object.entries(source)) {
    const text = translated[key];
    if (['ui.6ba0bdeccb42', 'ui.3457b1617fe5'].includes(key) && text !== reference) errors.push(name + ': product name must stay unchanged in ' + key);
    if (typeof text !== 'string' || !text.trim()) { errors.push(name + ': missing text for ' + key); continue; }
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(text)) errors.push(name + ': control character in ' + key);
    if (JSON.stringify(placeholders(reference)) !== JSON.stringify(placeholders(text))) errors.push(name + ': placeholders differ in ' + key);
  }
  return errors;
}
const fingerprint = value => createHash('sha256').update(JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b, 'en'))))).digest('hex');

if (process.argv.includes('--self-test')) {
  assert.deepEqual(validateLocale({ a: 'Hi {name}, {p0} {p0}' }, { a: '{p0} {name} {p0}' }, 'test'), []);
  assert.equal(validateLocale({ a: '{name}' }, { a: '{p0}', extra: 'Text' }, 'test').length, 2);
  assert.equal(validateLocale({ a: 'Text' }, { a: '\u202eText' }, 'test').length, 1);
  assert.equal(validateLocale({ a: 'Text' }, {}, 'test').length, 1);
  assert.equal(fingerprint({ b: 1, a: 2 }), fingerprint({ a: 2, b: 1 }));
  console.log('Localization validator self-test passed');
} else {
  const source = read('shared/messages.json');
  const languages = read('shared/languages.json');
  const ids = languages.map(language => language.id);
  assert.equal(new Set(ids).size, ids.length, 'Duplicate language identifiers');
  assert.equal(ids.length, 12, 'All supported languages must be declared');
  for (const language of languages) {
    assert.ok(language.name && language.search && ['ltr', 'rtl'].includes(language.direction), language.id);
    new Intl.DateTimeFormat(language.locale).format(0);
  }
  const en = Object.fromEntries(Object.entries(source).map(([key, value]) => [key, value.en]));
  const ru = Object.fromEntries(Object.entries(source).map(([key, value]) => [key, value.ru]));
  const errors = [...validateLocale(en, ru, 'ru'), ...validateLocale(en, en, 'en')];
  for (const [key, value] of Object.entries(source)) {
    if (Object.keys(value).sort().join(',') !== 'en,ru') errors.push('Unexpected source fields in ' + key);
  }
  const record = process.argv.find(arg => arg.startsWith('--record-review='));
  const reviewed = record ? record.slice('--record-review='.length).split(',') : [];
  for (const id of reviewed) assert.ok(ids.includes(id) && !['ru', 'en'].includes(id), 'Unknown translation: ' + id);
  const revisionsPath = 'shared/locales/revisions.json';
  const revisions = (() => { try { return read(revisionsPath); } catch { return {}; } })();
  const sourceDigest = fingerprint(source);
  if (!process.argv.includes('--source-only')) for (const id of ids.filter(id => !['ru', 'en'].includes(id))) {
    let translated;
    try { translated = read('shared/locales/' + id + '.json'); } catch { errors.push(id + ': dictionary could not be read'); continue; }
    errors.push(...validateLocale(en, translated, id));
    for (const [key, text] of Object.entries(translated)) {
      const reference = source[key];
      if (reference && text === reference.en && reference.ru !== reference.en && text.length > 80 && /[.!?]$/.test(text) && (text.match(/[a-zA-Z]+/g)?.length ?? 0) > 8) {
        errors.push(id + ': untranslated English sentence in ' + key);
      }
    }
    if (reviewed.includes(id)) revisions[id] = { sourceDigest, translationDigest: fingerprint(translated) };
    else if (!process.argv.includes('--content-only') && (revisions[id]?.sourceDigest !== sourceDigest || revisions[id]?.translationDigest !== fingerprint(translated))) {
      errors.push(id + ': source or translation changed; review the affected copy and record the review');
    }
  }
  if (errors.length) { console.error(errors.join('\n')); process.exitCode = 1; }
  else {
    if (record) writeFileSync(resolve(root, revisionsPath), JSON.stringify(revisions, null, 2) + '\n');
    console.log(Object.keys(source).length + ' message keys verified' + (process.argv.includes('--source-only') ? '' : ' across ' + ids.length + ' languages'));
  }
}
