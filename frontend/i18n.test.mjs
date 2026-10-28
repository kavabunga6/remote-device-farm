import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { build } from 'esbuild';
const dictionary = JSON.parse(fs.readFileSync(new URL('../shared/messages.json', import.meta.url),'utf8'));
const bundle = await build({ entryPoints: ['src/i18n.ts'], bundle: true, write: false, platform: 'node', format: 'esm', logLevel: 'silent', define: { 'import.meta.url': JSON.stringify(new URL('./src/i18n.ts', import.meta.url).href) } });
const moduleUrl = 'data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text + '\n//# sourceURL=i18n-unit.mjs').toString('base64');
const i18n = await import(moduleUrl);
test('dictionary covers RU/EN with identical placeholders and no untranslated English copy', () => {
 for(const [key,values] of Object.entries(dictionary)) {
  assert.deepEqual(Object.keys(values).sort(),['en','ru'],key);
  assert.ok(values.ru.trim() && values.en.trim(),key);
  assert.deepEqual([...values.ru.matchAll(/\{[a-zA-Z]\w*\}/g)].map(m=>m[0]).sort(),[...values.en.matchAll(/\{[a-zA-Z]\w*\}/g)].map(m=>m[0]).sort(),key);
  if (key !== 'language.ru') assert.doesNotMatch(values.en,/[А-Яа-яЁё]/,key);
 }
});
test('language updates interpolation, locale, stored notices and subscribers without remounts', () => {
 i18n.setLanguage('ru');const key=Object.keys(dictionary).find(k=>dictionary[k].ru==='Сессия #{p0}');
 const old=i18n.t(key,{p0:'abc'});let updates=0;const unsubscribe=i18n.subscribeLanguage(()=>updates++);
 i18n.setLanguage('en');assert.equal(i18n.localizeText(old),'Session #abc');assert.equal(i18n.getLocale(),'en-US');assert.equal(updates,1);
 i18n.setLanguage('en');assert.equal(updates,1);unsubscribe();i18n.setLanguage('ru');assert.equal(updates,1);
 assert.equal(i18n.getLocale(),'ru-RU');assert.equal(i18n.localizeText('raw device output'),'raw device output');
});

test('persisted server notices and parameterized API errors use the same dictionary', () => {
 i18n.setLanguage('en');
 assert.equal(i18n.localizeText(dictionary['ui.bc5fd0c83e94'].ru.replace('{p0}','Android 11')), 'Starting device Android 11');
 assert.equal(i18n.errorMessage(409,dictionary['ui.7bd1a31a6b9c'].ru), "End the user's active sessions first");
 assert.equal(i18n.errorMessage(400,dictionary['ui.e242377da8ff'].en.replace('{p0}','2').replace('{p1}','32')), 'Data partition must be 2–32 GB for this profile');
 const errors=i18n.knownErrorMessages();const en=errors.invalid_launch_options;i18n.setLanguage('ru');assert.notEqual(errors.invalid_launch_options,en);
});

const languages = JSON.parse(fs.readFileSync(new URL('../shared/languages.json', import.meta.url), 'utf8'));
test('all supported languages resolve complete copy, named parameters and locale direction', async () => {
 const originalFetch = globalThis.fetch;
 globalThis.fetch = async url => new Response(fs.readFileSync(url, 'utf8'), { status: 200 });
 try {
 for (const item of languages) {
  await i18n.setLanguage(item.id);
  assert.equal(i18n.getLanguage(), item.id);
  assert.equal(i18n.getLocale(), item.locale);
  assert.equal(i18n.getDirection(), item.direction);
  const copy = ['en', 'ru'].includes(item.id)
    ? Object.fromEntries(Object.entries(dictionary).map(([key, value]) => [key, value[item.id]]))
    : JSON.parse(fs.readFileSync(new URL('../shared/locales/' + item.id + '.json', import.meta.url), 'utf8'));
  assert.deepEqual(Object.keys(copy).sort(), Object.keys(dictionary).sort(), item.id);
  for (const key of Object.keys(dictionary)) {
   assert.equal(i18n.t(key), copy[key], item.id + ':' + key);
   assert.deepEqual([...copy[key].matchAll(/\{[a-zA-Z]\w*\}/g)].map(match => match[0]).sort(), [...dictionary[key].en.matchAll(/\{[a-zA-Z]\w*\}/g)].map(match => match[0]).sort(), item.id + ':' + key);
  }
  assert.equal(i18n.localizeText(dictionary['manifest.unpinnedImage'].en), copy['manifest.unpinnedImage']);
 }
 } finally { globalThis.fetch = originalFetch; }
});
test('a later language choice wins over an earlier asynchronous request', async () => {
 const fresh = await import(moduleUrl + '#race');
 const originalFetch = globalThis.fetch;
 let finish;
 globalThis.fetch = () => new Promise(resolve => { finish = resolve; });
 try {
  const pending = fresh.setLanguage('ar');
  await fresh.setLanguage('en');
  finish(new Response(fs.readFileSync(new URL('../shared/locales/ar.json', import.meta.url), 'utf8'), { status: 200 }));
  await pending;
  assert.equal(fresh.getLanguage(), 'en');
  await fresh.setLanguage('unknown');
  assert.equal(fresh.getLanguage(), 'en');
  assert.equal(fresh.localizeText('adb: device unauthorized'), 'adb: device unauthorized');
 } finally { globalThis.fetch = originalFetch; }
});
