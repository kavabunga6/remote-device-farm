import { diagnostic } from './diagnostics.mjs';
export class SlotReservations {
  constructor() { this.pending = new Map(); }

  async run(sessionId, occupied, host, profile, work) {
    const running = [...occupied()];
    const reservations = [...this.pending.values()];
    if (this.pending.has(sessionId) || running.length + reservations.length >= host.slots) {
      throw new Error(diagnostic('capacity.5272679655'));
    }
    const cpuHeadroom = Math.max(1, Math.ceil(host.cpuCores * 0.2));
    const memoryHeadroomMb = Math.ceil(host.memoryTotalMb * 0.2);
    const usedCpu = [...running, ...reservations].reduce((sum, entry) => sum + entry.cpu, 0);
    const usedMemoryMb = [...running, ...reservations].reduce((sum, entry) => sum + entry.memoryMb, 0);
    const pendingMemoryMb = reservations.reduce((sum, entry) => sum + entry.memoryMb, 0);
    if (usedCpu + profile.cpu > host.cpuCores - cpuHeadroom) {
      throw new Error(diagnostic('capacity.70c6566283'));
    }
    if (usedMemoryMb + profile.memoryMb > host.memoryTotalMb - memoryHeadroomMb ||
        pendingMemoryMb + profile.memoryMb > host.memoryAvailableMb - memoryHeadroomMb) {
      throw new Error(diagnostic('capacity.f8fbe0ead3'));
    }
    this.pending.set(sessionId, { cpu: profile.cpu, memoryMb: profile.memoryMb });
    try { return await work(); }
    finally { this.pending.delete(sessionId); }
  }
}