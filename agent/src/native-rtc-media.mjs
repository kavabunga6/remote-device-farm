import { dePacketizeRtpPackets, Vp8RtpPayload } from 'werift';

// Only complete VP8 access units enter the existing broker queue. Missing RTP
// fragments invalidate dependent frames, just as dropped scrcpy deltas do.
export class NativeVp8Frames {
  constructor({ requestKeyframe = () => {}, maxBytes = 4 * 1024 * 1024, maxPackets = 4096 } = {}) {
    this.requestKeyframe = requestKeyframe; this.maxBytes = maxBytes; this.maxPackets = maxPackets;
    this.packets = []; this.bytes = 0; this.waiting = true; this.timestamp = null;
    this.lastClock = null; this.clock = 0; this.broken = false;
    this.lastSequence = null; this.completedTimestamp = null;
  }
  discard() { this.packets = []; this.bytes = 0; this.broken = true; this.waiting = true; this.requestKeyframe(); }
  push(packet) {
    const { timestamp, sequenceNumber, marker } = packet.header;
    if (timestamp === this.completedTimestamp || (this.timestamp !== null && timestamp !== this.timestamp && ((timestamp - this.timestamp) >>> 0) >= 0x80000000)) return null;
    const newFrame = timestamp !== this.timestamp;
    if (timestamp !== this.timestamp) {
      if (this.packets.length) this.discard();
      this.timestamp = timestamp; this.broken = false;
    }
    if (this.broken) return null;
    if (!this.packets.length) {
      try {
        const descriptor = Vp8RtpPayload.deSerialize(packet.payload);
        if (!descriptor.isPartitionHead || descriptor.pid !== 0) { this.lastSequence = sequenceNumber; this.discard(); return null; }
      } catch { this.discard(); return null; }
    }
    if (newFrame && this.lastSequence !== null && sequenceNumber !== ((this.lastSequence + 1) & 65535)) { this.waiting = true; this.requestKeyframe(); }
    const last = this.packets.at(-1)?.header.sequenceNumber;
    if ((last !== undefined && sequenceNumber !== ((last + 1) & 65535)) ||
        this.bytes + packet.payload.length > this.maxBytes || this.packets.length >= this.maxPackets) { this.discard(); return null; }
    this.packets.push(packet); this.bytes += packet.payload.length;
    this.lastSequence = sequenceNumber;
    if (!marker) return null;
    try {
      const frame = dePacketizeRtpPackets('VP8', this.packets);
      const data = frame.data, keyframe = frame.isKeyframe;
      if (this.waiting && !keyframe) { this.requestKeyframe(); return null; }
      let width, height;
      if (keyframe) {
        if (data.length < 10 || data[0] & 1 || !data.subarray(3, 6).equals(Buffer.from([0x9d, 0x01, 0x2a]))) { this.discard(); return null; }
        width = data.readUInt16LE(6) & 0x3fff; height = data.readUInt16LE(8) & 0x3fff;
        if (!width || !height || width > 8192 || height > 8192) { this.discard(); return null; }
      }
      if (this.lastClock !== null) {
        const delta = (timestamp - this.lastClock) >>> 0;
        if (delta >= 0x80000000) { this.discard(); return null; }
        this.clock += delta;
      }
      this.lastClock = timestamp; this.waiting = false; this.completedTimestamp = timestamp;
      return { data, keyframe, width, height, timestamp: Math.round(this.clock * 1000000 / 90000) };
    } catch { this.discard(); return null; }
    finally { this.packets = []; this.bytes = 0; }
  }
}
