import fs from 'node:fs';
import YAML from 'yaml';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { operationKey } from './api-sources.mjs';

export function readContract() {
  return YAML.parse(fs.readFileSync(new URL('../../../docs/api/openapi.yaml', import.meta.url), 'utf8'));
}
const methods = ['get', 'post', 'put', 'patch', 'delete'];
export function documentedOperations(doc) {
  return Object.entries(doc.paths).flatMap(([path, item]) =>
    methods
      .filter((method) => item[method])
      .map((method) => ({
        method: method.toUpperCase(),
        path,
        operation: item[method],
        parameters: item.parameters ?? [],
      })),
  );
}
export function checkCoverage(server, client, doc) {
  const documented = new Set(
    documentedOperations(doc)
      .filter((op) => !op.operation['x-external'])
      .map((op) => operationKey(op.method, op.path)),
  );
  const implemented = new Set(server.map((op) => operationKey(op.method, op.path)));
  const failures = [];
  for (const op of server)
    if (!documented.has(operationKey(op.method, op.path)))
      failures.push(`Undocumented server operation: ${op.method} ${op.path}`);
  for (const op of documented)
    if (!implemented.has(op)) failures.push(`Documented operation without a server route: ${op}`);
  for (const op of client)
    if (
      !implemented.has(operationKey(op.method, op.path)) ||
      !documented.has(operationKey(op.method, op.path))
    )
      failures.push(`Client operation has no server/OpenAPI match: ${op.method} ${op.path}`);
  return failures;
}

export function schemaValidator(doc) {
  const ajv = new Ajv({ strict: false, allErrors: true });
  addFormats(ajv);
  const normalize = (value) => {
    if (Array.isArray(value)) return value.map(normalize);
    if (!value || typeof value !== 'object') return value;
    const result = Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !['example', 'discriminator', 'xml', 'externalDocs'].includes(key))
        .map(([key, v]) => [key, normalize(v)]),
    );
    if (result.$ref) result.$ref = result.$ref.replace('#/components/schemas/', '#/$defs/');
    if (result.nullable && result.type) {
      result.type = [result.type, 'null'];
      if (result.enum) result.enum = [...new Set([...result.enum, null])];
    }
    delete result.nullable;
    return result;
  };
  const defs = normalize(doc.components.schemas);
  const cache = new Map();
  return (schema) => {
    const key = JSON.stringify(schema);
    if (!cache.has(key)) cache.set(key, ajv.compile({ ...normalize(schema), $defs: defs }));
    return cache.get(key);
  };
}

export function pathPattern(path) {
  return new RegExp(
    '^' +
      path
        .split(/(\{[^}]+\}|:[A-Za-z]\w*)/)
        .map((part) => (/^(\{|:)/.test(part) ? '([^/]+)' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
        .join('') +
      '$',
  );
}

export function createContractValidator(doc = readContract()) {
  const compile = schemaValidator(doc);
  // Literal routes precede path parameters, as in the production router.
  const routes = documentedOperations(doc).sort(
    (a, b) => (a.path.match(/\{/g)?.length ?? 0) - (b.path.match(/\{/g)?.length ?? 0),
  );
  return ({ method, url, status, contentType = 'application/json', body, requestBody }) => {
    const requestUrl = new URL(url, 'http://localhost');
    const pathname = requestUrl.pathname;
    const match = routes.find(
      (op) => op.method === method.toUpperCase() && pathPattern(op.path).test(pathname),
    );
    if (!match) return [`Undocumented operation: ${method} ${pathname}`];
    const errors = [];
    const validate = (schema, data, label) => {
      const check = compile(schema);
      if (!check(data)) errors.push(`${label}: ${JSON.stringify(check.errors)}`);
    };
    if (status < 400) {
      const captures = pathPattern(match.path).exec(pathname)?.slice(1) ?? [];
      const names = [...match.path.matchAll(/\{([^}]+)\}/g)].map((item) => item[1]);
      for (const raw of [...match.parameters, ...(match.operation.parameters ?? [])]) {
        const parameter = raw.$ref ? doc.components.parameters[raw.$ref.split('/').at(-1)] : raw;
        if (!['path', 'query'].includes(parameter.in)) continue;
        let value =
          parameter.in === 'path'
            ? captures[names.indexOf(parameter.name)]
            : requestUrl.searchParams.get(parameter.name);
        if (value == null) {
          if (parameter.required) errors.push(`Missing ${parameter.in} parameter: ${parameter.name}`);
          continue;
        }
        const schema = parameter.schema;
        if (schema?.type === 'integer' || schema?.type === 'number')
          value = value.trim() ? Number(value) : NaN;
        else if (schema?.type === 'boolean' && ['true', 'false'].includes(value)) value = value === 'true';
        else if (parameter.in === 'path') value = decodeURIComponent(value);
        if (schema) validate(schema, value, `${parameter.in} ${parameter.name}`);
      }
      if (
        requestBody === undefined &&
        match.operation.requestBody?.required &&
        match.operation.requestBody.content?.['application/json']
      )
        errors.push('Missing JSON request body');
    }
    if (requestBody !== undefined) {
      const schema = match.operation.requestBody?.content?.['application/json']?.schema;
      if (!schema) errors.push('JSON request body is undocumented');
      else validate(schema, requestBody, 'request');
    }
    const rawResponse =
      match.operation.responses[String(status)] ??
      (status >= 400 ? match.operation.responses.default : undefined);
    if (!rawResponse) return [...errors, `Undocumented response status: ${status}`];
    const response = rawResponse.$ref
      ? doc.components.responses[rawResponse.$ref.split('/').at(-1)]
      : rawResponse;
    const mediaType = contentType.split(';')[0];
    const schema = response.content?.[mediaType]?.schema;
    if (response.content && !schema) errors.push(`Undocumented response content type: ${mediaType}`);
    if (schema) validate(schema, body, 'response');
    return errors;
  };
}
