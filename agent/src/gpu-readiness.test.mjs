import test from 'node:test';
import assert from 'node:assert/strict';
import { probeGpuReadiness } from './gpu-readiness.mjs';

function hostFs({ driver = true, attached = true, character = true, accessible = true } = {}) {
  return {
    readFile: async path => {
      if (path.endsWith('/version')) { if (!driver) throw new Error('absent'); return 'NVRM version: NVIDIA UNIX Open Kernel Module 550.00.00'; }
      if (attached) return 'Model: NVIDIA Example GPU\nGPU UUID: GPU-1234\n';
      throw new Error('absent');
    },
    readdir: async () => attached ? ['0000:03:00.0'] : [],
    stat: async () => ({ isCharacterDevice: () => character }),
    access: async () => { if (!accessible) throw new Error('denied'); },
  };
}

test('CUDA requires both Docker NVIDIA runtime and loaded driver with an attached GPU', async () => {
  assert.deepEqual(await probeGpuReadiness({ Runtimes: { nvidia: {} } }, null, hostFs()), { nvidiaRuntime: true, driGpu: false, gpuCapabilities: ['cuda'] });
  for (const fs of [hostFs({ driver: false }), hostFs({ attached: false })]) {
    assert.deepEqual((await probeGpuReadiness({ Runtimes: { nvidia: {} } }, null, fs)).gpuCapabilities, []);
  }
  assert.deepEqual((await probeGpuReadiness({ Runtimes: {} }, null, hostFs())).gpuCapabilities, []);
});

test('DRI requires a readable and writable character device, not a plain file', async () => {
  for (const fs of [hostFs({ character: false }), hostFs({ accessible: false })]) {
    assert.deepEqual((await probeGpuReadiness({}, '/dev/dri/renderD128', fs)).gpuCapabilities, []);
  }
  assert.deepEqual((await probeGpuReadiness({}, '/dev/dri/renderD128', hostFs())).gpuCapabilities, ['gpu']);
  assert.deepEqual((await probeGpuReadiness({ Runtimes: { nvidia: {} } }, '/dev/dri/renderD128', hostFs())).gpuCapabilities, ['cuda', 'gpu']);
});
