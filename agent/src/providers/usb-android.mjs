import { agentMessage } from '../messages.mjs';
import { probeAndroid, androidCapabilities } from './android-capabilities.mjs';
import { PhysicalDeviceProvider } from './physical.mjs';
import { androidOps } from './android-ops.mjs';

// Starts with an alphanumeric: the serial reaches `adb -s` and the wipe script as an argument, and a USB device
// chooses its own serial, so a leading '-' would be option injection.
const SERIAL_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

// `adb devices -l` -> physical devices only. Emulators ("emulator-5554") and network devices ("host:port")
// are not USB phones; they have no `usb:` field.
export function parseUsbDevices(stdout) {
  return String(stdout).split(/\r?\n/).slice(1).map((line) => {
    const [serial, state, ...rest] = line.trim().split(/\s+/);
    if (!serial || !state || !SERIAL_RE.test(serial)) return null;
    const props = Object.fromEntries(rest.map((x) => x.split(':')).filter((x) => x.length === 2));
    if (!props.usb) return null;
    return { serial, state, model: props.model || null, product: props.product || null, transportId: props.transport_id || null };
  }).filter(Boolean);
}

// Real Android phones attached to the agent host over USB. No Docker, no slots/CPU accounting: one device,
// one lease. The agent's own adb server (the one that owns the USB interface) serves the session tunnel,
// restricted to the leased serial by AdbServerFilter.
export class UsbAndroidProvider extends PhysicalDeviceProvider {
  constructor({ adb, streams, appTransfers, execute, allowlist = null, store, wiper, alert }) {
    super({ kind: 'usb-android', platform: 'android' }, { store, wiper, alert });
    Object.assign(this, { adb, execute, allowlist });
    this.deviceDetails = new Map();
    this.shared = androidOps({ adb, streams, appTransfers });
    this.streamsStop = (id) => streams.stop?.(id);
  }

  get ops() { return this.shared; }
  describe(entry) { return { deviceSerial: entry.serial, ...(entry.details ?? androidCapabilities(this.capabilities, null)) }; }
  sessionCapabilities(entry) { return this.describe(entry).capabilities; }
  deviceId(entry) { return entry.serial; }

  async list() {
    const result = await this.execute('adb', ['devices', '-l'], { timeoutMs: 5000, maxOutputBytes: 64 * 1024 });
    if (result.exitCode !== 0) throw new Error(agentMessage('agent.b9a2aff69247'));
    return parseUsbDevices(result.stdout).filter((d) => !this.allowlist || this.allowlist.has(d.serial));
  }

  async inventory() {
    const devices = await this.list();
    const present = new Set(devices.filter(d => d.state === 'device').map(d => d.serial));
    for (const serial of this.deviceDetails.keys()) if (!present.has(serial)) this.deviceDetails.delete(serial);
    return devices.map(d => ({ id: d.serial, model: d.model, hwState: d.state,
      state: d.state === 'device' ? this.deviceState(d.serial) : d.state,
      reason: this.store.reason(this.key(d.serial)),
      ...((present.has(d.serial) ? this.deviceDetails.get(d.serial) : null) ?? androidCapabilities(this.capabilities, null)),
    }));
  }

  async maintain() {
    await super.maintain();
    // Limit recovery probes per heartbeat; a large USB rack must not stall agent reporting.
    for (const entry of [...this.sessions.values()].filter(entry => !entry.details).slice(0, 2)) {
      entry.details = await probeAndroid(this.adb, entry.serial, this.capabilities);
      this.deviceDetails.set(entry.serial, entry.details);
    }
  }

  async listIds() { return (await this.list()).filter((d) => d.state === 'device').map((d) => d.serial); }
  async isPresent(serial) { return (await this.list()).some((d) => d.serial === serial && d.state === 'device'); }
  restoredEntry(serial) { return { serial, model: null }; }

  async reconcile() {
    const present = new Set((await this.list()).filter((d) => d.state === 'device').map((d) => d.serial));
    return [...this.sessions].filter(([, e]) => !present.has(e.serial)).map(([id]) => id);
  }

  tunnelTarget(s) { return { deviceTcp: null, adbServer: 'shared', serial: s.serial }; }

  async start(sessionId, params, { signal } = {}) {
    const wanted = params?.deviceSerial;
    if (wanted !== undefined && (typeof wanted !== 'string' || !SERIAL_RE.test(wanted))) throw new Error(agentMessage('agent.3d4b5f89dca1'));
    const usable = (d) => d.state === 'device' && this.deviceState(d.serial) === 'free';
    const devices = await this.list();
    const device = wanted ? devices.find((d) => d.serial === wanted) : devices.find(usable);
    if (!device) throw new Error(wanted ? agentMessage('agent.972c3683897a') : agentMessage('agent.4334ae1a7ebf'));
    if (device.state !== 'device') throw new Error(agentMessage('agent.usbAuthorize', { p0: device.state }));
    const details = await probeAndroid(this.adb, device.serial, this.capabilities, { signal });
    signal?.throwIfAborted();
    if (!await this.isPresent(device.serial)) throw new Error(agentMessage('agent.972c3683897a'));
    await this.lease(sessionId, { serial: device.serial, model: device.model, details });
    this.deviceDetails.set(device.serial, details);
    return { ...this.describe(this.sessions.get(sessionId)), model: device.model };
  }

  async beforeWipe(sessionId, entry) {
    await this.streamsStop?.(sessionId);
  }
}
