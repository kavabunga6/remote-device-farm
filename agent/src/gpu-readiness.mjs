import { access, readFile, readdir, stat } from 'node:fs/promises';
import { constants } from 'node:fs';

// A registered Docker runtime or a PCI card alone does not establish availability.
// Check the loaded host driver and its attached GPUs; DRI requires a usable device node.
export async function probeGpuReadiness(info, driDevice, fs = { access, readFile, readdir, stat }) {
  const nvidiaReady = async () => {
    if (!info?.Runtimes?.nvidia) return false;
    try {
      const version = await fs.readFile('/proc/driver/nvidia/version', 'utf8');
      if (!/NVRM version:/i.test(version)) return false;
      const devices = await fs.readdir('/proc/driver/nvidia/gpus');
      for (const device of devices) {
        if (!/^[0-9a-f]{4}:[0-9a-f]{2}:[0-9a-f]{2}\.[0-7]$/i.test(device)) continue;
        const details = await fs.readFile(`/proc/driver/nvidia/gpus/${device}/information`, 'utf8');
        if (/^Model:\s+\S/m.test(details) && /^GPU UUID:\s+GPU-/m.test(details)) return true;
      }
    } catch { /* No loaded driver / attached device visible to control. */ }
    return false;
  };
  const driReady = async () => {
    if (!driDevice) return false;
    try {
      if (!(await fs.stat(driDevice)).isCharacterDevice()) return false;
      await fs.access(driDevice, constants.R_OK | constants.W_OK);
      return true;
    } catch { return false; }
  };
  const [nvidiaRuntime, driGpu] = await Promise.all([nvidiaReady(), driReady()]);
  return { nvidiaRuntime, driGpu, gpuCapabilities: [...(nvidiaRuntime ? ['cuda'] : []), ...(driGpu ? ['gpu'] : [])] };
}
