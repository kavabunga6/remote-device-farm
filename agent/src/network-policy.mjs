import policy from './network-policy.json' with { type: 'json' };

// A locally administered address, reused only on separate per-session bridges.
// The host firewall reads the same resource. Emulator endpoints retain Docker's
// own addresses and cannot spoof this identity without raw/admin capabilities.
export const MANAGEMENT_AGENT_MAC = policy.managementAgentMac;
