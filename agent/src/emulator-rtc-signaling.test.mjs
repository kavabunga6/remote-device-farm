import assert from 'node:assert/strict';
import test from 'node:test';
import http2 from 'node:http2';
import { once } from 'node:events';
import { EmulatorRtcSignaling, protoBytes, protoFields } from './emulator-rtc-signaling.mjs';

const serial = 'rdf-11111111-1111-4111-8111-111111111111:5555';
const frame = bytes => { const result = Buffer.alloc(5 + bytes.length); result.writeUInt32BE(bytes.length, 1); bytes.copy(result, 5); return result; };
async function fixture(handler, timeoutMs = 30) {
  const server = http2.createServer(); const streams = new Set();
  server.on('stream', (stream, headers) => { streams.add(stream); stream.on('close', () => streams.delete(stream)); stream.on('error', () => {}); handler(stream, headers); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address();
  const client = new EmulatorRtcSignaling({ serial, timeoutMs, onFailure() {} });
  client.client = http2.connect(`http://127.0.0.1:${address.port}`); client.client.on('error', () => {});
  return { client, streams, close: async () => { await client.close(); for (const stream of streams) stream.close(); await new Promise(resolve => server.close(resolve)); } };
}
test('native gRPC accepts split uncompressed envelopes and validates completion status', async () => {
  const f = await fixture(stream => {
    stream.respond({ ':status': 200, 'content-type': 'application/grpc', 'grpc-status': '0' });
    const packet = frame(protoBytes(1, Buffer.from('reply')));
    stream.write(packet.subarray(0, 3)); stream.end(packet.subarray(3));
  });
  try { assert.deepEqual(protoFields(await f.client.rpc('RequestRtcStream', Buffer.alloc(0))).get(1), Buffer.from('reply')); }
  finally { await f.close(); }
});
for (const kind of ['compressed', 'oversize', 'truncated', 'denied', 'http']) test(`native gRPC rejects ${kind} responses without hanging`, async () => {
  const f = await fixture(stream => {
    stream.respond({ ':status': kind === 'http' ? 503 : 200, 'content-type': 'application/grpc', 'grpc-status': kind === 'denied' ? '7' : '0' });
    const packet = frame(Buffer.from('reply'));
    if (kind === 'compressed') packet[0] = 1;
    if (kind === 'oversize') packet.writeUInt32BE(256 * 1024 + 1, 1);
    stream.end(kind === 'truncated' ? packet.subarray(0, 6) : packet);
  });
  try { await assert.rejects(f.client.rpc('RequestRtcStream', Buffer.alloc(0)), /Invalid native emulator/); }
  finally { await f.close(); }
});
test('native request deadlines and close settle outstanding promises and discard streams', async () => {
  const f = await fixture(stream => { stream.respond({ ':status': 200, 'content-type': 'application/grpc' }); });
  try {
    await assert.rejects(f.client.rpc('RequestRtcStream', Buffer.alloc(0)), /timed out/);
    const request = f.client.rpc('RequestRtcStream', Buffer.alloc(0));
    const rejected = assert.rejects(request, /closed/);
    await f.client.close(); await rejected; assert.equal(f.client.requests.size, 0);
  } finally { await f.close(); }
});
test('native endpoints cannot target external hosts or another unmanaged device', () => {
  for (const value of ['example.test:5555', '127.0.0.1:5555', serial + '/extra', 'device-123']) assert.throws(() => new EmulatorRtcSignaling({ serial: value }));
  assert.throws(() => protoFields(Buffer.from([10, 20, 1])), /Invalid native/);
  assert.throws(() => protoFields(Buffer.from([0])), /Invalid native/);
});
