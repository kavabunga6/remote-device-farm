import http2 from 'node:http2';
import { diagnostic } from './diagnostics.mjs';
import { emulatorTouchHost } from './emulator-touch.mjs';

const MAX_MESSAGE = 256 * 1024;
const SERVICE = '/android.emulation.control.v2.Rtc/';
export function protoBytes(id, bytes) {
  const uint = n => { const out = []; do { out.push((n & 127) | (n >= 128 ? 128 : 0)); n = Math.floor(n / 128); } while (n); return Buffer.from(out); };
  return Buffer.concat([uint(id * 8 + 2), uint(bytes.length), bytes]);
}
export function protoFields(bytes, maxBytes = MAX_MESSAGE) {
  let offset = 0;
  const fields = new Map(), invalid = () => new Error(diagnostic('native.grpc.invalid'));
  const uint = () => {
    let value = 0;
    for (let shift = 0; shift < 53 && offset < bytes.length; shift += 7) {
      const b = bytes[offset++]; value += (b & 127) * 2 ** shift;
      if (!(b & 128) && Number.isSafeInteger(value)) return value;
    }
    throw invalid();
  };
  while (offset < bytes.length) {
    const tag = uint(), id = Math.floor(tag / 8), wire = tag & 7;
    if (!id) throw invalid();
    if (wire === 0) fields.set(id, uint());
    else if (wire === 2) {
      const size = uint(); if (size > maxBytes || offset + size > bytes.length) throw invalid();
      fields.set(id, bytes.subarray(offset, offset + size)); offset += size;
    } else if (wire === 1 || wire === 5) {
      offset += wire === 1 ? 8 : 4; if (offset > bytes.length) throw invalid();
    } else throw invalid();
  }
  return fields;
}

export class EmulatorRtcSignaling {
  constructor({ serial, onFailure, connect = http2.connect, timeoutMs = 5000 }) {
    this.host = emulatorTouchHost(serial); this.connect = connect; this.onFailure = onFailure;
    this.timeoutMs = timeoutMs; this.requests = new Set(); this.closed = false;
  }
  async start(onSignal) {
    if (this.closed) throw new Error(diagnostic('native.rtc.closed'));
    this.client = this.connect('http://' + this.host + ':8554');
    this.client.on('error', error => { if (!this.closed) this.onFailure(error); });
    // An explicit empty ICE configuration keeps emulator-to-agent traffic local.
    const response = await this.rpc('RequestRtcStream', protoBytes(2, Buffer.alloc(0)));
    const id = protoFields(protoFields(response).get(1)).get(1);
    if (!Buffer.isBuffer(id) || !/^[a-f0-9-]{36}$/.test(id.toString())) throw new Error(diagnostic('native.grpc.invalid'));
    this.id = protoBytes(1, id);
    void this.rpc('ReceiveJsepMessageStream', protoBytes(1, this.id), bytes => {
      const envelope = protoFields(protoFields(bytes).get(1)), message = envelope.get(2);
      if (!Buffer.isBuffer(message)) throw new Error(diagnostic('native.grpc.invalid'));
      onSignal(JSON.parse(message.toString()));
    }).then(() => { if (!this.closed) this.onFailure(new Error(diagnostic('native.rtc.closed'))); })
      .catch(error => { if (!this.closed) this.onFailure(error); });
  }
  send(message) {
    if (!this.id || this.closed) return Promise.reject(new Error(diagnostic('native.rtc.closed')));
    const json = Buffer.from(JSON.stringify(message));
    if (json.length > 128 * 1024) return Promise.reject(new Error(diagnostic('native.grpc.invalid')));
    return this.rpc('SendJsepMessage', protoBytes(1, Buffer.concat([protoBytes(1, this.id), protoBytes(2, json)])));
  }
  snapshot() {
    return this.rpc('getScreenshot', Buffer.from([24, 128, 8, 32, 128, 8]), null,
      { service: '/android.emulation.control.EmulatorController/', maxBytes: 8 * 1024 * 1024 });
  }
  rpc(method, body, onMessage, { service = SERVICE, maxBytes = MAX_MESSAGE } = {}) {
    if (this.closed || this.requests.size >= 32) return Promise.reject(new Error(diagnostic('native.rtc.closed')));
    return new Promise((resolve, reject) => {
      let request, timer, status, result, done = false, pending = Buffer.alloc(0);
      const finish = error => {
        if (done) return; done = true; clearTimeout(timer); this.requests.delete(request);
        if (error) { request?.close(); reject(error); } else resolve(result ?? Buffer.alloc(0));
      };
      try {
        request = this.client.request({ ':method': 'POST', ':path': service + method, 'content-type': 'application/grpc', te: 'trailers' });
        this.requests.add(request);
        if (!onMessage) timer = setTimeout(() => finish(new Error(diagnostic('native.grpc.timeout'))), this.timeoutMs);
        request.on('response', headers => {
          if (headers[':status'] !== 200 || !String(headers['content-type']).startsWith('application/grpc')) return finish(new Error(diagnostic('native.grpc.invalid')));
          if (headers['grpc-status'] !== undefined) status = String(headers['grpc-status']);
        });
        request.on('trailers', headers => { status = String(headers['grpc-status']); });
        request.on('data', chunk => {
          if (done) return;
          try {
            if (pending.length + chunk.length > maxBytes + 5) throw new Error(diagnostic('native.grpc.invalid'));
            pending = Buffer.concat([pending, chunk]);
            while (pending.length >= 5) {
              const size = pending.readUInt32BE(1);
              if (pending[0] !== 0 || size > maxBytes) throw new Error(diagnostic('native.grpc.invalid'));
              if (pending.length < size + 5) break;
              result = pending.subarray(5, size + 5); pending = pending.subarray(size + 5);
              onMessage?.(result);
            }
          } catch (error) { finish(error); }
        });
        request.on('error', finish);
        request.on('end', () => finish(status === '0' && !pending.length ? null : new Error(diagnostic('native.grpc.invalid'))));
        request.on('close', () => finish(new Error(diagnostic('native.rtc.closed'))));
        const frame = Buffer.alloc(5 + body.length); frame.writeUInt32BE(body.length, 1); body.copy(frame, 5); request.end(frame);
      } catch (error) { finish(error); }
    });
  }
  async close() {
    if (this.closed) return;
    if (this.id) await this.send({ bye: true }).catch(() => {});
    this.closed = true;
    for (const request of this.requests) request.close();
    this.requests.clear(); this.client?.destroy();
  }
}
