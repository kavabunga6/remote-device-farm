#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(root, 'server/package.json'));
const ts = require('typescript');
const schema = JSON.parse(fs.readFileSync(path.join(root, 'shared/device-contract.schema.json'), 'utf8'));
const defs = schema.definitions;
const constants = {
  DevicePlatform: 'DEVICE_PLATFORMS', DeviceKind: 'DEVICE_KINDS', PhysicalDeviceKind: 'PHYSICAL_DEVICE_KINDS',
  DeviceCapability: 'DEVICE_CAPABILITIES', DeviceAvailability: 'DEVICE_AVAILABILITIES',
  DeviceCapabilityReason: 'DEVICE_CAPABILITY_REASONS',
};
function type(s) {
  if (s.$ref) {
    const name = s.$ref.match(/^#\/definitions\/([A-Za-z]+)$/)?.[1];
    if (!name || !Object.hasOwn(defs, name)) throw new Error('Unsupported contract reference');
    return name;
  }
  if (s.enum) return s.enum.map(v => JSON.stringify(v)).join(' | ');
  if (Array.isArray(s.type)) return s.type.map(t => type({ ...s, type: t })).join(' | ');
  if (s.type === 'array') return 'Array<' + type(s.items) + '>';
  if (s.type === 'object') {
    if (!s.properties) return 'Record<string, ' + type(s.additionalProperties) + '>';
    return '{\n' + Object.entries(s.properties).map(([key, v]) => '  ' + key +
      (s.required?.includes(key) ? '' : '?') + ': ' + type(v) + ';').join('\n') + '\n}';
  }
  if (s.type === 'integer' || s.type === 'number') return 'number';
  if (['string', 'boolean', 'null'].includes(s.type)) return s.type;
  throw new Error('Unsupported device contract type');
}
const declarations = 'export const DEVICE_CONTRACT_VERSION = ' + schema['x-version'] + ' as const;\n' +
  Object.entries(defs).map(([name, s]) => constants[name]
    ? 'export const ' + constants[name] + ' = ' + JSON.stringify(s.enum) + ' as const;\nexport type ' + name + ' = typeof ' + constants[name] + '[number];'
    : 'export type ' + name + ' = ' + type(s) + ';').join('\n');
const runtime = fs.readFileSync(path.join(root, 'shared/device-contract-runtime.ts'), 'utf8').replaceAll('\r\n', '\n')
  .replace('// @device-contract-declarations', declarations);
const header = '// Generated from shared/device-contract.schema.json and device-contract-runtime.ts.\n// Run node scripts/sync-device-contract.mjs to update.\n';
const javascript = ts.transpileModule(runtime, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText.replaceAll('\r\n', '\n');
const files = {
  'server/src/generated/device-contract.ts': header + runtime,
  'frontend/src/generated/device-contract.ts': header + runtime,
  'agent/src/generated/device-contract.mjs': header + javascript,
  'integrations/mcp/src/device-contract.mjs': header + javascript,
};
function openapi(value) {
  if (Array.isArray(value)) return value.map(openapi);
  if (!value || typeof value !== 'object') return value;
  const out = Object.fromEntries(Object.entries(value).map(([key, v]) => [key,
    key === '$ref' ? v.replace('#/definitions/', '#/components/schemas/') : openapi(v)]));
  if (Array.isArray(out.type) && out.type.length === 2 && out.type.includes('null')) {
    out.type = out.type.find(t => t !== 'null'); out.nullable = true;
  }
  return out;
}
const target = 'docs/api/openapi.yaml';
const original = fs.readFileSync(path.join(root, target), 'utf8').replaceAll('\r\n', '\n');
const block = '    # device-contract:start\n' + Object.entries(defs)
  .map(([name, s]) => '    ' + name + ': ' + JSON.stringify(openapi(s)) + '\n').join('') + '    # device-contract:end\n';
files[target] = original.includes('    # device-contract:start\n')
  ? original.replace(/    # device-contract:start\n[\s\S]*?    # device-contract:end\n/, block)
  : original.replace('  schemas:\n', '  schemas:\n' + block);
for (const [name, content] of Object.entries(files)) {
  const file = path.join(root, name);
  if (process.argv.includes('--check')) {
    if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8').replaceAll('\r\n', '\n') !== content) throw new Error('Stale device contract: ' + name);
  } else { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); }
}
console.log('Device contract and generated consumers verified.');
