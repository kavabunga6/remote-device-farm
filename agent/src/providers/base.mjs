// Contract shared by every device backend. main.mjs knows nothing about Docker or USB: it asks the
// ProviderRegistry (registry.mjs), which routes each session to the provider that owns it.
//
// A provider owns the whole life of a device session:
//   start/stop     lease and release a device (emulator container, physical phone, ...)
//   recover        rebuild sessions after an agent restart
//   reconcile      report sessions whose device has vanished, so main.mjs can stop them
//   inventory      what this provider can offer right now (sent to the broker)
//   tunnelTarget   how the ADB tunnel reaches the device (null = no tunnel)
//   ops            action name -> handler(session, params); an action absent here is "not supported"

export const CAPABILITIES = Object.freeze({
  VIDEO: 'video', AUDIO: 'audio', TOUCH: 'touch', KEYS: 'keys', ROTATE: 'rotate', FILES: 'files',
  INSTALL: 'install', SHELL: 'shell', LOGS: 'logs', INFO: 'device-info', TUNNEL: 'tunnel',
  ENV: 'env', NETWORK: 'network',
});

export class DeviceProvider {
  /** @param {{kind: string, platform: 'android'}} meta */
  constructor({ kind, platform }) {
    this.kind = kind;
    this.platform = platform;
    this.sessions = new Map();
  }

  /** Action name -> async (session, params, ctx) => data. Overridden by subclasses. */
  get ops() { return {}; }

  /** Capabilities are derived from the ops, so the UI can never see a feature the agent can't run. */
  get capabilities() { return [...this.capabilityMap().entries()].filter(([, actions]) => actions.some((a) => a in this.ops)).map(([c]) => c); }

  capabilityMap() {
    const C = CAPABILITIES;
    return new Map([[C.VIDEO, ['stream-start']], [C.AUDIO, ['audio']], [C.TOUCH, ['input']], [C.KEYS, ['input']],
      [C.ROTATE, ['rotate']], [C.FILES, ['file']], [C.INSTALL, ['app-begin', 'file']], [C.SHELL, ['adb']],
      [C.LOGS, ['logcat']], [C.INFO, ['device-info']], [C.ENV, ['env']], [C.NETWORK, ['network']],
      [C.TUNNEL, []]]);
  }

  async recover() { return []; }
  async reconcile() { return []; }
  /** Heartbeat housekeeping (e.g. enrolling and wiping newly attached physical devices). */
  async maintain() {}
  async inventory() { return []; }
  async start() { throw new Error(`Provider ${this.kind} cannot start sessions`); }
  async stop() { throw new Error(`Provider ${this.kind} cannot stop sessions`); }
  tunnelTarget() { return null; }
  activeSessions() { return [...this.sessions].map(([sessionId, entry]) => ({ sessionId, kind: this.kind, ...this.describe(entry) })); }
  describe() { return {}; }
  /** Node-wide actions (not tied to a session), e.g. the emulator slot policy. */
  get nodeOps() { return {}; }
}
