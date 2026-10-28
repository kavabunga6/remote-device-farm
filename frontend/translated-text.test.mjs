import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { createRequire } from 'node:module';

const result = await build({
  stdin: { contents: `
    import { createElement } from 'react';
    import { renderToStaticMarkup } from 'react-dom/server';
    import { TranslatedText } from './src/TranslatedText';
    import { setLanguage } from './src/i18n';
    export function render(value) {
      setLanguage('en');
      return renderToStaticMarkup(createElement(TranslatedText, {
        message: 'copy.AdbKeysPage.c6f3bf98',
        values: { p0: createElement('code', null, value), p1: createElement('code', null, 'adbkey') },
      }));
    }
  `, resolveDir: process.cwd(), loader: 'tsx' },
  bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external',
  define: { 'import.meta.url': JSON.stringify(new URL('./src/i18n.ts', import.meta.url).href) },
});
const module = { exports: {} };
new Function('module', 'exports', 'require', result.outputFiles[0].text)(module, module.exports, createRequire(import.meta.url));
test('rich translations preserve formatted values without interpreting them as markup', () => {
  assert.equal(module.exports.render('adbkey.pub'), 'Only the file <code>adbkey.pub</code> is uploaded. The private <code>adbkey</code> stays on your computer.');
  const result = module.exports.render('<img src=x onerror=alert(1)>{p1}');
  assert.ok(result.includes('&lt;img'));
  assert.ok(result.includes('{p1}</code>'));
  assert.equal(result.includes('<img'), false);
});
