// The generated declarations are inserted by scripts/sync-device-contract.mjs.
// @device-contract-declarations
const boundedText = (value: unknown, max: number): string | null =>
  typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, max) || null : null;

export function devicePlatform(kind: unknown): DevicePlatform | null {
  return typeof kind === 'string' && (DEVICE_KINDS as readonly string[]).includes(kind) ? 'android' : null;
}
export function normalizeCapabilities(value: unknown): DeviceCapability[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.slice(0, 32).filter((item): item is DeviceCapability =>
    typeof item === 'string' && (DEVICE_CAPABILITIES as readonly string[]).includes(item)))];
}
export function normalizeCapabilityReasons(value: unknown): DeviceCapabilityReasons {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const reasons: DeviceCapabilityReasons = {};
  for (const [key, reason] of Object.entries(value)) {
    if ((DEVICE_CAPABILITIES as readonly string[]).includes(key) && typeof reason === 'string' &&
        (DEVICE_CAPABILITY_REASONS as readonly string[]).includes(reason)) reasons[key] = reason as DeviceCapabilityReason;
  }
  return reasons;
}
/** Normalize stored and incoming inventories; unknown state never makes a device available. */
export function normalizePhysicalDevices(value: unknown): DeviceDescriptor[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 256).flatMap((item): DeviceDescriptor[] => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const d = item as Record<string, unknown>;
    if (typeof d.kind !== 'string' || !(PHYSICAL_DEVICE_KINDS as readonly string[]).includes(d.kind) ||
        (d.platform !== undefined && d.platform !== null && d.platform !== devicePlatform(d.kind)) ||
        typeof d.id !== 'string' || !d.id.trim() || d.id.length > 100 || /[\x00-\x1f\x7f]/.test(d.id)) return [];
    const device: DeviceDescriptor = {
      kind: d.kind as PhysicalDeviceKind, platform: devicePlatform(d.kind)!, id: d.id,
      model: boundedText(d.model ?? d.name, 100),
      state: typeof d.state === 'string' && (DEVICE_AVAILABILITIES as readonly string[]).includes(d.state)
        ? d.state as DeviceAvailability : 'unverified',
      reason: boundedText(d.reason, 300),
    };
    if ('osVersion' in d) device.osVersion = boundedText(d.osVersion, 64);
    if ('sdkLevel' in d) device.sdkLevel = typeof d.sdkLevel === 'number' && Number.isInteger(d.sdkLevel) &&
      d.sdkLevel >= 1 && d.sdkLevel <= 1000 ? d.sdkLevel : null;
    if (Array.isArray(d.capabilities)) device.capabilities = normalizeCapabilities(d.capabilities);
    if (d.capabilityReasons && typeof d.capabilityReasons === 'object') device.capabilityReasons = normalizeCapabilityReasons(d.capabilityReasons);
    return [device];
  });
}
export function physicalDevicesFromProviderReports(value: unknown): DeviceDescriptor[] {
  if (!Array.isArray(value)) return [];
  return normalizePhysicalDevices(value.slice(0, 8).flatMap(provider => {
    if (!provider || typeof provider !== 'object' || Array.isArray(provider)) return [];
    const p = provider as Record<string, unknown>;
    if (typeof p.kind !== 'string' || !(PHYSICAL_DEVICE_KINDS as readonly string[]).includes(p.kind) ||
        (p.platform !== undefined && p.platform !== devicePlatform(p.kind)) || !Array.isArray(p.devices)) return [];
    return p.devices.slice(0, 256).flatMap(device => device && typeof device === 'object' && !Array.isArray(device)
      ? [{ ...device, kind: p.kind, platform: p.platform ?? devicePlatform(p.kind) }] : []);
  }));
}
