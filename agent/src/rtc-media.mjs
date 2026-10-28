import { diagnostic } from './diagnostics.mjs';
// H.264 Annex B access units from scrcpy -> RFC 6184 single NAL / FU-A.
// The same encoded access units feed both comparison modes; no transcoding.
export function annexBNals(data) {
  const starts = [];
  for (let i = 0; i + 2 < data.length; i++) {
    if (data[i] || data[i + 1]) continue;
    if (data[i + 2] === 1) { starts.push([i, i + 3]); i += 2; }
    else if (data[i + 2] === 0 && data[i + 3] === 1) { starts.push([i, i + 4]); i += 3; }
  }
  if (!starts.length) throw new Error(diagnostic('rtc-media.a9bf2e1df6'));
  return starts.map(([, start], i) => data.subarray(start, starts[i + 1]?.[0] ?? data.length)).filter(n => n.length);
}

export function h264Profile(data) {
  const sps = annexBNals(data).find(n => (n[0] & 31) === 7);
  if (!sps || sps.length < 4) throw new Error(diagnostic('rtc-media.276449a8b3'));
  return sps.subarray(1, 4).toString('hex');
}

export function packetizeH264(data, maxPayload = 1100) {
  if (maxPayload < 3) throw new Error(diagnostic('rtc-media.54207a1285'));
  const packets = [];
  for (const nal of annexBNals(data)) {
    if (nal.length <= maxPayload) { packets.push(nal); continue; }
    const indicator = (nal[0] & 0xe0) | 28;
    for (let offset = 1; offset < nal.length; offset += maxPayload - 2) {
      const end = Math.min(nal.length, offset + maxPayload - 2);
      const header = (nal[0] & 31) | (offset === 1 ? 0x80 : 0) | (end === nal.length ? 0x40 : 0);
      packets.push(Buffer.concat([Buffer.from([indicator, header]), nal.subarray(offset, end)]));
    }
  }
  return packets.map((payload, i) => ({ payload, marker: i === packets.length - 1 }));
}

export function rtpTimestamp(microseconds, rate) {
  if (!Number.isSafeInteger(microseconds) || microseconds < 0) throw new Error(diagnostic('rtc-media.f45e0c6e7e'));
  return Number((BigInt(microseconds) * BigInt(rate) / 1000000n) & 0xffffffffn);
}

// Opus TOC frame duration/count, expressed on its fixed 48 kHz RTP clock.
// RFC 6716 section 3.1: an Opus packet contains at most 120 ms of audio.
export function opusPacketSamples(data) {
  if (!data.length) throw new Error(diagnostic('rtc-media.eb2cfe821c'));
  const toc = data[0];
  const frameSamples = toc & 0x80 ? 120 << ((toc >> 3) & 3)
    : (toc & 0x60) === 0x60 ? (toc & 8 ? 960 : 480)
      : ((toc >> 3) & 3) === 3 ? 2880 : 480 << ((toc >> 3) & 3);
  const code = toc & 3;
  const count = code === 0 ? 1 : code === 3 ? (data[1] ?? 0) & 63 : 2;
  const samples = frameSamples * count;
  if (!count || samples > 5760) throw new Error(diagnostic('rtc-media.b19338535b'));
  return samples;
}

// Android MediaCodec capture PTS can jitter/backtrack across continuous
// 960-sample Opus packets even on lossless local TCP.
// RTP must advance by the actual encoded sample count, before any queue drops.
export class OpusRtpClock {
  constructor({ discontinuityMs = 500 } = {}) {
    this.discontinuityMs = discontinuityMs;
    this.nextPosition = null;
    this.lastSourcePts = null;
    this.lastArrivalMs = null;
    this.lastSamples = 0;
    this.needsAnchor = true;
  }

  reset() { this.needsAnchor = true; }

  accept(sourcePts, samples, arrivalMs) {
    if (!Number.isSafeInteger(sourcePts) || sourcePts < 0 || !Number.isInteger(samples) || samples < 120 || samples > 5760 ||
        !Number.isFinite(arrivalMs)) throw new Error(diagnostic('rtc-media.94b7e95e77'));
    const gapMs = this.lastArrivalMs == null ? 0 : Math.max(0, arrivalMs - this.lastArrivalMs);
    const discontinuity = this.needsAnchor || gapMs > this.discontinuityMs ||
      (this.lastSourcePts != null && Math.abs(sourcePts - this.lastSourcePts) > this.discontinuityMs * 1000);
    let position = this.nextPosition;
    if (discontinuity) {
      const sourcePosition = Number(BigInt(sourcePts) * 48000n / 1000000n);
      const elapsedPosition = position == null ? sourcePosition
        : position + Math.max(0, Math.round(gapMs * 48) - this.lastSamples);
      // An encoder restart may reset its source PTS. Keep this RTP timeline
      // moving forward; elapsed silence remains a gap rather than old replay.
      position = position == null ? sourcePosition
        : Math.max(position, sourcePosition >= position ? sourcePosition : elapsedPosition);
    }
    this.nextPosition = position + samples;
    this.lastSourcePts = sourcePts;
    this.lastArrivalMs = arrivalMs;
    this.lastSamples = samples;
    this.needsAnchor = false;
    return { position, discontinuity };
  }
}
