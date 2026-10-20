// Image operations do not change reported slots, devices or node policy. Their
// reply must not wait for Android reconciliation and host telemetry collection;
// the ordinary periodic heartbeat continues to refresh that information.
const IMAGE_NODE_ACTIONS = new Set(['emulator-catalog', 'emulator-build', 'emulator-cancel', 'emulator-jobs', 'image-prewarm', 'image-cache','image-cache-remove']);

export async function dispatchNodeAction(action, params, { registry, announce }) {
  const result = await registry.nodeAction(action, params);
  if (!IMAGE_NODE_ACTIONS.has(action)) await announce('heartbeat');
  return result;
}

// Keep device-control latency independent of slow session operations. Only a
// captured scrcpy route may bypass the lock for keys/text; adb fallback keeps it.
export function dispatchCommand(message, { command, withSessionLock, registry, streams, validateSessionId, assertInputFresh = () => {} }) {
  if (message.action === 'input') assertInputFresh();
  if (message.action === 'input' && ['key', 'text'].includes(message.params?.kind)) {
    const sessionId = validateSessionId(message.sessionId);
    const { provider, session } = registry.require(sessionId);
    if (!provider.ops.input) throw new Error('"input" is not supported for ' + provider.kind + ' devices');
    const realtimeInput = streams.realtimeInput(sessionId, session.serial, message.params);
    if (realtimeInput) { assertInputFresh(); return realtimeInput(); }
  }
  const realtime = ['webviews', 'ui-tree', 'ui-tap', 'appium', 'input-open', 'input-release', 'rtc-offer', 'rtc-close', 'rtc-renew', 'rtc-capabilities'].includes(message.action) || message.action === 'video-keyframe' || message.action === 'logcat' || message.action === 'logcat-apps' ||
    message.action === 'device-info' || (message.action === 'input' && message.params?.kind === 'touch');
  return realtime || registry.isNodeAction(message.action)
    ? command() : withSessionLock(message.sessionId, () => {
      if (message.action === 'input') assertInputFresh();
      return command();
    });
}
