import { t } from './i18n';
import type { DeviceKind, DeviceSession, DeviceState, Host, HostDevice } from './api';

// Capabilities as reported by the agent: video, audio, touch, keys, rotate, files, install, shell, logs,
// device-info, env, network. A session without a list (all emulators) can do everything.
export type Capability = 'video' | 'audio' | 'touch' | 'keys' | 'rotate' | 'files' | 'install' | 'shell' | 'logs' | 'device-info' | 'env' | 'network';

export function hasCapability(session: Pick<DeviceSession, 'capabilities'> | null | undefined, capability: Capability): boolean {
  const list = session?.capabilities;
  return !Array.isArray(list) || list.includes(capability);
}

export const DEVICE_KIND_LABEL: Record<DeviceKind, string> = { get 'usb-android'() { return t('ui.d6371a43262b'); } };

export const DEVICE_STATE_LABEL: Record<string, string> = {
  get free() { return t('ui.e12e9dbb8eef'); }, get busy() { return t('ui.7475b13d966d'); }, get cleaning() { return t('ui.24c0edd7580d'); }, get unverified() { return t('ui.bc02a339e798'); }, get quarantined() { return t('ui.372ad83b072d'); },
  get unauthorized() { return t('ui.c617bb37a2ff'); }, get offline() { return t('ui.b528560dd90f'); },
};
export const deviceStateLabel = (state: DeviceState): string => DEVICE_STATE_LABEL[state] ?? state;

/** Ignore provider capacity records and normalize the physical-device inventory. */
export function physicalDevices(value: unknown): HostDevice[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(item => {
    if (!item || typeof item !== 'object' || item.kind !== 'usb-android' || typeof item.id !== 'string' || !item.id.trim()) return [];
    return [{
      kind: 'usb-android' as const,
      id: item.id,
      platform: typeof item.platform === 'string' ? item.platform : null,
      model: typeof item.model === 'string' ? item.model : null,
      state: typeof item.state === 'string' && item.state ? item.state : 'unverified',
      reason: typeof item.reason === 'string' ? item.reason : null,
    }];
  });
}

export interface RentableDevice { host: Host; device: HostDevice }

// Devices a user can rent right now: on an online, enabled host and reported free.
export function rentableDevices(hosts: Host[]): RentableDevice[] {
  return hosts.filter(host => host.status === 'online' && !host.disabled)
    .flatMap(host => physicalDevices(host.devices).filter(device => device.state === 'free').map(device => ({ host, device })));
}
