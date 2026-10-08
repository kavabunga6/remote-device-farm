import { uiMessage } from './messages.js';
import { ApiError } from './http-common.js';

export const MAX_NODE_SLOTS = 32;
export type SlotMode = 'manual' | 'dynamic';
export type NodePolicy = { revision: number; slots: number; slotCpu: number; slotMemoryMb: number };

type HostRow = Record<string, unknown>;

function boundedInteger(value: unknown, min: number, max: number): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max ? value : null;
}

export function parseNodeSettings(input: Record<string, unknown>, current: HostRow) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).some(key => !['displayName', 'slotMode', 'manualSlots', 'slotCpu', 'slotMemoryMb', 'disabled'].includes(key))) {
    throw new ApiError(400, 'invalid_node_settings', uiMessage('ui.87e5d1d05b5c', {}, 'en'));
  }
  const displayName = input.displayName === undefined ? current.display_name : input.displayName;
  const mode = input.slotMode === undefined ? current.slot_mode : input.slotMode;
  const manualSlots = boundedInteger(input.manualSlots === undefined ? current.manual_slots : input.manualSlots, 0, MAX_NODE_SLOTS);
  const slotCpu = boundedInteger(input.slotCpu === undefined ? current.slot_cpu : input.slotCpu, 1, 16);
  const slotMemoryMb = boundedInteger(input.slotMemoryMb === undefined ? current.slot_memory_mb : input.slotMemoryMb, 1024, 65536);
  const disabled = input.disabled === undefined ? current.disabled : input.disabled;
  if ((displayName !== null && (typeof displayName !== 'string' || displayName.trim().length > 120 ||
      /[\x00-\x1f\x7f]/.test(displayName))) ||
      (mode !== 'manual' && mode !== 'dynamic') || manualSlots === null || slotCpu === null ||
      slotMemoryMb === null || typeof disabled !== 'boolean') {
    throw new ApiError(400, 'invalid_node_settings', uiMessage('ui.87e5d1d05b5c', {}, 'en'));
  }
  return { displayName: typeof displayName === 'string' ? displayName.trim() || null : null,
    slotMode: mode as SlotMode, manualSlots, slotCpu, slotMemoryMb, disabled };
}

export function desiredNodePolicy(row: HostRow): NodePolicy {
  const slotCpu = boundedInteger(row.slot_cpu, 1, 16) ?? 4;
  const slotMemoryMb = boundedInteger(row.slot_memory_mb, 1024, 65536) ?? 4096;
  let slots = 0;
  if (row.disabled !== true && row.removed_at == null) {
    if (row.slot_mode === 'dynamic') {
      const metrics = (row.metrics && typeof row.metrics === 'object' ? row.metrics : {}) as Record<string, unknown>;
      const cpu = boundedInteger(metrics.cpuAllocatableCores ?? metrics.cpuCores, 1, 4096) ?? 0;
      const memoryMb = boundedInteger(metrics.memoryAllocatableMb ?? metrics.memoryTotalMb, 1024, 1_000_000_000) ?? 0;
      const cpuForFarm = Math.max(0, cpu - Math.max(1, Math.ceil(cpu * 0.2)));
      const memoryForFarm = Math.max(0, memoryMb - Math.ceil(memoryMb * 0.2));
      slots = Math.min(Math.floor(cpuForFarm / slotCpu), Math.floor(memoryForFarm / slotMemoryMb), MAX_NODE_SLOTS);
    } else slots = boundedInteger(row.manual_slots, 0, MAX_NODE_SLOTS) ?? 1;
  }
  return { revision: boundedInteger(row.policy_revision, 0, 1_000_000_000) ?? 0,
    slots, slotCpu, slotMemoryMb };
}

export function assertProfileFitsNode(row: HostRow, profile: HostRow): void {
  const policy = desiredNodePolicy(row);
  if (Number(profile.cpu) > policy.slotCpu || Number(profile.memory_mb) > policy.slotMemoryMb) {
    throw new ApiError(409, 'profile_exceeds_node_slot', uiMessage('ui.2782688df570', {}, 'en'));
  }
}
