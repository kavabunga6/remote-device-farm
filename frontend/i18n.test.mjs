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


test('a stale cross-tab download failure cannot replace a successful choice with an error', async () => {
 const originalFetch = globalThis.fetch, originalWindow = globalThis.window;
 let storageChanged, rejectDownload;
 globalThis.window = { addEventListener: (name, handler) => { if (name === 'storage') storageChanged = handler; } };
 globalThis.fetch = () => new Promise((resolve, reject) => { rejectDownload = reject; });
 try {
  const fresh = await import(moduleUrl + '#stale-storage-error');
  storageChanged({ key: 'rdf.language', newValue: 'ar' });
  await fresh.setLanguage('en');
  rejectDownload(new Error('offline'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fresh.getLanguage(), 'en');
  assert.equal(fresh.languageInitializationFailed(), false);
 } finally { globalThis.fetch = originalFetch; globalThis.window = originalWindow; }
});

test('initial dictionary failure notifies an already rendered interface', async () => {
 const originalFetch = globalThis.fetch, originalStorage = globalThis.localStorage;
 globalThis.localStorage = { getItem: () => 'fr' };
 globalThis.fetch = async () => { throw new Error('offline'); };
 try {
  const fresh = await import(moduleUrl + '#initial-failure');
  let updates = 0;
  fresh.subscribeLanguage(() => updates++);
  await fresh.initializeLanguage();
  assert.equal(fresh.languageInitializationFailed(), true);
  assert.equal(fresh.getLanguage(), 'ru');
  assert.equal(updates, 1);
 } finally { globalThis.fetch = originalFetch; globalThis.localStorage = originalStorage; }
});


test('dictionary validation rejects blank copy, keeps the active language and permits a clean retry', async () => {
 const originalFetch = globalThis.fetch;
 const french = JSON.parse(fs.readFileSync(new URL('../shared/locales/fr.json', import.meta.url), 'utf8'));
 globalThis.fetch = async () => new Response(JSON.stringify({ ...french, 'auth.signIn': ' ' }), { status: 200 });
 try {
  const fresh = await import(moduleUrl + '#invalid-dictionary');
  await fresh.setLanguage('en');
  await assert.rejects(fresh.setLanguage('fr'), /Incomplete locale: fr:auth.signIn/);
  assert.equal(fresh.getLanguage(), 'en');
  globalThis.fetch = async () => new Response(JSON.stringify(french), { status: 200 });
  await fresh.setLanguage('fr');
  assert.equal(fresh.t('auth.signIn'), french['auth.signIn']);
  assert.equal(fresh.languageInitializationFailed(), false);
 } finally { globalThis.fetch = originalFetch; }
});

test('a user language choice is saved while loading a saved preference does not write it again', async () => {
 const originalStorage = globalThis.localStorage;
 const writes = [];
 globalThis.localStorage = { getItem: () => 'en', setItem: (key, value) => writes.push([key, value]) };
 try {
  const fresh = await import(moduleUrl + '#persist-preference');
  await fresh.initializeLanguage();
  assert.equal(fresh.getLanguage(), 'en'); assert.deepEqual(writes, []);
  await fresh.setLanguage('ru');
  assert.deepEqual(writes, [['rdf.language', 'ru']]);
 } finally { globalThis.localStorage = originalStorage; }
});

test('error fallbacks do not expose unrecognized server details and keep API mappings enumerable', async () => {
 const fresh = await import(moduleUrl + '#error-fallbacks');
 await fresh.setLanguage('en');
 for (const [status, key] of [[400,'error.invalid'],[401,'error.unauthorized'],[403,'error.forbidden'],[404,'error.notFound'],[409,'error.conflict'],[413,'error.tooLarge'],[422,'error.invalid'],[429,'error.rateLimit'],[503,'error.server']]) {
  assert.equal(fresh.errorMessage(status, 'unrecognized internal error'), dictionary[key].en);
  assert.equal(fresh.errorMessage(status), dictionary[key].en);
 }
 assert.ok(Object.keys(fresh.knownErrorMessages()).includes('invalid_launch_options'));
 assert.equal(fresh.t('copy.HostCard.440a991a', { p0: 0 }), dictionary['copy.HostCard.440a991a'].en.replace('{p0}', '0'));
 assert.equal(fresh.t('copy.HostCard.440a991a', { p0: false }), dictionary['copy.HostCard.440a991a'].en.replace('{p0}', 'false'));
 assert.equal(fresh.t('copy.HostCard.440a991a', { p0: null }), dictionary['copy.HostCard.440a991a'].en.replace('{p0}', ''));
 assert.throws(() => fresh.t('missing-key'), /Missing translation key: missing-key/);
});

test('uncached notices resolve short prefixes and complete sentences before general templates', async () => {
 const fresh = await import(moduleUrl + '#uncached-notices');
 await fresh.setLanguage('ru');
 assert.equal(fresh.localizeText('of 12'), dictionary['copy.CountBadge.c552c01a'].ru.replace('{p0}', '12'));
 const complete = dictionary['ui.0cc432761585'];
 const withValues = text => text.replace('{p0}', 'worker').replace('{p1}', 'emulator').replace('{p2}', 'ready');
 assert.equal(fresh.localizeText(withValues(complete.en)), withValues(complete.ru));
 const longNotice = 'Node ' + 'x'.repeat(1995);
 assert.equal(fresh.localizeText(longNotice), dictionary['ui.66bda389f3a5'].ru.replace('{p0}', 'x'.repeat(1995)));
 assert.equal(fresh.localizeText(longNotice + 'x'), longNotice + 'x');

 await fresh.setLanguage('en');
 assert.equal(fresh.localizeText('Сессия #demo'), 'Session #demo');
 assert.equal(fresh.localizeText('Сессия #'), 'Session #');
 assert.equal(fresh.localizeText('raw device output'), 'raw device output');
});

test('notice matching rejects ambiguous copy and inconsistent repeated parameters', async () => {
 const originalFetch = globalThis.fetch;
 const french = JSON.parse(fs.readFileSync(new URL('../shared/locales/fr.json', import.meta.url), 'utf8'));
 const copy = {
  ...french,
  'ui.66bda389f3a5': 'Notice {p0}; repeated {p0}.',
  'copy.HostCard.440a991a': 'Ambiguous {p0}{p1}',
  'copy.CountBadge.c552c01a': 'x{p0}',
  'ui.0cc432761585': 'Report {p0} completed with details.',
  'ui.71565c75af24': 'Report {p0} {p1}',
 };
 globalThis.fetch = async () => new Response(JSON.stringify(copy), { status: 200 });
 try {
  const fresh = await import(moduleUrl + '#notice-contract');
  await fresh.setLanguage('fr');
  await fresh.setLanguage('en');
  assert.equal(fresh.localizeText('Notice alpha; repeated alpha.'), 'Node alpha');
  assert.equal(fresh.localizeText('Notice alpha; repeated beta.'), 'Notice alpha; repeated beta.');
  assert.equal(fresh.isInterfaceMessage('Ambiguous anything'), false);
  assert.equal(fresh.isInterfaceMessage('xanything'), false);
  assert.equal(fresh.localizeText('Report alpha completed with details.'), dictionary['ui.0cc432761585'].en.replace('{p0}', 'alpha'));
 } finally { globalThis.fetch = originalFetch; }
});

test('rendered notice history stays bounded and retains the latest notices', async () => {
 const fresh = await import(moduleUrl + '#notice-history');
 await fresh.setLanguage('en');
 for (let count = 0; count <= 5000; count++) fresh.t('ui.1febafe019db', { p0: count });
 await fresh.setLanguage('ru');
 assert.equal(fresh.localizeText('0 min'), '0 min');
 assert.equal(fresh.localizeText('5000 min'), '5000 мин');
});
