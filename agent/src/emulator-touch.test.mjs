import test from 'node:test';
import assert from 'node:assert/strict';
import http2 from 'node:http2';
import { decodeEmulatorGeometry, emulatorTouchHost, encodeEmulatorTouch, mapEmulatorTouch, EmulatorTouchController } from './emulator-touch.mjs';

const SERIAL = 'rdf-11111111-2222-3333-4444-555555555555:5555';
function uint(value) {
  const bytes = [];
  do { let b = value & 127; value = Math.floor(value / 128); if (value) b |= 128; bytes.push(b); } while (value);
  return Buffer.from(bytes);
}
function blob(id, value) {
  value = Buffer.from(value);
  return Buffer.concat([uint(id * 8 + 2), uint(value.length), value]);
}
function status(width = '1080', height = '1920') {
  return blob(5, Buffer.concat([
    blob(1, Buffer.concat([blob(1, 'hw.lcd.width'), blob(2, width)])),
    blob(1, Buffer.concat([blob(1, 'hw.lcd.height'), blob(2, height)])),
  ]));
}
function frame(value) {
  const result = Buffer.alloc(value.length + 5);
  result.writeUInt32BE(value.length, 1); value.copy(result, 5); return result;
}
function read(bytes) {
  let offset = 0;
  const fields = [];
  const next = () => { let value = 0, shift = 0, byte; do { byte = bytes[offset++]; value += (byte & 127) * 2 ** shift; shift += 7; } while (byte & 128); return value; };
  while (offset < bytes.length) {
    const tag = next();
    let value;
    if ((tag & 7) === 2) { const size = next(); value = bytes.subarray(offset, offset + size); offset += size; }
    else value = next();
    fields.push([tag >>> 3, value]);
  }
  return fields;
}
function touches(body) {
  return read(body).map(([, bytes]) => {
    const p = new Map(read(bytes));
    return { x: p.get(1), y: p.get(2), pointerId: p.get(3), pressure: p.get(4) };
  });
}
function respond(stream, body = Buffer.alloc(0), code = '0') {
  if (stream.destroyed || stream.closed) return;
  stream.respond({ ':status': 200, 'content-type': 'application/grpc' }, { waitForTrailers: true });
  stream.on('wantTrailers', () => stream.sendTrailers({ 'grpc-status': code }));
  stream.end(frame(body));
}
async function until(predicate) {
  const deadline = Date.now() + 1500;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Expected native touch event was not received');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
async function fixture(t, { touch, geometry = status(), timeoutMs = 200, maxQueueAgeMs = 500, now = Date.now } = {}) {
  const requests = [];
  const failures = [];
  const server = http2.createServer();
  const sessions = new Set();
  let connects = 0;
  server.on('session', session => { sessions.add(session); session.on('error', () => {}); });
  server.on('stream', (stream, headers) => {
    stream.on('error', () => {});
    let bytes = Buffer.alloc(0);
    stream.on('data', chunk => { bytes = Buffer.concat([bytes, chunk]); });
    stream.on('end', () => {
      assert.equal(bytes[0], 0);
      assert.equal(bytes.readUInt32BE(1), bytes.length - 5);
      const method = headers[':path'].split('/').at(-1);
      const body = bytes.subarray(5);
      requests.push({ method, body, points: method === 'sendTouch' ? touches(body) : [] });
      if (method === 'getStatus') respond(stream, geometry);
      else if (!body.length) respond(stream);
      else if (touch) touch(stream, touches(body));
      else respond(stream);
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const controller = new EmulatorTouchController({ serial: SERIAL, timeoutMs, maxQueueAgeMs, now, onFailure: error => failures.push(error), connect: address => {
    assert.equal(address, 'http://rdf-11111111-2222-3333-4444-555555555555:8554');
    connects++;
    return http2.connect('http://127.0.0.1:' + server.address().port);
  } });
  t.after(async () => {
    await controller.close();
    for (const session of sessions) session.destroy();
    await new Promise(resolve => server.close(resolve));
  });
  return { controller, requests, failures, connections: () => connects };
}
const point = (action, x = 100, y = 200, pointerId = 0) => ({ action, x, y, width: 540, height: 960, pointerId });

test('validates the managed endpoint, metadata, and touch protobuf including zero-pressure releases', () => {
  assert.equal(emulatorTouchHost(SERIAL), 'rdf-11111111-2222-3333-4444-555555555555');
  assert.throws(() => emulatorTouchHost('localhost:8554'), /Invalid managed emulator/);
  assert.throws(() => emulatorTouchHost(SERIAL.replace(':5555', '.example:5555')), /Invalid managed emulator/);
  assert.deepEqual(decodeEmulatorGeometry(status()), { width: 1080, height: 1920 });
  assert.throws(() => decodeEmulatorGeometry(status('0')), /Invalid emulator display geometry/);
  assert.throws(() => decodeEmulatorGeometry(Buffer.from([0x2a, 0x80])), /protobuf/);
  const input = [{ x: 108, y: 200, pointerId: 7, pressure: 1024 }, { x: 20, y: 30, pointerId: 9, pressure: 0 }];
  assert.deepEqual(touches(encodeEmulatorTouch(input)), input);
  assert.throws(() => encodeEmulatorTouch([{ ...input[0], x: -1 }]), /Invalid native touch contact/);
});

test('maps all four actual Android rotations and letterboxed physical viewports', () => {
  const position = { x: 0, y: 0, width: 540, height: 960 };
  const expected = [{ x: 0, y: 0 }, { x: 1079, y: 0 }, { x: 1079, y: 1919 }, { x: 0, y: 1919 }];
  for (let rotation = 0; rotation < 4; rotation++) {
    assert.deepEqual(mapEmulatorTouch(position, { width: 1080, height: 1920, rotation }), expected[rotation]);
  }
  assert.deepEqual(mapEmulatorTouch(position, { width: 1080, height: 1920, rotation: 0,
    physicalFrame: { left: 100, top: 200, right: 980, bottom: 1720 } }), { x: 100, y: 200 });
  assert.deepEqual(mapEmulatorTouch(position, { width: 1080, height: 1920, rotation: 1,
    physicalFrame: { left: 100, top: 200, right: 1820, bottom: 880 } }), { x: 879, y: 100 });
  assert.throws(() => mapEmulatorTouch(position, { width: 1080, height: 1920 }), /orientation/);
  assert.throws(() => mapEmulatorTouch({ ...position, x: 540 }, { width: 1080, height: 1920, rotation: 0 }), /coordinates/);
});

test('probes metadata and sendTouch without contacts on one connection; requires explicit actual rotation', async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.controller.prepare(), { width: 1080, height: 1920, rotation: null });
  assert.equal(f.controller.isAvailable(), false);
  assert.equal(f.controller.sendTouch(point('down')), false);
  assert.deepEqual(f.requests.map(r => r.method), ['getStatus', 'sendTouch']);
  assert.deepEqual(f.requests[1].points, []);
  f.controller.setGeometry({ rotation: 0 });
  assert.equal(f.controller.isAvailable(), true);
  assert.equal(f.controller.sendTouch(point('down')), true);
  await until(() => f.requests.length === 3);
  assert.equal(f.controller.sendTouch(point('up')), true);
  await until(() => f.requests.length === 4 && !f.controller.draining);
  assert.equal(f.connections(), 1);
  assert.deepEqual(f.requests.slice(2).map(r => r.points[0].pressure), [1024, 0]);
  assert.deepEqual(f.failures, []);
});

test('coalesces moves behind a slow RPC while preserving ordered down/up and original gesture geometry', async t => {
  let held;
  const f = await fixture(t, { touch: (stream, points) => {
    if (!held && points[0].pressure) held = stream;
    else respond(stream);
  } });
  await f.controller.prepare(); f.controller.setGeometry({ rotation: 0 });
  f.controller.sendTouch(point('down'));
  await until(() => held);
  for (let i = 0; i < 1000; i++) f.controller.sendTouch(point('move', i % 500, 300));
  assert.equal(f.controller.queue.length, 1);
  f.controller.setGeometry({ rotation: 2 });
  f.controller.sendTouch(point('up', 499, 300));
  respond(held);
  await until(() => f.requests.length === 5 && !f.controller.draining);
  const events = f.requests.slice(2).flatMap(r => r.points);
  assert.deepEqual(events.map(p => p.pressure), [1024, 1024, 0]);
  assert.deepEqual(events[1], { ...events[2], pressure: 1024 });
  assert.deepEqual({ x: events[2].x, y: events[2].y }, mapEmulatorTouch(point('up', 499, 300), { width: 1080, height: 1920, rotation: 0 }));
});

test('cancel needs no coordinates and close releases an in-flight contact without sending queued moves', async t => {
  const f = await fixture(t);
  await f.controller.prepare(); f.controller.setGeometry({ rotation: 0 });
  f.controller.sendTouch(point('down'));
  await until(() => !f.controller.draining);
  assert.equal(f.controller.sendTouch({ action: 'cancel' }), true);
  await until(() => !f.controller.draining);
  assert.deepEqual(f.requests.slice(2).map(r => r.points[0].pressure), [1024, 0]);
  f.controller.sendTouch(point('down', 40, 50));
  f.controller.sendTouch(point('move', 60, 70));
  await f.controller.close();
  assert.deepEqual(f.requests.slice(4).map(r => r.points[0].pressure), [1024, 0]);
  assert.equal(f.controller.isAvailable(), false);
});

test('unknown delivery fails closed, cleans up even a queued up, and never replays the down', async t => {
  let count = 0;
  const f = await fixture(t, { touch: stream => respond(stream, Buffer.alloc(0), ++count === 1 ? '13' : '0') });
  await f.controller.prepare(); f.controller.setGeometry({ rotation: 0 });
  assert.equal(f.controller.sendTouch(point('down')), true);
  assert.equal(f.controller.sendTouch(point('move', 101, 201)), true);
  assert.equal(f.controller.sendTouch(point('up', 101, 201)), true);
  await until(() => f.controller.closed);
  assert.equal(f.failures.length, 1);
  assert.deepEqual(f.requests.slice(2).map(r => r.points[0].pressure), [1024, 0]);
  assert.equal(f.controller.sendTouch(point('down')), false);
  assert.equal(f.connections(), 1);
});

test('a failed ongoing gesture remains owned until release and cannot fall back midway', async t => {
  let count = 0;
  const f = await fixture(t, { touch: stream => respond(stream, Buffer.alloc(0), ++count === 1 ? '13' : '0') });
  await f.controller.prepare(); f.controller.setGeometry({ rotation: 0 });
  f.controller.sendTouch(point('down'));
  await until(() => f.controller.closed);
  assert.equal(f.controller.ownedPointers.has(0), true);
  assert.equal(f.controller.sendTouch(point('move')), true);
  assert.equal(f.controller.sendTouch(point('up')), true);
  assert.equal(f.controller.ownedPointers.has(0), false);
  assert.equal(f.controller.sendTouch(point('down')), false);
});

test('rejects missing geometry, times out stuck requests, and refuses preparation after close', async t => {
  const f = await fixture(t, { geometry: Buffer.alloc(0) });
  await assert.rejects(f.controller.prepare(), /display geometry/);
  assert.equal(f.controller.isAvailable(), false);
  await f.controller.close();
  await assert.rejects(f.controller.prepare(), /closed/);
  const stalled = await fixture(t, { timeoutMs: 25, touch: () => {} });
  await stalled.controller.prepare(); stalled.controller.setGeometry({ rotation: 0 });
  stalled.controller.sendTouch(point('down'));
  await until(() => stalled.controller.closed);
  assert.match(stalled.failures[0].message, /timed out/);
});


test('bounds a backlog of complete gestures and reserves releases for every accepted down', async t => {
  let held;
  const f = await fixture(t, { touch: (stream, points) => {
    if (!held && points[0].pressure) held = stream;
    else respond(stream);
  } });
  await f.controller.prepare(); f.controller.setGeometry({ rotation: 0 });
  f.controller.sendTouch(point('down'));
  await until(() => held);
  f.controller.sendTouch(point('up'));
  let accepted = 1;
  for (let i = 0; i < 1000; i++) {
    if (f.controller.sendTouch(point('down'))) {
      accepted++;
      assert.equal(f.controller.sendTouch(point('up')), true);
    }
  }
  assert.ok(f.controller.queue.length <= 64);
  assert.ok(accepted < 40);
  respond(held);
  await until(() => !f.controller.draining);
  const events = f.requests.slice(2).flatMap(r => r.points);
  assert.equal(events.length, accepted * 2);
  assert.deepEqual(events.map(p => p.pressure), Array.from({ length: accepted }, () => [1024, 0]).flat());
});


test('reset waits for an uncertain down, drops queued gestures, releases once, and reuses the connection', async t => {
  let held;
  const f = await fixture(t, {touch: (stream, points) => {
    if (!held && points[0].pressure) held = stream;
    else respond(stream);
  }});
  await f.controller.prepare(); f.controller.setGeometry({rotation: 0});
  f.controller.sendTouch(point('down'));
  await until(() => held);
  f.controller.sendTouch(point('move', 101, 201));
  f.controller.sendTouch(point('up', 101, 201));
  f.controller.sendTouch(point('down', 200, 300, 1));
  const reset = f.controller.releaseInput();
  assert.equal(f.controller.releaseInput(), reset);
  assert.equal(f.controller.sendTouch(point('down', 200, 300, 2)), false);
  assert.equal(f.controller.ownedPointers.has(1), false);
  assert.equal(f.controller.queue.length, 0);
  respond(held);
  await reset;
  const points = f.requests.flatMap(request => request.points);
  assert.equal(points.length, 2);
  assert.deepEqual(points.map(p => [p.pointerId, p.pressure]), [[0, 1024], [0, 0]]);
  assert.equal(f.controller.isAvailable(), true);
  assert.equal(f.connections(), 1);
  await f.controller.releaseInput();
  assert.equal(f.requests.flatMap(request => request.points).length, 2);
  assert.equal(f.controller.sendTouch(point('down', 80, 90)), true);
  assert.equal(f.controller.sendTouch(point('up', 80, 90)), true);
  await until(() => f.requests.flatMap(request => request.points).length === 4);
  assert.equal(f.connections(), 1);
});

test('expired queued down is never injected and an already delivered contact is released', async t => {
  let held, now = 0;
  const f = await fixture(t, {now: () => now, maxQueueAgeMs: 500, touch: (stream, points) => {
    if (!held && points[0].pressure) held = stream;
    else respond(stream);
  }});
  await f.controller.prepare(); f.controller.setGeometry({rotation: 0});
  f.controller.sendTouch(point('down'));
  await until(() => held);
  f.controller.sendTouch(point('down', 200, 300, 1));
  now = 501;
  respond(held);
  await until(() => f.controller.closed);
  const points = f.requests.flatMap(request => request.points);
  assert.deepEqual(points.filter(p => p.pressure).map(p => p.pointerId), [0]);
  assert.ok(points.some(p => p.pointerId === 0 && p.pressure === 0));
  assert.equal(f.failures.length, 1);
  assert.equal(f.failures[0].code, 'INPUT_EXPIRED');
});

test('stale moves are discarded but the release of a delivered contact is never expired', async t => {
  let held, now = 0;
  const f = await fixture(t, {now: () => now, maxQueueAgeMs: 500, touch: (stream, points) => {
    if (!held && points[0].pressure) held = stream;
    else respond(stream);
  }});
  await f.controller.prepare(); f.controller.setGeometry({rotation: 0});
  f.controller.sendTouch(point('down'));
  await until(() => held);
  f.controller.sendTouch(point('move', 200, 300));
  f.controller.sendTouch(point('up', 200, 300));
  now = 501; respond(held);
  await until(() => f.requests.flatMap(request => request.points).length === 2);
  assert.deepEqual(f.requests.flatMap(request => request.points).map(p => p.pressure), [1024, 0]);
  assert.equal(f.failures.length, 0);
  assert.equal(f.controller.isAvailable(), true);
});


test('native RPC queue respects the earlier trusted end-to-end input deadline', async t => {
  let held, now = 1000;
  const f = await fixture(t, {now: () => now, touch: (stream, points) => {
    if (!held && points[0].pressure) held = stream; else respond(stream);
  }});
  await f.controller.prepare(); f.controller.setGeometry({rotation: 0});
  f.controller.sendTouch(point('down')); await until(() => held);
  f.controller.sendTouch({...point('down', 200, 300, 1), inputDeadline: 1050});
  now = 1051; respond(held);
  await until(() => f.controller.closed);
  assert.deepEqual(f.requests.flatMap(request => request.points).filter(p => p.pressure).map(p => p.pointerId), [0]);
  assert.equal(f.failures[0].code, 'INPUT_EXPIRED');
});
