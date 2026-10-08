import test from 'node:test';
import assert from 'node:assert/strict';
import { AdbServerFilter } from './adb-proxy.mjs';

const request = (service) => Buffer.from(`${Buffer.byteLength(service).toString(16).padStart(4, '0')}${service}`);

test('ADB proxy rewrites transport to the assigned emulator', () => {
  const filter = new AdbServerFilter('rdf-owned:5555');
  assert.deepEqual(filter.transform(request('host:transport:other:5555')), [request('host:transport:rdf-owned:5555')]);
  assert.deepEqual(filter.fromServer(Buffer.from('OKAY')), { toClient: [Buffer.from('OKAY')], toServer: [] });
  assert.deepEqual(filter.transform(request('shell:id')), [request('shell:id')]);
  assert.deepEqual(filter.fromServer(Buffer.from('OKAY')), { toClient: [Buffer.from('OKAY')], toServer: [] });
  assert.deepEqual(filter.transform(Buffer.from('raw shell bytes')), [Buffer.from('raw shell bytes')]);
});

test('ADB proxy denies host management and cross-device services', () => {
  for (const service of ['host:connect:other:5555', 'host:kill', 'host:transport-id:2', 'host-serial:other:5555:forward:tcp:1;tcp:2']) {
    assert.throws(() => new AdbServerFilter('rdf-owned:5555').transform(request(service)));
  }
});

test('ADB proxy buffers partial service frames and permits one read-only host query', () => {
  const filter = new AdbServerFilter('rdf-owned:5555');
  const bytes = request('host:devices-l');
  assert.deepEqual(filter.transform(bytes.subarray(0, 3)), []);
  assert.deepEqual(filter.transform(bytes.subarray(3)), []);
  assert.equal(filter.syntheticResponse.toString(), 'OKAY0016rdf-owned:5555\tdevice\n');
  assert.throws(() => filter.transform(request('host:connect:other:5555')));
});

test('failed transport cannot be reused for a host command', () => {
  const filter = new AdbServerFilter('rdf-owned:5555');
  filter.transform(request('host:transport:other:5555'));
  assert.deepEqual(filter.transform(request('host:connect:other:5555')), []);
  filter.fromServer(Buffer.from('FAIL0000'));
  assert.throws(() => filter.transform(request('host:connect:other:5555')));
});

test('host services are denied after a successful transport', () => {
  const filter = new AdbServerFilter('rdf-owned:5555');
  filter.transform(request('host:transport-any'));
  filter.fromServer(Buffer.from('OKAY'));
  assert.throws(() => filter.transform(request('host:connect:other:5555')));
});

test('ADB reverse cannot expose the agent localhost to an emulator', () => {
  for (const service of ['reverse:forward:tcp:8080;tcp:5037', 'reverse:list-forward', 'host-local:devices']) {
    const filter = new AdbServerFilter('rdf-owned:5555');
    filter.transform(request('host:transport-any'));
    filter.fromServer(Buffer.from('OKAY'));
    assert.throws(() => filter.transform(request(service)));
  }
});

test('after transport selection the tunnel refuses services that change how the phone can be reached', () => {
  for (const service of ['tcpip:5555', 'usb:', 'root:', 'unroot:', 'remount:', 'disable-verity:', 'enable-verity:', 'sideload:1', 'restore:', 'reboot:bootloader', 'reboot:recovery', 'reboot:fastboot']) {
    const filter = new AdbServerFilter('R58M');
    filter.transform(request('host:transport:R58M'));
    filter.fromServer(Buffer.from('OKAY'));
    assert.throws(() => filter.transform(request(service)), /not available through the session tunnel/, service);
  }
  for (const service of ['shell:id', 'reboot:', 'sync:', 'exec:ls']) {
    const filter = new AdbServerFilter('R58M');
    filter.transform(request('host:transport:R58M'));
    filter.fromServer(Buffer.from('OKAY'));
    assert.deepEqual(filter.transform(request(service)), [request(service)], service);
  }
});

test('a tunnel to a shared adb server cannot see or select any other phone', () => {
  const list = new AdbServerFilter('R58M');
  list.transform(request('host:devices-l'));
  assert.equal(list.syntheticResponse.toString().includes('R58M\tdevice'), true);
  assert.equal(list.syntheticResponse.toString().includes('OTHER'), false);
  for (const service of ['host:track-devices', 'host:tport:serial:OTHER', 'host:connect:1.2.3.4:5555', 'host:kill', 'host:forward:tcp:1;tcp:2', 'host-serial:OTHER:forward:tcp:1;tcp:2']) {
    assert.throws(() => new AdbServerFilter('R58M').transform(request(service)), undefined, service);
  }
  const other = new AdbServerFilter('R58M');
  assert.deepEqual(other.transform(request('host:transport:OTHER')), [request('host:transport:R58M')]);
});
