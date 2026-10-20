// Shared wire contract for provider reports, stored inventories and browser/API consumers.
export { normalizePhysicalDevices as cleanPhysicalDevices,
  physicalDevicesFromProviderReports as physicalDevicesFromProviders } from './generated/device-contract.js';
export type { DeviceDescriptor as PhysicalDevice } from './generated/device-contract.js';
