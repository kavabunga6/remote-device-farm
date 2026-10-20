// Generated from shared/device-contract.schema.json and device-contract-runtime.ts.
// Run node scripts/sync-device-contract.mjs to update.
// The generated declarations are inserted by scripts/sync-device-contract.mjs.
export const DEVICE_CONTRACT_VERSION = 1;
export const DEVICE_PLATFORMS = ["android"];
export const DEVICE_KINDS = ["emulator", "usb-android"];
export const PHYSICAL_DEVICE_KINDS = ["usb-android"];
export const DEVICE_CAPABILITIES = ["video", "audio", "touch", "keys", "rotate", "files", "install", "shell", "logs", "device-info", "env", "network", "screenshot", "tunnel"];
export const DEVICE_AVAILABILITIES = ["free", "busy", "cleaning", "unverified", "quarantined", "unauthorized", "offline", "recovery", "bootloader", "sideload"];
export const DEVICE_CAPABILITY_REASONS = ["not-supported", "android-version-unsupported", "device-probe-unavailable"];
export const DEVICE_PROVIDER_STATES = ["ready", "unavailable", "unknown"];
export const DEVICE_PROVIDER_CODES = ["inventory-unavailable", "maintenance-unavailable", "reconcile-unavailable"];
const boundedText = (value, max) => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, max) || null : null;
export function devicePlatform(kind) {
    return typeof kind === 'string' && DEVICE_KINDS.includes(kind) ? 'android' : null;
}
export function normalizeCapabilities(value) {
    if (!Array.isArray(value))
        return [];
    return [...new Set(value.slice(0, 32).filter((item) => typeof item === 'string' && DEVICE_CAPABILITIES.includes(item)))];
}
export function normalizeCapabilityReasons(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return {};
    const reasons = {};
    for (const [key, reason] of Object.entries(value)) {
        if (DEVICE_CAPABILITIES.includes(key) && typeof reason === 'string' &&
            DEVICE_CAPABILITY_REASONS.includes(reason))
            reasons[key] = reason;
    }
    return reasons;
}
/** Normalize stored and incoming inventories; unknown state never makes a device available. */
export function normalizePhysicalDevices(value) {
    if (!Array.isArray(value))
        return [];
    return value.slice(0, 256).flatMap((item) => {
        if (!item || typeof item !== 'object' || Array.isArray(item))
            return [];
        const d = item;
        if (typeof d.kind !== 'string' || !PHYSICAL_DEVICE_KINDS.includes(d.kind) ||
            (d.platform !== undefined && d.platform !== null && d.platform !== devicePlatform(d.kind)) ||
            typeof d.id !== 'string' || !d.id.trim() || d.id.length > 100 || /[\x00-\x1f\x7f]/.test(d.id))
            return [];
        const device = {
            kind: d.kind, platform: devicePlatform(d.kind), id: d.id,
            model: boundedText(d.model ?? d.name, 100),
            state: typeof d.state === 'string' && DEVICE_AVAILABILITIES.includes(d.state)
                ? d.state : 'unverified',
            reason: boundedText(d.reason, 300),
        };
        if ('osVersion' in d)
            device.osVersion = boundedText(d.osVersion, 64);
        if ('sdkLevel' in d)
            device.sdkLevel = typeof d.sdkLevel === 'number' && Number.isInteger(d.sdkLevel) &&
                d.sdkLevel >= 1 && d.sdkLevel <= 1000 ? d.sdkLevel : null;
        if (Array.isArray(d.capabilities))
            device.capabilities = normalizeCapabilities(d.capabilities);
        if (d.capabilityReasons && typeof d.capabilityReasons === 'object')
            device.capabilityReasons = normalizeCapabilityReasons(d.capabilityReasons);
        return [device];
    });
}
export function physicalDevicesFromProviderReports(value) {
    if (!Array.isArray(value))
        return [];
    return normalizePhysicalDevices(value.slice(0, 8).flatMap(provider => {
        if (!provider || typeof provider !== 'object' || Array.isArray(provider))
            return [];
        const p = provider;
        if (p.status === 'unavailable' || typeof p.kind !== 'string' || !PHYSICAL_DEVICE_KINDS.includes(p.kind) ||
            (p.platform !== undefined && p.platform !== devicePlatform(p.kind)) || !Array.isArray(p.devices))
            return [];
        return p.devices.slice(0, 256).flatMap(device => device && typeof device === 'object' && !Array.isArray(device)
            ? [{ ...device, kind: p.kind, platform: p.platform ?? devicePlatform(p.kind) }] : []);
    }));
}
/** Unknown providers and missing physical-device reports never gain implicit features. */
export function sessionCapabilities(kind, value) {
    if (!devicePlatform(kind))
        return [];
    if (Array.isArray(value))
        return normalizeCapabilities(value);
    return kind === 'emulator' ? DEVICE_CAPABILITIES.filter(capability => capability !== 'audio') : [];
}
export function normalizeDeviceMetadata(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return {};
    const record = value;
    return {
        ...(Array.isArray(record.capabilities) ? { capabilities: normalizeCapabilities(record.capabilities) } : {}),
        osVersion: boundedText(record.osVersion, 64),
        sdkLevel: typeof record.sdkLevel === 'number' && Number.isInteger(record.sdkLevel) && record.sdkLevel >= 1 && record.sdkLevel <= 1000 ? record.sdkLevel : null,
        capabilityReasons: normalizeCapabilityReasons(record.capabilityReasons),
    };
}
/** Provider health is independent from the number of attached devices. */
export function normalizeProviderStatuses(value) {
    if (!Array.isArray(value))
        return [];
    const seen = new Set();
    return value.slice(0, 8).flatMap((item) => {
        if (!item || typeof item !== 'object' || Array.isArray(item))
            return [];
        const record = item, platform = devicePlatform(record.kind);
        if (!platform || (record.platform !== undefined && record.platform !== platform) || seen.has(String(record.kind)))
            return [];
        seen.add(String(record.kind));
        const status = record.status === 'ready' || record.status === 'unavailable' ? record.status : 'unknown';
        return [{ kind: record.kind, platform, status,
                code: status === 'unavailable' && typeof record.code === 'string' && DEVICE_PROVIDER_CODES.includes(record.code)
                    ? record.code : null }];
    });
}
