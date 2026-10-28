import { agentMessage } from './messages.mjs';
import net from 'node:net';

const SCRCPY_VERSION = '4.1';
export const RESET_VIDEO_CONTROL_MESSAGE = Buffer.from([17]); // scrcpy v4.1 RESET_VIDEO

export function scrcpyServerArgs(serial, deviceServerPath, scid, audioCodec) {
  return ['-s', serial, 'shell',
    'CLASSPATH=' + deviceServerPath, 'app_process', '/',
    'com.genymobile.scrcpy.Server', SCRCPY_VERSION,
    'scid=' + scid.toString(16).padStart(8, '0'),
    'log_level=verbose', 'tunnel_forward=true', 'control=true', 'send_device_meta=false',
    'send_dummy_byte=true', 'video_codec=h264', 'audio_codec=' + audioCodec,
    'max_size=1280', 'max_fps=60', 'video_bit_rate=6000000',
    'video_codec_options=i-frame-interval:int=1'];
}


export class SocketReader {
  constructor(socket) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.waiting = [];
    this.ended = false;
    this.error = null;
    socket.on('data', (data) => {
      if (this.buffer.length + data.length > 32 * 1024 * 1024) {
        socket.destroy(new Error(agentMessage('agent.802d346781b7')));
        return;
      }
      this.buffer = this.buffer.length ? Buffer.concat([this.buffer, data]) : data;
      this.flush();
    });
    socket.on('close', () => { this.ended = true; this.flush(); });
    socket.on('error', (error) => { this.error = error; this.ended = true; this.flush(); });
  }

  flush() {
    while (this.waiting.length) {
      const { length, resolve, reject } = this.waiting[0];
      if (this.buffer.length >= length) {
        this.waiting.shift();
        const value = this.buffer.subarray(0, length);
        this.buffer = this.buffer.subarray(length);
        resolve(value);
      } else if (this.ended) {
        this.waiting.shift();
        reject(this.error || new Error(agentMessage('agent.91b23cf76718')));
      } else break;
    }
  }

  read(length) {
    if (!Number.isInteger(length) || length < 0 || length > 16 * 1024 * 1024) throw new Error(agentMessage('agent.b437662d8b65'));
    return new Promise((resolve, reject) => {
      this.waiting.push({ length, resolve, reject });
      this.flush();
    });
  }
}

export function parseMediaHeader(header) {
  if (!Buffer.isBuffer(header) || header.length !== 12) throw new Error(agentMessage('agent.653f16499e77'));
  const packetSize = header.readUInt32BE(8);
  if (packetSize > 16 * 1024 * 1024) throw new Error(agentMessage('agent.55b0b1c11639'));
  const ptsAndFlags = header.readBigUInt64BE(0);
  return {
    session: Boolean(ptsAndFlags & (1n << 63n)),
    config: Boolean(ptsAndFlags & (1n << 62n)),
    keyframe: Boolean(ptsAndFlags & (1n << 61n)),
    timestamp: Number(ptsAndFlags & ((1n << 61n) - 1n)),
    packetSize,
  };
}

export function parseAudioCodecHeader(header, requestedCodec) {
  if (!Buffer.isBuffer(header) || header.length !== 4) throw new Error(agentMessage('agent.b8ca0338ba26'));
  const status = header.readUInt32BE(0);
  if (status === 0) return { available: false, codec: null };
  if (status === 1) {
    const error = new Error(agentMessage('agent.codecFailed', { p0: requestedCodec }));
    error.code = 'SCRCPY_AUDIO_CODEC_ERROR';
    throw error;
  }
  const codec = header.toString('ascii').replace(/^\0+/, '');
  if (codec !== requestedCodec) throw new Error(agentMessage('agent.codecUnexpected', { p0: codec }));
  return { available: true, codec };
}

export function shouldRetryAac(error) {
  return error?.code === 'SCRCPY_AUDIO_CODEC_ERROR' ||
    /Could not create default audio encoder for opus|Failed to initialize audio\/opus/i.test(error?.message || '');
}

// scrcpy v4.1 INJECT_TOUCH_EVENT: type, action, pointer id, position,
// fixed-point pressure and two button masks (32 bytes, network byte order).
export function encodeTouchEvent({ action, x, y, pointerId = 0 }, width, height) {
  const actions = { down: 0, up: 1, move: 2 };
  if (!Object.hasOwn(actions, action)) throw new Error(agentMessage('agent.45a7afcab5b9'));
  if (!Number.isInteger(pointerId) || pointerId < 0 || pointerId > 9) throw new Error(agentMessage('agent.f4309a285e65'));
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 8192 || height > 8192) {
    throw new Error(agentMessage('agent.fc8ecbf72def'));
  }
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= width || y >= height) {
    throw new Error(agentMessage('agent.51d321a3854e'));
  }
  const message = Buffer.alloc(32);
  message[0] = 2;
  message[1] = actions[action];
  message.writeBigUInt64BE(BigInt(pointerId), 2);
  message.writeInt32BE(x, 10);
  message.writeInt32BE(y, 14);
  message.writeUInt16BE(width, 18);
  message.writeUInt16BE(height, 20);
  message.writeUInt16BE(action === 'up' ? 0 : 0xffff, 22);
  return message;
}

// scrcpy v4.1 control_msg.c: INJECT_KEYCODE is 14 bytes. Send the down/up
// pair in one write so other input cannot leave the key pressed between them.
export function encodeKeyPress(keyCode) {
  const code = Number(keyCode);
  if (!Number.isInteger(code) || code < 1 || code > 300) throw new Error(agentMessage('agent.690472e46a6e'));
  const message = Buffer.alloc(28);
  for (const [offset, action] of [[0, 0], [14, 1]]) {
    message[offset] = 0;
    message[offset + 1] = action;
    message.writeUInt32BE(code, offset + 2);
    // repeat and metastate remain zero, matching adb shell input keyevent.
  }
  return message;
}

export function encodeTextInput(text) {
  if (typeof text !== 'string' || text.length > 1000 || /[\r\n\0]/.test(text)) throw new Error(agentMessage('agent.f4e60ac952ee'));
  const packets = [];
  let parts = [];
  let length = 0;
  const flush = () => {
    if (!length) return;
    const header = Buffer.alloc(5);
    header[0] = 1; // INJECT_TEXT: byte length followed by unescaped UTF-8.
    header.writeUInt32BE(length, 1);
    packets.push(header, ...parts);
    parts = [];
    length = 0;
  };
  // v4.1 limits each INJECT_TEXT payload to 300 bytes. Preserve complete
  // code points and the existing 1000-character API limit without truncation.
  for (const character of text) {
    const bytes = Buffer.from(character, 'utf8');
    if (length + bytes.length > 300) flush();
    parts.push(bytes);
    length += bytes.length;
  }
  flush();
  return Buffer.concat(packets);
}

export function connectPort(port, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const attempt = () => {
      const socket = net.connect({ port, host: '127.0.0.1' });
      socket.once('connect', () => { socket.removeAllListeners('error'); socket.setNoDelay(true); resolve(socket); });
      socket.once('error', (error) => {
        socket.destroy();
        if (Date.now() - started > timeoutMs) reject(error);
        else setTimeout(attempt, 200);
      });
    };
    attempt();
  });
}

export function within(promise, timeoutMs, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(agentMessage('agent.operationTimeout', { p0: label }))), timeoutMs); }),
  ]).finally(() => clearTimeout(timer));
}

// An adb forward accepts local TCP connections before the device-side abstract
// socket exists. The scrcpy dummy byte confirms that the remote server accepted
// the video connection; a plain TCP connect does not.
export async function connectVideoPortWithHandshake(port, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  do {
    let socket;
    try {
      socket = await connectPort(port, Math.max(1, deadline - Date.now()));
      const reader = new SocketReader(socket);
      const dummy = await within(reader.read(1), Math.min(2000, Math.max(1, deadline - Date.now())), 'scrcpy handshake');
      if (dummy[0] !== 0) throw new Error(agentMessage('agent.dummyByte', { p0: dummy[0] }));
      return { socket, reader };
    } catch (error) {
      socket?.destroy();
      lastError = error;
      if (Date.now() >= deadline) break;
      await new Promise((resolve) => setTimeout(resolve, Math.min(200, deadline - Date.now())));
    }
  } while (Date.now() < deadline);
  throw new Error(agentMessage('agent.handshakeFailed', { p0: lastError?.message ?? '' }));
}
