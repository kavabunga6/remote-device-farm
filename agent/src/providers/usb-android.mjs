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
    this.shared = androidOps({ adb, streams, appTransfers });
    this.streamsStop = (id) => streams.stop?.(id);
  }

  get ops() { return this.shared; }
  describe(entry) { return { deviceSerial: entry.serial }; }
  deviceId(entry) { return entry.serial; }

  async list() {
    const result = await this.execute('adb', ['devices', '-l'], { timeoutMs: 5000, maxOutputBytes: 64 * 1024 });
    if (result.exitCode !== 0) throw new Error('ADB device list is unavailable');
    return parseUsbDevices(result.stdout).filter((d) => !this.allowlist || this.allowlist.has(d.serial));
  }

  async inventory() {
    return (await this.list()).map((d) => ({ id: d.serial, model: d.model, hwState: d.state,
      state: this.deviceState(d.serial, d.state === 'device' ? 'free' : d.state),
      reason: this.store.reason(this.key(d.serial)) }));
  }

  async listIds() { return (await this.list()).filter((d) => d.state === 'device').map((d) => d.serial); }
  async isPresent(serial) { return (await this.list()).some((d) => d.serial === serial && d.state === 'device'); }
  restoredEntry(serial) { return { serial, model: null }; }

  async reconcile() {
    const present = new Set((await this.list()).filter((d) => d.state === 'device').map((d) => d.serial));
    return [...this.sessions].filter(([, e]) => !present.has(e.serial)).map(([id]) => id);
  }

  tunnelTarget(s) { return { deviceTcp: null, adbServer: 'shared', serial: s.serial }; }

  async start(sessionId, params) {
    const wanted = params?.deviceSerial;
    if (wanted !== undefined && (typeof wanted !== 'string' || !SERIAL_RE.test(wanted))) throw new Error('Invalid device serial');
    const usable = (d) => d.state === 'device' && this.deviceState(d.serial) === 'free';
    const devices = await this.list();
    const device = wanted ? devices.find((d) => d.serial === wanted) : devices.find(usable);
    if (!device) throw new Error(wanted ? 'USB device is not connected' : 'No free USB devices');
    if (device.state !== 'device') throw new Error(`USB device is ${device.state}; authorize this host's ADB key on the phone`);
    await this.lease(sessionId, { serial: device.serial, model: device.model });
    return { deviceSerial: device.serial, model: device.model };
  }

  async beforeWipe(sessionId, entry) {
    await this.streamsStop?.(sessionId);
  }
}
