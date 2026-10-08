export type PhysicalDevice = {
  kind: 'usb-android';
  platform: 'android';
  id: string;
  model: string | null;
  state: string;
  reason: string | null;
};

const text = (value: unknown, max: number): string | null =>
  typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, max) || null : null;

// Both incoming heartbeats and older stored inventories must contain physical devices, not provider capacity.
export function cleanPhysicalDevices(input: unknown): PhysicalDevice[] {
  if (!Array.isArray(input)) return [];
  return input.slice(0, 256).flatMap((item): PhysicalDevice[] => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const device = item as Record<string, unknown>;
    if (device.kind !== 'usb-android' || typeof device.id !== 'string' || !device.id.trim() ||
        device.id.length > 100 || /[\x00-\x1f\x7f]/.test(device.id)) return [];
    return [{ kind: 'usb-android', platform: 'android', id: device.id,
      model: text(device.model ?? device.name, 100), state: text(device.state, 32) || 'unverified',
      reason: text(device.reason, 300) }];
  });
}

export function physicalDevicesFromProviders(input: unknown): PhysicalDevice[] {
  if (!Array.isArray(input)) return [];
  return cleanPhysicalDevices(input.slice(0, 8).flatMap(provider => {
    if (!provider || typeof provider !== 'object' || Array.isArray(provider)) return [];
    const record = provider as Record<string, unknown>;
    if (record.kind !== 'usb-android' || !Array.isArray(record.devices)) return [];
    return record.devices.slice(0, 256).flatMap(device =>
      device && typeof device === 'object' && !Array.isArray(device)
        ? [{ ...device, kind: record.kind }] : []);
  }));
}
