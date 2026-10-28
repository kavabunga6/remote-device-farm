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
const literal = node => ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node);
const textOf = node => literal(node) ? node.text : node.head.text + node.templateSpans.map(part => part.literal.text).join('');
const expression = node => ts.isJsxExpression(node) ? node.expression : node;
const copyName = (node, ast) => node.name.getText(ast).replace(/['"]/g, '');

function visibleOperands(node) {
  if (ts.isConditionalExpression(node)) return [node.whenTrue, node.whenFalse];
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isNonNullExpression(node)) return [node.expression];
  if (!ts.isBinaryExpression(node)) return [];
  if (node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) return [node.right];
  return [ts.SyntaxKind.PlusToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(node.operatorToken.kind) ? [node.left, node.right] : [];
}
function auditVisibleValue(node, report) {
  if (!node) return;
  if (literal(node) || ts.isTemplateExpression(node)) {
    const text = textOf(node);
    if (letters.test(text) && !technical(text)) report(node, 'Visible text must use the message dictionary');
    return;
  }
  for (const operand of visibleOperands(node)) auditVisibleValue(operand, report);
}
function auditVisibleAttribute(node, ast, report) {
  if (visibleAttributes.has(node.name.getText(ast)) && node.initializer) auditVisibleValue(expression(node.initializer), report);
}
function auditVisibleNode(node, ast, report) {
  if (ts.isJsxText(node) && letters.test(node.text)) report(node, 'JSX text must use the message dictionary');
  if (ts.isJsxAttribute(node)) {
    auditVisibleAttribute(node, ast, report);
  } else if (ts.isJsxExpression(node) && !ts.isJsxAttribute(node.parent)) {
    auditVisibleValue(node.expression, report);
  }
  if (ts.isPropertyAssignment(node) && copyProperties.has(copyName(node, ast))) auditVisibleValue(node.initializer, report);
}
function auditReference(node, ast, report) {
  if (!ts.isCallExpression(node)) return;
  const name = node.expression.getText(ast);
  if (!['t', 'uiMessage', 'agentMessage', 'diagnostic'].includes(name)) return;
  const argument = node.arguments[0];
  if (!argument || !literal(argument)) return;
  const messages = name === 'diagnostic' ? diagnostics : dictionary;
  if (!Object.hasOwn(messages, argument.text)) report(node, 'Missing message: ' + argument.text);
}
function auditNode(node, ast, frontend, report) {
  if ((literal(node) || ts.isTemplateExpression(node)) && /[А-Яа-яЁё]/.test(textOf(node))) report(node, 'Russian copy outside the dictionary');
  if (frontend) auditVisibleNode(node, ast, report);
  auditReference(node, ast, report);
  ts.forEachChild(node, child => auditNode(child, ast, frontend, report));
}
export function sourceProblems(source, file = 'example.tsx') {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const problems = [];
  const report = (node, problem) => problems.push(file + ':' + (ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1) + ': ' + problem);
  auditNode(ast, ast, file.endsWith('.tsx') || /frontend[\\/]src/.test(file), report);
  return [...new Set(problems)];
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
