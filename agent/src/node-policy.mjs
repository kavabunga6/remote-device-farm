export const MAX_NODE_SLOTS = 32;

export function validateNodePolicy(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).some((key) => !['revision', 'slots', 'slotCpu', 'slotMemoryMb'].includes(key))) {
    throw new Error('Invalid node policy');
  }
  const { revision, slots, slotCpu, slotMemoryMb } = input;
  if (!Number.isSafeInteger(revision) || revision < 0 || revision > 1_000_000_000 ||
      !Number.isSafeInteger(slots) || slots < 0 || slots > MAX_NODE_SLOTS ||
      !Number.isSafeInteger(slotCpu) || slotCpu < 1 || slotCpu > 16 ||
      !Number.isSafeInteger(slotMemoryMb) || slotMemoryMb < 1024 || slotMemoryMb > 65536) {
    throw new Error('Invalid node policy');
  }
  return { revision, slots, slotCpu, slotMemoryMb };
}

export function assertProfileWithinPolicy(profile, policy) {
  if (profile.cpu > policy.slotCpu) throw new Error('Profile CPU exceeds node per-slot limit');
  if (profile.memoryMb > policy.slotMemoryMb) throw new Error('Profile memory exceeds node per-slot limit');
}
