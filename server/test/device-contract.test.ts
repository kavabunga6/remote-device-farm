import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import Ajv from 'ajv';
import { normalizeProviderStatuses, sessionCapabilities, normalizeCapabilities, normalizePhysicalDevices, physicalDevicesFromProviderReports } from '../src/generated/device-contract.js';
import * as agent from '../../agent/src/generated/device-contract.mjs';
import * as mcp from '../../integrations/mcp/src/device-contract.mjs';
import { readContract, schemaValidator } from './support/openapi-contract.mjs';

const schema = JSON.parse(readFileSync(new URL('../../shared/device-contract.schema.json', import.meta.url), 'utf8'));
const validate = new Ajv({ strict: false, allErrors: true }).compile({
  ...schema, $ref: '#/definitions/DeviceDescriptor',
});
const phone = { kind: 'usb-android', platform: 'android', id: 'phone-1', model: 'Phone', state: 'free', reason: null };

test('generated device consumers and OpenAPI stay synchronized with the authoritative schema', () => {
  execFileSync(process.execPath, ['scripts/sync-device-contract.mjs', '--check'], { cwd: new URL('../../', import.meta.url), stdio: 'pipe' });
});

test('provider, API and MCP normalize the same legacy and enriched inventory without leaking unknown fields', () => {
  const devices = [phone, { ...phone, id: 'second', osVersion: '16', sdkLevel: 36,
    capabilities: ['video', 'audio', 'shell', 'shell', 'unknown-action'],
    capabilityReasons: { audio: 'android-version-unsupported', shell: 'not-supported', files: 'device secret', admin: 'not-supported' },
    password: 'device-controlled-secret', state: 'unrecognized-state' }];
  const expected = [phone, { ...phone, id: 'second', state: 'unverified', osVersion: '16', sdkLevel: 36,
    capabilities: ['video', 'audio', 'shell'], capabilityReasons: { audio: 'android-version-unsupported', shell: 'not-supported' } }];
  for (const consumer of [{ normalizePhysicalDevices }, agent, mcp]) {
    const normalized = consumer.normalizePhysicalDevices(devices);
    assert.deepEqual(normalized, expected);
    for (const device of normalized) assert.ok(validate(device), JSON.stringify(validate.errors));
    const doc = readContract();
    const hostDevices = schemaValidator(doc)(doc.components.schemas.getHostsResponseHostsItem.properties.devices);
    assert.ok(hostDevices(normalized), JSON.stringify(hostDevices.errors));
  }
});

test('unknown platforms, provider kinds and capacity records never become rentable devices', () => {
  assert.deepEqual(normalizePhysicalDevices([null, [], 'phone', { id: 'slots' },
    { ...phone, kind: 'emulator' }, { ...phone, platform: 'other-platform' },
    { ...phone, id: 'bad\nserial' }, { ...phone, id: ' ' }]), []);
  assert.deepEqual(physicalDevicesFromProviderReports([{ kind: 'usb-android', platform: 'other-platform', devices: [phone] }]), []);
  assert.deepEqual(physicalDevicesFromProviderReports([{ kind: 'usb-android', devices: [{ id: 'legacy', state: 'free' }] }]),
    [{ ...phone, id: 'legacy', model: null }]);
  assert.deepEqual(normalizeCapabilities(['files', '__proto__', 'admin', 1, 'video', 'files']), ['files', 'video']);
});

test('only known legacy emulator records get compatibility capabilities', () => {
  assert.deepEqual(sessionCapabilities('usb-android', null), []);
  assert.deepEqual(sessionCapabilities('unknown', ['shell']), []);
  assert.equal(sessionCapabilities('emulator', null).includes('shell'), true);
  assert.equal(sessionCapabilities('emulator', null).includes('audio'), false);
  assert.deepEqual(sessionCapabilities('emulator', []), []);
});

test('provider health has the same bounded schema in every consumer and OpenAPI', () => {
  const input = [
    { kind: 'emulator', platform: 'android', status: 'ready', code: null },
    { kind: 'usb-android', platform: 'android', status: 'unavailable', code: 'inventory-unavailable', diagnostic: 'private-data' },
    { kind: 'unknown', status: 'ready' },
    { kind: 'usb-android', status: 'ready' },
  ];
  const expected = [
    { kind: 'emulator', platform: 'android', status: 'ready', code: null },
    { kind: 'usb-android', platform: 'android', status: 'unavailable', code: 'inventory-unavailable' },
  ];
  const doc = readContract();
  const valid = schemaValidator(doc)(doc.components.schemas.DeviceProviderStatus);
  for (const consumer of [{ normalizeProviderStatuses }, agent, mcp]) {
    assert.deepEqual(consumer.normalizeProviderStatuses(input), expected);
    for (const status of consumer.normalizeProviderStatuses(input)) assert.ok(valid(status), JSON.stringify(valid.errors));
  }
  assert.deepEqual(normalizeProviderStatuses([{ kind: 'emulator', status: 'device-controlled', code: 'private-data' }]),
    [{ kind: 'emulator', platform: 'android', status: 'unknown', code: null }]);
});
