export class SlotReservations {
  constructor() { this.pending = new Map(); }

  async run(sessionId, occupied, host, profile, work) {
    const running = [...occupied()];
    const reservations = [...this.pending.values()];
    if (this.pending.has(sessionId) || running.length + reservations.length >= host.slots) {
      throw new Error('No free emulator slots');
    }
    const cpuHeadroom = Math.max(1, Math.ceil(host.cpuCores * 0.2));
    const memoryHeadroomMb = Math.ceil(host.memoryTotalMb * 0.2);
    const usedCpu = [...running, ...reservations].reduce((sum, entry) => sum + entry.cpu, 0);
    const usedMemoryMb = [...running, ...reservations].reduce((sum, entry) => sum + entry.memoryMb, 0);
    const pendingMemoryMb = reservations.reduce((sum, entry) => sum + entry.memoryMb, 0);
    if (usedCpu + profile.cpu > host.cpuCores - cpuHeadroom) {
      throw new Error('Not enough host CPU capacity for this emulator profile');
    }
    if (usedMemoryMb + profile.memoryMb > host.memoryTotalMb - memoryHeadroomMb ||
        pendingMemoryMb + profile.memoryMb > host.memoryAvailableMb - memoryHeadroomMb) {
      throw new Error('Not enough host memory for this emulator profile');
    }
    this.pending.set(sessionId, { cpu: profile.cpu, memoryMb: profile.memoryMb });
    try { return await work(); }
    finally { this.pending.delete(sessionId); }
  }
}