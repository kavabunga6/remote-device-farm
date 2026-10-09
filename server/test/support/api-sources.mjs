import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

export const root = fileURLToPath(new URL('../../../', import.meta.url));
export const operationKey = (method, route) =>
  `${method.toUpperCase()} ${route.replace(/:[A-Za-z]\w*|\{[^}]+\}/g, '{}')}`;
function files(dir) {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) =>
      entry.isDirectory()
        ? files(path.join(dir, entry.name))
        : entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')
          ? [path.join(dir, entry.name)]
          : [],
    );
}
const source = (file) =>
  ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
function walk(node, visit) {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}

export function serverOperations() {
  const result = [];
  for (const file of files(path.join(root, 'server/src'))) {
    const tree = source(file);
    walk(tree, (node) => {
      if (
        !ts.isCallExpression(node) ||
        !ts.isPropertyAccessExpression(node.expression) ||
        node.expression.expression.getText(tree) !== 'app' ||
        !/^(get|post|put|patch|delete)$/.test(node.expression.name.text)
      )
        return;
      const route = node.arguments[0];
      if (!route || !ts.isStringLiteral(route)) throw new Error(`Unresolved server route in ${file}`);
      result.push({ method: node.expression.name.text.toUpperCase(), path: route.text, node, tree, file });
    });
  }
  return result;
}

// Resolve URL structure, including encoded path parameters and query-only helpers.
// Unsupported expressions fail closed: a new helper needs an explicit extractor rule.
export function resolvePath(node, constants = new Map()) {
  if (!node) return null;
  if (ts.isParenthesizedExpression(node)) return resolvePath(node.expression, constants);
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isIdentifier(node))
    return constants.has(node.text) ? resolvePath(constants.get(node.text), constants) : '{}';
  if (ts.isTemplateExpression(node))
    return (
      node.head.text +
      node.templateSpans.map((span) => resolvePath(span.expression, constants) + span.literal.text).join('')
    );
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = resolvePath(node.left, constants);
    if (left === null) return null;
    if (left.includes('?')) return left;
    const right = resolvePath(node.right, constants);
    return right === null ? null : left + right;
  }
  if (ts.isConditionalExpression(node)) {
    const a = resolvePath(node.whenTrue, constants),
      b = resolvePath(node.whenFalse, constants);
    if (a === b) return a;
    if ([a, b].every((value) => value !== null && /^(\?|&|$)/.test(value))) return '?';
    return null;
  }
  if (ts.isCallExpression(node)) {
    const name = node.expression.getText();
    if (name === 'encodeURIComponent' || name === 'String') return '{}';
    if (name === 'pageQuery') return '?';
  }
  return null;
}

export function clientOperations() {
  const clientFiles = files(path.join(root, 'frontend/src'));
  const config = ts.readConfigFile(path.join(root, 'frontend/tsconfig.json'), ts.sys.readFile);
  if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, path.join(root, 'frontend'));
  const program = ts.createProgram(clientFiles, parsed.options);
  const checker = program.getTypeChecker();
  const result = [];
  for (const file of clientFiles) {
    const tree = program.getSourceFile(file);
    const constants = new Map();
    walk(tree, (node) => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer)
        constants.set(node.name.text, node.initializer);
    });
    const helpers = new Map([['apiRequest', {}]]);
    if (['api.ts', 'settings-api.ts'].includes(path.basename(file)))
      helpers.set('request', { positional: file.endsWith('settings-api.ts') });
    // Discover local forwarding helpers rather than assuming they all use GET.
    walk(tree, (declaration) => {
      const fn = ts.isFunctionDeclaration(declaration)
        ? declaration
        : ts.isVariableDeclaration(declaration) &&
            declaration.initializer &&
            ts.isArrowFunction(declaration.initializer)
          ? declaration.initializer
          : null;
      const name = ts.isFunctionDeclaration(declaration)
        ? declaration.name?.text
        : ts.isVariableDeclaration(declaration)
          ? declaration.name.getText(tree)
          : undefined;
      if (!fn || !name || !fn.parameters[0] || !fn.body) return;
      const parameter = fn.parameters[0].name.getText(tree);
      walk(fn.body, (call) => {
        if (
          !ts.isCallExpression(call) ||
          !['apiRequest', 'request'].includes(call.expression.getText(tree)) ||
          call.arguments[0]?.getText(tree) !== parameter
        )
          return;
        let fixed,
          positional = false;
        const options = call.arguments[1];
        if (options && ts.isObjectLiteralExpression(options)) {
          const method = options.properties.find((p) => p.name?.getText(tree) === 'method');
          const value =
            method &&
            (ts.isPropertyAssignment(method)
              ? method.initializer
              : ts.isShorthandPropertyAssignment(method)
                ? method.name
                : undefined);
          if (value && ts.isStringLiteral(value)) fixed = value.text;
          else if (value && fn.parameters[1]?.name.getText(tree) === value.getText(tree)) positional = true;
          else if (method) throw new Error(`Unresolved API helper method: ${name}`);
        }
        helpers.set(name, { fixed, positional });
      });
    });
    walk(tree, (node) => {
      // Explicit links and event streams bypass the JSON API wrapper.
      if (
        (ts.isNewExpression(node) && node.expression.getText(tree) === 'EventSource') ||
        (ts.isJsxAttribute(node) && node.name.getText(tree) === 'href')
      ) {
        const argument = ts.isNewExpression(node) ? node.arguments?.[0] : node.initializer;
        if (argument && ts.isStringLiteral(argument) && argument.text.startsWith('/api/'))
          result.push({ method: 'GET', path: argument.text, node, file, tree, checker });
      }
      if (!ts.isCallExpression(node)) return;
      const name = node.expression.getText(tree);
      const xhr =
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'open' &&
        checker.getTypeAtLocation(node.expression.expression).getSymbol()?.getName() === 'XMLHttpRequest';
      if (!helpers.has(name) && !xhr) return;
      const argument = node.arguments[xhr ? 1 : 0];
      // Forwarders use a plain path parameter; their callers are checked instead.
      if (argument && ts.isIdentifier(argument) && argument.text === 'path') return;
      const route = resolvePath(argument, constants);
      if (!route?.startsWith('/'))
        throw new Error(
          `Unresolved client route: ${path.relative(root, file)}:${tree.getLineAndCharacterOfPosition(node.pos).line + 1}`,
        );
      let method = xhr ? node.arguments[0]?.text : (helpers.get(name)?.fixed ?? 'GET');
      const options = node.arguments[1];
      if (!xhr && !helpers.get(name)?.fixed && options) {
        if (helpers.get(name)?.positional && ts.isStringLiteral(options)) method = options.text;
        else if (ts.isObjectLiteralExpression(options)) {
          const member = options.properties.find(
            (p) => ts.isPropertyAssignment(p) && p.name.getText(tree) === 'method',
          );
          if (member) {
            if (!ts.isStringLiteral(member.initializer))
              throw new Error(`Unresolved client method in ${file}`);
            method = member.initializer.text;
          }
        }
      }
      const routePath = route.split('?')[0];
      result.push({
        method,
        path: routePath.startsWith('/api/') ? routePath : '/api' + routePath,
        node,
        file,
        tree,
        responseType: node.typeArguments?.[0]
          ? checker.getTypeFromTypeNode(node.typeArguments[0])
          : undefined,
        checker,
      });
    });
  }
  return result;
}

// Client wire types are independent of OpenAPI. Used to validate observed JSON
// before any UI adapters run. Additional response fields remain forward compatible.
export function typeSchema(type, checker, ancestors = new Set()) {
  if (
    !type ||
    type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.TypeParameter | ts.TypeFlags.Void)
  )
    return {};
  if (type.flags & ts.TypeFlags.Union) {
    const choices = type.types
      .filter((t) => !(t.flags & ts.TypeFlags.Undefined))
      .map((t) => typeSchema(t, checker, ancestors));
    return choices.length === 1 ? choices[0] : { anyOf: choices };
  }
  if (type.flags & ts.TypeFlags.Null) return { type: 'null' };
  if (type.flags & ts.TypeFlags.StringLiteral) return { type: 'string', enum: [type.value] };
  if (type.flags & ts.TypeFlags.NumberLiteral) return { type: 'number', enum: [type.value] };
  if (type.flags & ts.TypeFlags.BooleanLiteral)
    return { type: 'boolean', enum: [type.intrinsicName === 'true'] };
  if (type.flags & ts.TypeFlags.StringLike) return { type: 'string' };
  if (type.flags & ts.TypeFlags.NumberLike) return { type: 'number' };
  if (type.flags & ts.TypeFlags.BooleanLike) return { type: 'boolean' };
  if (checker.isArrayType(type))
    return { type: 'array', items: typeSchema(checker.getTypeArguments(type)[0], checker, ancestors) };
  if (ancestors.has(type)) throw new Error('Recursive client type requires an explicit wire schema');
  const next = new Set([...ancestors, type]);
  const properties = {},
    required = [];
  for (const symbol of checker.getPropertiesOfType(type)) {
    const decl = symbol.valueDeclaration ?? symbol.declarations?.[0];
    if (!decl) continue;
    properties[symbol.name] = typeSchema(checker.getTypeOfSymbolAtLocation(symbol, decl), checker, next);
    const memberType = checker.getTypeOfSymbolAtLocation(symbol, decl);
    const undefinedAllowed =
      memberType.flags & ts.TypeFlags.Union && memberType.types.some((t) => t.flags & ts.TypeFlags.Undefined);
    if (!(symbol.flags & ts.SymbolFlags.Optional) && !undefinedAllowed) required.push(symbol.name);
  }
  const index = checker.getIndexTypeOfType(type, ts.IndexKind.String);
  return {
    type: 'object',
    properties,
    ...(required.length ? { required } : {}),
    ...(index ? { additionalProperties: typeSchema(index, checker, next) } : {}),
  };
}
