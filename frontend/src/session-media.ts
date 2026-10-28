import type { RtcConfiguration } from './session-rtc';

export type StreamMessage = {
  type: string;
  data?: string;
  mime?: string;
  width?: number;
  height?: number;
  rotation?: number;
  codec?: string;
  timestamp?: number;
  keyframe?: boolean;
  sampleRate?: number;
  channels?: number;
  nativeTouches?: boolean;
  inputEpoch?: string;
  serverTime?: number;
  inputMaxAgeMs?: number;
  id?: string;
  rtc?: RtcConfiguration;
  available?: boolean;
  iceServers?: RTCIceServer[];
  reason?: string;
  description?: RTCSessionDescriptionInit;
  message?: string;
};

export function decodeBase64(encoded: string): Uint8Array {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export function h264Codec(config: Uint8Array): string {
  for (let index = 0; index < config.length - 7; index += 1) {
    const start = config[index] === 0 && config[index + 1] === 0 &&
      (config[index + 2] === 1 || (config[index + 2] === 0 && config[index + 3] === 1));
    if (!start) continue;
    const nal = index + (config[index + 2] === 1 ? 3 : 4);
    if ((config[nal] & 0x1f) !== 7) continue;
    const profile = [config[nal + 1], config[nal + 2], config[nal + 3]]
      .map(value => value.toString(16).padStart(2, '0')).join('');
    return `avc1.${profile}`;
  }
  return 'avc1.42e01e';
}

export function joinBytes(first: Uint8Array, second: Uint8Array): Uint8Array {
  const joined = new Uint8Array(first.length + second.length);
  joined.set(first);
  joined.set(second, first.length);
  return joined;
}
