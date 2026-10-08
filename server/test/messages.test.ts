import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import ts from 'typescript';
import { uiMessage } from '../src/messages.js';

const dictionary = JSON.parse(readFileSync(new URL('../../shared/messages.json', import.meta.url), 'utf8')) as Record<string, {ru: string; en: string}>;
const sourceRoot = fileURLToPath(new URL('../src/', import.meta.url));

test('server UI messages resolve the shared RU/EN dictionary and preserve parameters', () => {
  const [key, entry] = Object.entries(dictionary).find(([, value]) => value.ru.includes('{p0}') && value.en.includes('{p0}'))!;
  assert.equal(uiMessage(key, {p0: '<device>'}, 'en'), entry.en.replaceAll('{p0}', '<device>'));
  assert.equal(uiMessage(key, {p0: '<device>'}), entry.ru.replaceAll('{p0}', '<device>'));
  assert.throws(() => uiMessage('missing.translation'), /Missing UI message key/);
});

test('server source keeps interface copy and API explanations in the shared dictionary', () => {
  for (const file of readdirSync(sourceRoot, {recursive: true}).filter(file => typeof file === 'string' && file.endsWith('.ts')) as string[]) {
    const source = readFileSync(sourceRoot + file, 'utf8');
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node): void => {
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) {
        const copy = ts.isTemplateExpression(node) ? node.head.text + node.templateSpans.map(span => span.literal.text).join('') : node.text;
        assert.doesNotMatch(copy, /[А-Яа-яЁё]/, file + ':' + (ast.getLineAndCharacterOfPosition(node.pos).line + 1));
      }
      if (ts.isCallExpression(node) && node.expression.getText(ast) === 'uiMessage' && ts.isStringLiteral(node.arguments[0]!)) {
        assert.ok(dictionary[(node.arguments[0] as ts.StringLiteral).text], file + ': missing translation');
      }
      if (ts.isNewExpression(node) && node.expression.getText(ast) === 'ApiError' && node.arguments?.[2]) {
        assert.ok(!ts.isStringLiteral(node.arguments[2]) && !ts.isNoSubstitutionTemplateLiteral(node.arguments[2]), file + ': hardcoded API explanation');
      }
      ts.forEachChild(node, visit);
    };
    visit(ast);
  }
});
