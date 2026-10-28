import { normalizeCapabilities, normalizeCapabilityReasons } from '../generated/device-contract.mjs';

// ADB handlers are necessary but not sufficient for version-dependent scrcpy features.
export function androidCapabilities(available, sdkLevel) {
  const capabilities = normalizeCapabilities(available);
  const capabilityReasons = {};
  const minimumSdk = { video: 21, audio: 30, touch: 21, keys: 21, ui: 18 };
  for (const [feature, minimum] of Object.entries(minimumSdk)) {
    if (!capabilities.includes(feature)) continue;
    if (!Number.isInteger(sdkLevel) || sdkLevel < minimum) {
      capabilities.splice(capabilities.indexOf(feature), 1);
      capabilityReasons[feature] = Number.isInteger(sdkLevel) ? 'android-version-unsupported' : 'device-probe-unavailable';
    }
  }
  return { capabilities, capabilityReasons: normalizeCapabilityReasons(capabilityReasons) };
}

export async function probeAndroid(adb, serial, available, options = {}) {
  let sdkLevel = null, osVersion = null;
  try {
    const result = await adb.run(serial, ['shell', 'getprop'], {
      timeoutMs: 3000, maxOutputBytes: 128 * 1024, ...options,
    });
    if (result.exitCode === 0) {
      const output = String(result.stdout);
      const sdk = /^\[ro\.build\.version\.sdk\]: \[(\d+)\]$/m.exec(output)?.[1];
      if (sdk && Number(sdk) >= 1 && Number(sdk) <= 1000) sdkLevel = Number(sdk);
      osVersion = /^\[ro\.build\.version\.release\]: \[([^\r\n\x00-\x1f\x7f]{1,64})\]$/m.exec(output)?.[1] ?? null;
    }
  } catch { options.signal?.throwIfAborted(); }
  return { sdkLevel, osVersion, ...androidCapabilities(available, sdkLevel) };
}
