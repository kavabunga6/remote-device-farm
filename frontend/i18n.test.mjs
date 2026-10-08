import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import ts from 'typescript';
import { build } from 'esbuild';
const dictionary = JSON.parse(fs.readFileSync(new URL('../shared/messages.json', import.meta.url),'utf8'));
const bundle = await build({ entryPoints: ['src/i18n.ts'], bundle: true, write: false, platform: 'node', format: 'esm', logLevel: 'silent' });
const i18n = await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].contents).toString('base64'));
test('dictionary covers RU/EN with identical placeholders and no untranslated English copy', () => {
 for(const [key,values] of Object.entries(dictionary)) {
  assert.deepEqual(Object.keys(values).sort(),['en','ru'],key);
  assert.ok(values.ru.trim() && values.en.trim(),key);
  assert.deepEqual([...values.ru.matchAll(/\{p\d+\}/g)].map(m=>m[0]).sort(),[...values.en.matchAll(/\{p\d+\}/g)].map(m=>m[0]).sort(),key);
  if (key !== 'language.ru') assert.doesNotMatch(values.en,/[А-Яа-яЁё]/,key);
 }
});
test('UI source cannot embed Russian strings or visible JSX copy outside the dictionary', () => {
 for(const file of fs.readdirSync('src',{recursive:true}).filter(f=>/\.tsx?$/.test(f))) {
  const source=fs.readFileSync('src/'+file,'utf8');const ast=ts.createSourceFile(file,source,99,true);
  function visit(node) {
   if(ts.isStringLiteral(node)||ts.isNoSubstitutionTemplateLiteral(node)||ts.isTemplateExpression(node)) {
    assert.doesNotMatch(ts.isTemplateExpression(node)?node.head.text+node.templateSpans.map(s=>s.literal.text).join(''):node.text,/[А-Яа-яЁё]/,file+':'+(ast.getLineAndCharacterOfPosition(node.pos).line+1));
   }
   if(ts.isJsxAttribute(node)&&['title','aria-label','aria-valuetext','placeholder','alt'].includes(node.name.getText(ast))&&node.initializer&&ts.isStringLiteral(node.initializer))assert.doesNotMatch(node.initializer.text,/[\p{L}]/u,file+': hardcoded UI attribute');
   if(ts.isJsxText(node))assert.doesNotMatch(node.text,/[\p{L}]/u,file+':'+(ast.getLineAndCharacterOfPosition(node.pos).line+1));
   if(ts.isCallExpression(node)&&node.expression.getText(ast)==='t'&&ts.isStringLiteral(node.arguments[0]))assert.ok(dictionary[node.arguments[0].text],file+': missing '+node.arguments[0].text);
   ts.forEachChild(node,visit);
  } visit(ast);
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
