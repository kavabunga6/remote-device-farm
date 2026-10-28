import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { resolve, relative } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(resolve(root, 'frontend/package.json'));
const ts = require('typescript');
const dictionary = JSON.parse(readFileSync(resolve(root, 'shared/messages.json'), 'utf8'));
const diagnostics = JSON.parse(readFileSync(resolve(root, 'shared/diagnostics.json'), 'utf8'));
const visibleAttributes = new Set(['title', 'aria-label', 'aria-description', 'aria-valuetext', 'placeholder', 'alt']);
const copyProperties = new Set(['label', 'title', 'description', 'placeholder', 'help', 'message', 'warning']);
const letters = /[\p{L}]/u;
// Paths and commands shown to operators are data, not interface prose.
const technical = value => /^(?:\/?api\/|https?:\/\/|wss?:\/\/|\/appium\b)/.test(value);

export function sourceProblems(source, file = 'example.tsx') {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const problems = [];
  const report = (node, problem) => problems.push(file + ':' + (ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1) + ': ' + problem);
  const literal = node => ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node);
  const visible = node => {
    if (!node) return;
    if (literal(node)) { if (letters.test(node.text) && !technical(node.text)) report(node, 'Visible text must use the message dictionary'); }
    else if (ts.isTemplateExpression(node)) {
      if (letters.test(node.head.text + node.templateSpans.map(part => part.literal.text).join(''))) report(node, 'Visible template text must use the message dictionary');
    } else if (ts.isConditionalExpression(node)) { visible(node.whenTrue); visible(node.whenFalse); }
    else if (ts.isParenthesizedExpression(node)) visible(node.expression);
    else if (ts.isBinaryExpression(node) && [ts.SyntaxKind.PlusToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(node.operatorToken.kind)) { visible(node.left); visible(node.right); }
  };
  const visit = node => {
    if ((literal(node) || ts.isTemplateExpression(node)) && /[А-Яа-яЁё]/.test(literal(node) ? node.text : node.head.text + node.templateSpans.map(part => part.literal.text).join(''))) report(node, 'Russian copy outside the dictionary');
    if (file.endsWith('.tsx') || /frontend[\\/]src/.test(file)) {
      if (ts.isJsxText(node) && letters.test(node.text)) report(node, 'JSX text must use the message dictionary');
      if (ts.isJsxAttribute(node) && visibleAttributes.has(node.name.getText(ast)) && node.initializer) visible(ts.isJsxExpression(node.initializer) ? node.initializer.expression : node.initializer);
      if (ts.isJsxExpression(node) && !ts.isJsxAttribute(node.parent)) visible(node.expression);
      if (ts.isPropertyAssignment(node) && copyProperties.has(node.name.getText(ast).replace(/['"]/g, ''))) visible(node.initializer);
    }
    if (ts.isCallExpression(node) && ['t', 'uiMessage', 'agentMessage', 'diagnostic'].includes(node.expression.getText(ast)) && node.arguments[0] && literal(node.arguments[0])) {
      const key = node.arguments[0].text;
      const messages = node.expression.getText(ast) === 'diagnostic' ? diagnostics : dictionary;
      if (!Object.hasOwn(messages, key)) report(node, 'Missing message: ' + key);
    }
    ts.forEachChild(node, visit);
  };
  visit(ast); return [...new Set(problems)];
}
export function auditMessageSources() {
  return ['frontend/src', 'server/src', 'agent/src'].flatMap(directory => readdirSync(resolve(root, directory), { recursive: true })
    .filter(file => /\.(?:tsx?|mjs)$/.test(file) && !/\.test\.|(?:^|[\\/])(?:generated|fixtures)[\\/]/.test(file))
    .flatMap(file => { const path = resolve(root, directory, file); return sourceProblems(readFileSync(path, 'utf8'), relative(root, path)); }));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const problems = auditMessageSources();
  if (problems.length) { console.error(problems.join('\n')); process.exitCode = 1; }
  else console.log('Interface copy and message references verified');
}
