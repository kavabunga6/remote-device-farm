import { diagnostic } from './diagnostics.mjs';
const BLOCKED_DEVICE_SERVICE = /^(tcpip|usb|root|unroot|remount|disable-verity|enable-verity|sideload|sideload-host|restore)(:|$)/;
const safeHostServices = new Set(['host:version', 'host:features', 'host:host-features', 'host:devices', 'host:devices-l']);
const safeSerialServices = new Set(['get-state', 'get-serialno', 'features']);

function frame(service) {
  const payload = Buffer.from(service, 'utf8');
  if (payload.length > 4096) throw new Error(diagnostic('adb-proxy.d50d07dd81'));
  return Buffer.concat([Buffer.from(payload.length.toString(16).padStart(4, '0'), 'ascii'), payload]);
}

export function adbFailure(message) {
  const payload = Buffer.from(message, 'utf8');
  return Buffer.concat([Buffer.from('FAIL', 'ascii'), Buffer.from(payload.length.toString(16).padStart(4, '0'), 'ascii'), payload]);
}

export class AdbServerFilter {
  constructor(serial) {
    this.serial = serial;
    this.buffer = Buffer.alloc(0);
    this.state = 'first';
    this.pending = Buffer.alloc(0);
    this.serverBuffer = Buffer.alloc(0);
  }

  transform(bytes) {
    if (this.state === 'raw') return [bytes];
    if (this.state === 'transport-wait' || this.state === 'device-wait') {
      this.pending = Buffer.concat([this.pending, bytes]);
      if (this.pending.length > 1024 * 1024) throw new Error(diagnostic('adb-proxy.2786a1a815'));
      return [];
    }
    if (this.state === 'single' || this.state === 'failed') throw new Error(diagnostic('adb-proxy.988af56ba6'));
    this.buffer = Buffer.concat([this.buffer, bytes]);
    if (this.buffer.length < 4) return [];
    const hex = this.buffer.subarray(0, 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error(diagnostic('adb-proxy.6e25e8558d'));
    const length = parseInt(hex, 16);
    if (length < 1 || length > 4096) throw new Error(diagnostic('adb-proxy.efa23f2ea5'));
    if (this.buffer.length < 4 + length) return [];
    const service = this.buffer.subarray(4, 4 + length).toString('utf8');
    const rest = this.buffer.subarray(4 + length);
    this.buffer = Buffer.alloc(0);
    let rewritten;
    if (this.state === 'device-first') {
      if (service.startsWith('host:') || service.startsWith('host-')) {
        throw new Error(diagnostic('adb-proxy.3ac5998512'));
      }
      // ADB reverse lets a process inside the guest connect to the agent's
      // localhost. That crosses the boundary between an untrusted emulator
      // and the agent, which also has access to Docker and other sessions.
      if (service.startsWith('reverse:')) {
        throw new Error(diagnostic('adb-proxy.ad45f70e49'));
      }
      // Services that change how the device itself can be reached or that outlive a session: adbd over TCP/USB
      // mode switches, root/remount/verity, and reboots into bootloader, recovery or sideload.
      if (BLOCKED_DEVICE_SERVICE.test(service) || (service.startsWith('reboot:') && service.length > 'reboot:'.length)) {
        throw new Error(diagnostic('adb-proxy.69c12845e2'));
      }
      this.state = 'device-wait';
      this.pending = rest;
      return [frame(service)];
    }
    if (service === 'host:devices' || service === 'host:devices-l') {
      if (rest.length) throw new Error(diagnostic('adb-proxy.94c3602bed'));
      this.state = 'single';
      const list = Buffer.from(`${this.serial}\tdevice\n`, 'utf8');
      this.syntheticResponse = Buffer.concat([Buffer.from('OKAY', 'ascii'),
        Buffer.from(list.length.toString(16).padStart(4, '0'), 'ascii'), list]);
      return [];
    }
    if (safeHostServices.has(service)) {
      if (rest.length) throw new Error(diagnostic('adb-proxy.94c3602bed'));
      this.state = 'single';
      rewritten = service;
    } else if (service === 'host:transport-any' || service === 'host:transport-local' ||
               service === 'host:transport-usb' || service.startsWith('host:transport:')) {
      this.state = 'transport-wait';
      this.pending = rest;
      rewritten = `host:transport:${this.serial}`;
    } else if (service.startsWith('host-serial:')) {
      const remainder = service.slice('host-serial:'.length);
      const colon = remainder.lastIndexOf(':');
      const action = colon > 0 ? remainder.slice(colon + 1) : '';
      if (!safeSerialServices.has(action) || rest.length) throw new Error(diagnostic('adb-proxy.007be5e2a5'));
      this.state = 'single';
      rewritten = `host-serial:${this.serial}:${action}`;
    } else {
      throw new Error(diagnostic('adb-proxy.007be5e2a5'));
    }
    return [frame(rewritten)];
  }

  fromServer(bytes) {
    if (this.state !== 'transport-wait' && this.state !== 'device-wait') {
      return { toClient: [bytes], toServer: [] };
    }
    this.serverBuffer = Buffer.concat([this.serverBuffer, bytes]);
    if (this.serverBuffer.length < 4) return { toClient: [], toServer: [] };
    const status = this.serverBuffer.subarray(0, 4).toString('ascii');
    if (status !== 'OKAY' && status !== 'FAIL') throw new Error(diagnostic('adb-proxy.f16b46cc8b'));
    const toClient = [this.serverBuffer];
    this.serverBuffer = Buffer.alloc(0);
    if (status === 'FAIL') {
      this.state = 'failed';
      this.pending = Buffer.alloc(0);
      return { toClient, toServer: [] };
    }
    this.state = this.state === 'transport-wait' ? 'device-first' : 'raw';
    const pending = this.pending;
    this.pending = Buffer.alloc(0);
    return { toClient, toServer: pending.length ? this.transform(pending) : [] };
  }
}
