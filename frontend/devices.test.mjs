import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const entry = fileURLToPath(new URL('./src/devices.ts', import.meta.url));
const bundle = await build({ entryPoints: [entry], bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent' });
const m = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].contents).toString('base64'));

test('only explicit device capabilities enable controls', () => {
  assert.equal(m.hasCapability({ capabilities: null }, 'shell'), false);
  assert.equal(m.hasCapability({}, 'rotate'), false);
  assert.equal(m.hasCapability(null, 'audio'), false);
  const phone = { capabilities: ['video', 'logs', 'device-info'] };
  assert.equal(m.hasCapability(phone, 'logs'), true);
  assert.equal(m.hasCapability(phone, 'shell'), false);
  assert.equal(m.hasCapability({ capabilities: [] }, 'video'), false);
});

const host = (id, extra, devices) => ({ id, name: id, status: 'online', disabled: false, lastSeenAt: new Date().toISOString(), devices, ...extra });
const dev = (id, state, kind = 'usb-android') => ({ kind, id, model: id, state, reason: state === 'quarantined' ? 'wipe failed' : null });

test('only free devices on online, enabled hosts are rentable; quarantined ones are listed with the reason', () => {
  const hosts = [
    host('a', {}, [dev('1', 'free'), dev('2', 'busy'), dev('3', 'cleaning'), dev('4', 'quarantined')]),
    host('b', { status: 'offline' }, [dev('5', 'free')]),
    host('c', { disabled: true }, [dev('6', 'free')]),
  ];
  assert.deepEqual(m.rentableDevices(hosts).map(x => x.device.id), ['1']);
  const quarantined = m.physicalDevices(hosts[0].devices).filter(device => device.state === 'quarantined');
  assert.deepEqual(quarantined.map(device => [device.id, device.reason]), [['4', 'wipe failed']]);
  assert.equal(m.deviceStateLabel('quarantined'), 'Карантин');
  assert.equal(m.deviceStateLabel('weird'), 'weird');
});


test('physical inventory excludes emulator capacity records and keeps unverified phones out of rentals', () => {
  const records = [
    { id: 'slots', free: 2, total: 3 },
    { kind: 'emulator', id: 'slots', state: 'free' },
    null,
    { kind: 'usb-android', id: '  ', state: 'free' },
    { kind: 'usb-android', id: 'pending' },
    dev('phone', 'free'),
  ];
  assert.deepEqual(m.physicalDevices(records).map(d => [d.id, d.state]), [['pending', 'unverified'], ['phone', 'free']]);
  assert.deepEqual(m.physicalDevices(null), []);
  assert.deepEqual(m.rentableDevices([host('node', {}, records)]).map(x => x.device.id), ['phone']);
});

test('stale nodes and failed USB inventory cannot offer old free devices; quarantine and busy reservations survive', () => {
  const stale = host('stale', { lastSeenAt: new Date(Date.now() - 46_000).toISOString() }, [dev('phone', 'free')]);
  assert.deepEqual(m.rentableDevices([stale]), []);
  assert.equal(m.inventoryDeviceState(stale, dev('phone', 'free')), 'offline');
  assert.equal(m.inventoryDeviceState(stale, dev('phone', 'quarantined')), 'quarantined');
  assert.equal(m.inventoryDeviceState(stale, dev('phone', 'busy')), 'busy');
  const failure = host('usb', { providers: [{ kind: 'usb-android', status: 'unavailable' }] }, [dev('phone', 'free')]);
  assert.deepEqual(m.rentableDevices([failure]), []);
  assert.equal(m.inventoryDeviceState(failure, failure.devices[0]), 'offline');
  failure.providers[0].status = 'ready'; assert.equal(m.rentableDevices([failure]).length, 1);
});
