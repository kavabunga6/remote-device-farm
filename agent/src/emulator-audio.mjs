import http2 from 'node:http2';

const SAMPLE_RATE = 48000;
const CHANNELS = 2;
const MAX_GRPC_MESSAGE = 256 * 1024;
const STREAM_AUDIO_PATH = '/android.emulation.control.EmulatorController/streamAudio';
const AUDIO_FORMAT = Buffer.from([0x08, 0x80, 0xf7, 0x02, 0x10, 0x01, 0x18, 0x01]);

function grpcFrame(message) {
  const frame = Buffer.alloc(5 + message.length);
  frame.writeUInt32BE(message.length, 1);
  message.copy(frame, 5);
  return frame;
}

function varint(bytes, offset) {
  let value = 0n;
  let shift = 0n;
  while (offset < bytes.length && shift <= 63n) {
    const octet = bytes[offset++];
    value |= BigInt(octet & 0x7f) << shift;
    if (!(octet & 0x80)) return [value, offset];
    shift += 7n;
  }
  throw new Error('Invalid emulator audio protobuf varint');
}

function fields(bytes) {
  const result = new Map();
  let offset = 0;
  while (offset < bytes.length) {
    let tag;
    [tag, offset] = varint(bytes, offset);
    const field = Number(tag >> 3n);
    const wire = Number(tag & 7n);
    if (!field) throw new Error('Invalid emulator audio protobuf field');
    let value;
    if (wire === 0) [value, offset] = varint(bytes, offset);
    else if (wire === 2) {
      let size;
      [size, offset] = varint(bytes, offset);
      if (size > BigInt(MAX_GRPC_MESSAGE) || offset + Number(size) > bytes.length) {
        throw new Error('Invalid emulator audio protobuf length');
      }
      value = bytes.subarray(offset, offset + Number(size));
      offset += Number(size);
    } else if (wire === 1 || wire === 5) {
      const size = wire === 1 ? 8 : 4;
      if (offset + size > bytes.length) throw new Error('Truncated emulator audio protobuf field');
      offset += size;
      continue;
    } else throw new Error('Unsupported emulator audio protobuf field');
    result.set(field, value);
  }
  return result;
}

export function decodeAudioPacket(bytes) {
  const packet = fields(bytes);
  const formatBytes = packet.get(1);
  const pcm = packet.get(3);
  if (!Buffer.isBuffer(formatBytes) || !Buffer.isBuffer(pcm) || !pcm.length || pcm.length % 4) {
    throw new Error('Invalid emulator PCM audio packet');
  }
  const format = fields(formatBytes);
  if (format.get(1) !== BigInt(SAMPLE_RATE) || format.get(2) !== 1n || format.get(3) !== 1n) {
    throw new Error('Unsupported emulator PCM audio format');
  }
  const timestamp = packet.get(2) || 0n;
  if (timestamp > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Invalid emulator audio timestamp');
  return { pcm, timestamp: Number(timestamp) };
}

export function emulatorAudioHost(serial) {
  const match = /^rdf-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):5555$/.exec(serial);
  if (!match) throw new Error('Invalid managed emulator serial for audio');
  return 'rdf-' + match[1];
}

export class EmulatorAudioStream {
  constructor({ sessionId, serial, emit, onFailure, connect = http2.connect, startTimeoutMs = 5000 }) {
    this.sessionId = sessionId;
    this.serial = serial;
    this.emit = emit;
    this.onFailure = onFailure;
    this.connect = connect;
    this.startTimeoutMs = startTimeoutMs;
    this.enabled = false;
    this.closed = false;
    this.ready = null;
    this.pending = Buffer.alloc(0);
  }

  start() {
    if (this.closed) return Promise.reject(new Error('Emulator audio stream is closed'));
    if (this.ready) return this.ready;
    const host = emulatorAudioHost(this.serial);
    this.ready = new Promise((resolve, reject) => {
      this.rejectStart = reject;
      let started = false;
      let failed = false;
      const fail = (error) => {
        if (failed || this.closed) return;
        failed = true;
        this.close(error);
        if (started) this.onFailure?.(error);
      };
      this.startTimer = setTimeout(() => fail(new Error('Emulator audio stream timed out')), this.startTimeoutMs);
      try {
        this.client = this.connect('http://' + host + ':8554');
        this.client.on('error', fail);
        this.request = this.client.request({
          ':method': 'POST', ':path': STREAM_AUDIO_PATH,
          'content-type': 'application/grpc', te: 'trailers',
        });
        this.request.on('response', (headers) => {
          if (headers[':status'] !== 200 || !String(headers['content-type'] || '').startsWith('application/grpc')) {
            fail(new Error('Emulator audio gRPC endpoint rejected the request'));
          }
        });
        this.request.on('trailers', (trailers) => {
          if (trailers['grpc-status'] !== '0') fail(new Error('Emulator audio gRPC status ' + String(trailers['grpc-status'] || 'unknown')));
        });
        this.request.on('data', (chunk) => {
          try {
            this.consume(chunk);
            if (!started && this.receivedPacket) {
              started = true;
              clearTimeout(this.startTimer);
              this.startTimer = null;
              this.rejectStart = null;
              resolve();
            }
          } catch (error) { fail(error); }
        });
        this.request.on('end', () => fail(new Error('Emulator audio stream ended')));
        this.request.on('close', () => fail(new Error('Emulator audio stream closed')));
        this.request.on('error', fail);
        this.request.end(grpcFrame(AUDIO_FORMAT));
      } catch (error) { fail(error); }
    });
    return this.ready;
  }

  consume(chunk) {
    if (this.closed) return;
    if (this.pending.length + chunk.length > MAX_GRPC_MESSAGE + 5) {
      throw new Error('Emulator audio receive buffer exceeded limit');
    }
    this.pending = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
    while (this.pending.length >= 5) {
      const compressed = this.pending[0];
      const length = this.pending.readUInt32BE(1);
      if (compressed || length > MAX_GRPC_MESSAGE) throw new Error('Unsupported emulator audio gRPC packet');
      if (this.pending.length < length + 5) break;
      const packet = decodeAudioPacket(this.pending.subarray(5, length + 5));
      this.pending = this.pending.subarray(length + 5);
      this.receivedPacket = true;
      if (this.enabled) this.emit({
        type: 'audio-frame', sessionId: this.sessionId, codec: 'pcm-s16le',
        timestamp: packet.timestamp, data: packet.pcm.toString('base64'),
      });
    }
  }

  setEnabled(enabled) {
    if (this.closed) throw new Error('Emulator audio stream is unavailable');
    this.enabled = Boolean(enabled);
    if (this.enabled) this.resendConfig();
  }

  resendConfig() {
    if (this.enabled && !this.closed) this.emit({
      type: 'audio-config', sessionId: this.sessionId, codec: 'pcm-s16le',
      sampleRate: SAMPLE_RATE, channels: CHANNELS, data: null,
    });
  }

  close(error = new Error('Emulator audio stream is closed')) {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.startTimer);
    this.startTimer = null;
    this.rejectStart?.(error);
    this.rejectStart = null;
    this.enabled = false;
    this.request?.close();
    this.client?.close();
    this.client?.destroy();
    this.pending = Buffer.alloc(0);
  }
}
