import { diagnostic } from './diagnostics.mjs';
import { setTimeout as delay } from 'node:timers/promises';

// Android's InputReader viewport is authoritative: emulator sensor rotation can
// differ from app/user orientation. Frames and deviceSize here are rotated.
export function parseTouchGeometry(output) {
  const lines = String(output).split(/\r?\n/);
  const viewport = lines.find(line => /Viewport/i.test(line) && /displayId[=:]\s*0(?:[,\s}]|$)/.test(line) &&
    !/valid=false|isActive=false/.test(line) && /orientation[=:]\s*[0-3]/.test(line));
  if (viewport) {
    const rotation = Number(viewport.match(/orientation[=:]\s*([0-3])/)[1]);
    const size = viewport.match(/deviceSize[=:]\s*\[\s*(\d+)\s*,\s*(\d+)\s*\]/);
    const frame = viewport.match(/physicalFrame[=:]\s*\[\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\]/);
    if (!size || !frame) throw new Error(diagnostic('touch-geometry.39f91ec355'));
    const [deviceWidth, deviceHeight] = size.slice(1).map(Number);
    const [left, top, right, bottom] = frame.slice(1).map(Number);
    if (deviceWidth < 1 || deviceHeight < 1 || deviceWidth > 8192 || deviceHeight > 8192 ||
        left >= right || top >= bottom || right > deviceWidth || bottom > deviceHeight) {
      throw new Error(diagnostic('touch-geometry.739bf5e0ae'));
    }
    const logical = viewport.match(/logicalFrame[=:]\s*\[\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\]/);
    const logicalSize = logical ? { logicalWidth: Number(logical[3]) - Number(logical[1]),
      logicalHeight: Number(logical[4]) - Number(logical[2]) } : {};
    if (logical && (logicalSize.logicalWidth < 1 || logicalSize.logicalHeight < 1 ||
        logicalSize.logicalWidth > 16384 || logicalSize.logicalHeight > 16384)) throw new Error(diagnostic('touch-geometry.ea9e90c37c'));
    return { rotation, width: rotation % 2 ? deviceHeight : deviceWidth,
      height: rotation % 2 ? deviceWidth : deviceHeight, physicalFrame: { left, top, right, bottom }, ...logicalSize };
  }
  // Older Android releases expose only this field. The emulator's hardware
  // dimensions from getStatus remain in effect for this legacy case.
  const legacy = String(output).match(/SurfaceOrientation:\s*([0-3])(?:\s|$)/);
  if (legacy) return { rotation: Number(legacy[1]) };
  throw new Error(diagnostic('touch-geometry.7e82887c35'));
}

export async function readTouchGeometry(adb, serial, signal) {
  const result = await adb.run(serial, ['shell', 'dumpsys', 'input'],
    { timeoutMs: 1500, maxOutputBytes: 512 * 1024, signal });
  signal?.throwIfAborted();
  if (result.exitCode !== 0) throw new Error(diagnostic('touch-geometry.b3f17d966c'));
  return parseTouchGeometry(result.stdout);
}

// scrcpy 4.1 DisplayMonitor observes real DisplayInfo size AND rotation, including
// 180-degree turns with unchanged dimensions and app orientation locks. Its
// verbose transition precedes the encoder reset. Codec session headers provide
// a second invalidation signal even if diagnostic output is split/delayed.
export function parseTouchGeometryChange(line) {
  const match = String(line).match(/DisplayMonitor:.* -> (?:(\d+)x(\d+) \[rotation=([0-3])\]|(\(unknown\)))/);
  return match ? (match[3] === undefined ? { rotation: null } :
    { rotation: Number(match[3]), logicalWidth: Number(match[1]), logicalHeight: Number(match[2]) }) : null;
}

export class TouchGeometryCache {
  constructor({ adb, serial, signal, read = readTouchGeometry }) {
    this.adb = adb;
    this.serial = serial;
    this.signal = signal;
    this.read = read;
    this.revision = 0;
    this.geometry = null;
    this.pending = null;
    this.closed = false;
    this.expectedDisplay = { rotation: null };
  }

  invalidate(expectedDisplay = this.expectedDisplay) {
    if (this.closed) return;
    this.revision++;
    this.expectedDisplay = expectedDisplay;
    this.geometry = null;
    // Prefetch on the display event, not on the user's next ordinary touch.
    void this.get().catch(() => {});
  }

  get() {
    if (this.closed) return Promise.reject(new Error(diagnostic('touch-geometry.c916e91dc2')));
    if (this.geometry) return Promise.resolve(this.geometry);
    if (this.pending) return this.pending;
    this.pending = (async () => {
      const deadline = Date.now() + 1500;
      for (;;) {
        const revision = this.revision;
        const geometry = await this.read(this.adb, this.serial, this.signal);
        this.signal?.throwIfAborted();
        if (this.closed) throw new Error(diagnostic('touch-geometry.c916e91dc2'));
        // A display transition during dumpsys makes that snapshot uncertain.
        if (revision !== this.revision) continue;
        // DisplayManager can notify before InputReader applies its new viewport.
        // Do not certify an old orientation merely because dumpsys returned fast.
        const expected = this.expectedDisplay;
        const rotationPending = expected.rotation !== null && geometry.rotation !== expected.rotation;
        const sizePending = expected.logicalWidth && geometry.logicalWidth &&
          (geometry.logicalWidth !== expected.logicalWidth || geometry.logicalHeight !== expected.logicalHeight);
        if (rotationPending || sizePending) {
          if (Date.now() >= deadline) throw new Error(diagnostic('touch-geometry.aed5114bbe'));
          await delay(10, undefined, { signal: this.signal });
          continue;
        }
        this.geometry = geometry;
        return geometry;
      }
    })().finally(() => { this.pending = null; });
    return this.pending;
  }

  close() { this.closed = true; this.geometry = null; }
}
