import { diagnostic } from './diagnostics.mjs';
import http2 from 'node:http2';

const SERVICE = '/android.emulation.control.EmulatorController/';
const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_POINTERS = 10;
const MAX_QUEUE = 64;

function uint(value) {
  const bytes = [];
  do {
    let byte = value & 0x7f;
    value = Math.floor(value / 128);
    if (value) byte |= 0x80;
    bytes.push(byte);
  } while (value);
  return Buffer.from(bytes);
}

function field(id, value) {
  return Buffer.concat([uint(id * 8), uint(value)]);
}

function bytesField(id, value) {
  return Buffer.concat([uint(id * 8 + 2), uint(value.length), value]);
}

function frame(bytes) {
  const result = Buffer.alloc(bytes.length + 5);
  result.writeUInt32BE(bytes.length, 1);
  bytes.copy(result, 5);
  return result;
}

function readFields(bytes) {
  let offset = 0;
  const fields = [];
  const varint = () => {
    let value = 0n;
    for (let shift = 0n; shift < 70n && offset < bytes.length; shift += 7n) {
      const byte = bytes[offset++];
      value |= BigInt(byte & 127) << shift;
      if (!(byte & 128)) return value;
    }
    throw new Error(diagnostic('emulator-touch.6f8e7a3f29'));
  };
  while (offset < bytes.length) {
    const tag = Number(varint());
    const id = tag >>> 3;
    const wire = tag & 7;
    if (!id) throw new Error(diagnostic('emulator-touch.ecd59900ec'));
    if (wire === 0) fields.push([id, varint()]);
    else if (wire === 2) {
      const size = Number(varint());
      if (!Number.isSafeInteger(size) || size > MAX_RESPONSE_BYTES || offset + size > bytes.length) {
        throw new Error(diagnostic('emulator-touch.12cd71dc3f'));
      }
      fields.push([id, bytes.subarray(offset, offset + size)]);
      offset += size;
    } else if (wire === 1 || wire === 5) {
      offset += wire === 1 ? 8 : 4;
      if (offset > bytes.length) throw new Error(diagnostic('emulator-touch.09dbe2a2ba'));
    } else throw new Error(diagnostic('emulator-touch.9cbb1f1748'));
  }
  return fields;
}

function dimension(value) {
  return Number.isInteger(value) && value >= 1 && value <= 16384;
}

export function decodeEmulatorGeometry(bytes) {
  const hardware = readFields(bytes).find(([id, value]) => id === 5 && Buffer.isBuffer(value))?.[1];
  if (!hardware) throw new Error(diagnostic('emulator-touch.9e5bd6be39'));
  const config = new Map();
  for (const [id, entry] of readFields(hardware)) {
    if (id !== 1 || !Buffer.isBuffer(entry)) continue;
    const fields = new Map(readFields(entry));
    if (Buffer.isBuffer(fields.get(1)) && Buffer.isBuffer(fields.get(2))) {
      config.set(fields.get(1).toString(), fields.get(2).toString());
    }
  }
  const width = Number(config.get('hw.lcd.width'));
  const height = Number(config.get('hw.lcd.height'));
  if (!dimension(width) || !dimension(height)) throw new Error(diagnostic('emulator-touch.d4c1d919e1'));
  return { width, height };
}

export function emulatorTouchHost(serial) {
  const match = /^rdf-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):5555$/.exec(serial);
  if (!match) throw new Error(diagnostic('emulator-touch.f6f53055a7'));
  return 'rdf-' + match[1];
}

// Rotation must be the actual Android display orientation (SurfaceOrientation),
// not EmulatorController's sensor-derived screenshot rotation. Undo Android's
// TouchInputMapper rotation, then scale to the natural emulator framebuffer.
export function mapEmulatorTouch({ x, y, width, height }, geometry) {
  if (!dimension(width) || !dimension(height) || !Number.isFinite(x) || !Number.isFinite(y) ||
      x < 0 || y < 0 || x >= width || y >= height || !dimension(geometry?.width) ||
      !dimension(geometry?.height) || !Number.isInteger(geometry?.rotation) ||
      geometry.rotation < 0 || geometry.rotation > 3) {
    throw new Error(diagnostic('emulator-touch.20021b46f9'));
  }
  const u = width > 1 ? x / (width - 1) : 0;
  const v = height > 1 ? y / (height - 1) : 0;
  const orientedWidth = geometry.rotation % 2 ? geometry.height : geometry.width;
  const orientedHeight = geometry.rotation % 2 ? geometry.width : geometry.height;
  const rect = geometry.physicalFrame || { left: 0, top: 0, right: orientedWidth, bottom: orientedHeight };
  if (![rect.left, rect.top, rect.right, rect.bottom].every(Number.isInteger) ||
      rect.left < 0 || rect.top < 0 || rect.right <= rect.left || rect.bottom <= rect.top ||
      rect.right > orientedWidth || rect.bottom > orientedHeight) throw new Error(diagnostic('emulator-touch.dd07c14b22'));
  const px = rect.left + u * (rect.right - rect.left - 1);
  const py = rect.top + v * (rect.bottom - rect.top - 1);
  const pu = orientedWidth > 1 ? px / (orientedWidth - 1) : 0;
  const pv = orientedHeight > 1 ? py / (orientedHeight - 1) : 0;
  const point = [[pu, pv], [1 - pv, pu], [1 - pu, 1 - pv], [pv, 1 - pu]][geometry.rotation];
  return { x: Math.round(point[0] * (geometry.width - 1)), y: Math.round(point[1] * (geometry.height - 1)) };
}

export function encodeEmulatorTouch(touches) {
  for (const { x, y, pointerId, pressure } of touches) {
    if (![x, y, pointerId, pressure].every(Number.isInteger) || x < 0 || x > 16383 || y < 0 || y > 16383 ||
        pointerId < 0 || pointerId > 0x7fffffff || pressure < 0 || pressure > 1024) throw new Error(diagnostic('emulator-touch.2e18a17913'));
  }
  return Buffer.concat(touches.map(({ x, y, pointerId, pressure }) => bytesField(1, Buffer.concat([
    field(1, x), field(2, y), field(3, pointerId), field(4, pressure),
  ]))));
}

export class EmulatorTouchController {
  constructor({ serial, onFailure, connect = http2.connect, timeoutMs = 1500, maxQueueAgeMs = 500, now = Date.now }) {
    this.serial = serial;
    this.onFailure = onFailure;
    this.connect = connect;
    this.timeoutMs = timeoutMs;
    this.maxQueueAgeMs = maxQueueAgeMs;
    this.now = now;
    this.geometry = { rotation: null };
    this.pointers = new Map();
    this.uncertainPointers = new Map();
    this.ownedPointers = new Set();
    this.queue = [];
    this.ready = false;
    this.closing = false;
    this.closed = false;
    this.failed = false;
    this.idleWaiters = [];
  }

  prepare() {
    if (this.closing || this.closed) return Promise.reject(new Error(diagnostic('emulator-touch.7cec56d643')));
    if (this.preparation) return this.preparation;
    const host = emulatorTouchHost(this.serial);
    this.preparation = (async () => {
      this.client = this.connect('http://' + host + ':8554');
      this.client.on('error', error => this.fail(error));
      this.client.on('close', () => {
        if (!this.closing && !this.closed) this.fail(new Error(diagnostic('emulator-touch.0069605585')));
      });
      const geometry = decodeEmulatorGeometry(await this.rpc('getStatus', Buffer.alloc(0)));
      // An empty TouchEvent carries no contacts. This verifies sendTouch support
      // before any gesture is routed here, including on older emulator versions.
      await this.rpc('sendTouch', Buffer.alloc(0));
      if (this.closing || this.closed || this.failed) throw new Error(diagnostic('emulator-touch.9279f4b61e'));
      this.geometry = { ...this.geometry, ...geometry };
      this.ready = true;
      return this.getGeometry();
    })().catch(error => {
      this.fail(error);
      throw error;
    });
    return this.preparation;
  }

  getGeometry() { return { ...this.geometry, ...(this.geometry.physicalFrame ? { physicalFrame: { ...this.geometry.physicalFrame } } : {}) }; }

  setGeometry(geometry) {
    const next = { ...this.geometry, ...geometry };
    if (!dimension(next.width) || !dimension(next.height) || !Number.isInteger(next.rotation) || next.rotation < 0 || next.rotation > 3) {
      throw new Error(diagnostic('emulator-touch.61b70e1b59'));
    }
    mapEmulatorTouch({ x: 0, y: 0, width: 2, height: 2 }, next);
    this.geometry = { ...next, ...(next.physicalFrame ? { physicalFrame: { ...next.physicalFrame } } : {}) };
  }

  isAvailable() {
    return this.ready && !this.failed && !this.closing && !this.closed && !this.resetting && Number.isInteger(this.geometry.rotation);
  }

  // true means this transport owns the event, not that Android acknowledged it.
  // Never replay an accepted event through scrcpy/ADB after an asynchronous error.
  // Failed gestures remain owned until up/cancel so callers cannot split one
  // gesture across two transports when delivery of its down is unknown.
  sendTouch(params) {
    const { action, pointerId = 0 } = params;
    if (!['down', 'move', 'up', 'cancel'].includes(action) || !Number.isInteger(pointerId) || pointerId < 0 || pointerId > 0x7fffffff) {
      throw new Error(diagnostic('emulator-touch.dcd392f5a7'));
    }
    if (action !== 'down' && this.ownedPointers.has(pointerId) && !this.isAvailable()) {
      if (action === 'up' || action === 'cancel') this.ownedPointers.delete(pointerId);
      return true;
    }
    if (!this.isAvailable()) return false;
    if (action === 'down' && this.ownedPointers.has(pointerId)) throw new Error(diagnostic('emulator-touch.67df11dd32'));
    if (action !== 'down' && !this.ownedPointers.has(pointerId)) return false;
    if (action === 'down' && (this.pointers.size >= MAX_POINTERS || this.queue.length >= MAX_QUEUE - MAX_POINTERS)) return false;
    const previous = this.pointers.get(pointerId);
    const geometry = previous?.geometry || this.getGeometry();
    const point = action === 'cancel' ? previous : mapEmulatorTouch(params, geometry);
    const event = { x: point.x, y: point.y, pointerId, pressure: action === 'up' || action === 'cancel' ? 0 : 1024, action, deadline: Math.min(this.now() + this.maxQueueAgeMs,
      Number.isFinite(params.inputDeadline) ? params.inputDeadline : Infinity) };
    if (action === 'down') this.ownedPointers.add(pointerId);
    if (event.pressure) this.pointers.set(pointerId, { ...point, geometry });
    else {
      this.pointers.delete(pointerId);
      this.ownedPointers.delete(pointerId);
    }
    // Reserve one queue entry for every possible pointer release. Moves may be
    // coalesced or dropped under backpressure; down/up are never dropped.
    if (action === 'move') {
      for (let i = this.queue.length - 1; i >= 0; i--) {
        if (this.queue[i].pointerId !== pointerId) continue;
        if (this.queue[i].action === 'move') this.queue[i] = event;
        else break;
        return true;
      }
      if (this.queue.length >= MAX_QUEUE - MAX_POINTERS) return true;
    }
    this.queue.push(event);
    this.drain();
    return true;
  }

  async drain() {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length && !this.failed && !this.closed && !this.resetting) {
        const event = this.queue.shift();
        if (event.pressure && this.now() >= event.deadline) {
          if (event.action === 'move') continue;
          // Never replay a delayed tap after a congested transport recovers.
          // Fail closed and release contacts whose delivery is already known
          // or uncertain; a later gesture may use the surviving scrcpy channel.
          throw Object.assign(new Error(diagnostic('emulator-touch.3f260c8735')), { code: 'INPUT_EXPIRED' });
        }
        // A failed response does not prove the guest missed the contact. Keep
        // its last coordinates until an acknowledged release, for cleanup.
        if (event.pressure) this.uncertainPointers.set(event.pointerId, event);
        await this.rpc('sendTouch', encodeEmulatorTouch([event]));
        if (!event.pressure) this.uncertainPointers.delete(event.pointerId);
      }
    } catch (error) { this.fail(error); }
    finally {
      this.draining = false;
      for (const resolve of this.idleWaiters.splice(0)) resolve();
    }
  }

  rpc(method, body) {
    return new Promise((resolve, reject) => {
      if (!this.client || this.client.destroyed || this.client.closed) return reject(new Error(diagnostic('emulator-touch.b31b8d95e1')));
      let request;
      let timer;
      let settled = false;
      let bytes = Buffer.alloc(0);
      let status;
      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) { request?.close(); reject(error); }
        else resolve(result);
      };
      try {
        request = this.client.request({ ':method': 'POST', ':path': SERVICE + method, 'content-type': 'application/grpc', te: 'trailers' });
        timer = setTimeout(() => finish(new Error(diagnostic('emulator-touch.fa7fecbf80'))), this.timeoutMs);
        request.on('response', headers => {
          if (headers[':status'] !== 200 || !String(headers['content-type'] || '').startsWith('application/grpc')) {
            finish(new Error(diagnostic('emulator-touch.1c32b18a69')));
          }
          if (headers['grpc-status'] !== undefined) status = String(headers['grpc-status']);
        });
        request.on('trailers', headers => { status = String(headers['grpc-status']); });
        request.on('data', chunk => {
          if (bytes.length + chunk.length > MAX_RESPONSE_BYTES + 5) return finish(new Error(diagnostic('emulator-touch.25b537dc8d')));
          bytes = Buffer.concat([bytes, chunk]);
        });
        request.on('error', error => finish(error));
        request.on('close', () => finish(new Error(diagnostic('emulator-touch.a6b0cb0a56'))));
        request.on('end', () => {
          if (status !== '0') return finish(new Error(diagnostic('emulator-touch.6629653367', { p0: (status ?? 'unknown') })));
          if (bytes.length < 5 || bytes[0] !== 0 || bytes.readUInt32BE(1) !== bytes.length - 5) {
            return finish(new Error(diagnostic('emulator-touch.7b66ca7c91')));
          }
          finish(null, bytes.subarray(5));
        });
        request.end(frame(body));
      } catch (error) { finish(error); }
    });
  }

  fail(error) {
    if (this.failed || this.closed) return;
    this.failed = true;
    this.ready = false;
    this.queue = [];
    try { this.onFailure?.(error); } catch { /* Cleanup must still release contacts. */ }
    // Only release contacts after uncertain delivery; never retry the gesture.
    void this.close();
  }

  releaseInput() {
    if (this.resetPromise) return this.resetPromise;
    if (this.closing || this.closed) return this.cleanup || Promise.resolve();
    this.resetting = true;
    this.queue = [];
    this.ownedPointers.clear();
    this.pointers.clear();
    this.resetPromise = (async () => {
      // The current RPC may have reached Android before its acknowledgement.
      // Its release must come afterwards; queued contacts are simply discarded.
      if (this.draining) await new Promise(resolve => this.idleWaiters.push(resolve));
      const releases = [...this.uncertainPointers].map(([pointerId, point]) => ({ ...point, pointerId, pressure: 0 }));
      if (releases.length) await this.rpc('sendTouch', encodeEmulatorTouch(releases));
      this.uncertainPointers.clear();
    })().catch(error => {
      this.fail(error);
      throw error;
    }).finally(() => { this.resetting = false; this.resetPromise = null; });
    return this.resetPromise;
  }

  close() {
    if (this.cleanup) return this.cleanup;
    this.closing = true;
    this.ready = false;
    this.queue = [];
    this.cleanup = (async () => {
      if (this.resetPromise) await this.resetPromise.catch(() => {});
      if (this.draining) await new Promise(resolve => this.idleWaiters.push(resolve));
      const contacts = new Map([...this.pointers, ...this.uncertainPointers]);
      const releases = [...contacts].map(([pointerId, point]) => ({ ...point, pointerId, pressure: 0 }));
      this.pointers.clear();
      this.uncertainPointers.clear();
      if (releases.length) {
        try { await this.rpc('sendTouch', encodeEmulatorTouch(releases)); } catch { /* Best effort if the channel was lost. */ }
      }
      this.queue = [];
      this.closed = true;
      this.client?.close();
      this.client?.destroy();
    })();
    return this.cleanup;
  }
}
