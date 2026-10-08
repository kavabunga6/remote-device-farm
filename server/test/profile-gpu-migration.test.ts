import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const directory = new URL('../migrations/', import.meta.url);

test('GPU migration preserves software profiles and converts only configured hardware support', async () => {
  const db = new PGlite();
  try {
    for (const name of (await readdir(directory)).filter(name => /^\d+.*\.sql$/.test(name) && Number(name.slice(0, 3)) < 39).sort()) {
      await db.exec(await readFile(new URL(name, directory), 'utf8'));
    }
    const main = 'registry.example/emu:software';
    const alternate = 'registry.example/emu:cuda';
    const cases = [
      { id: 'plain', support: 'none' },
      { id: 'mixed-case-gpu-env', support: 'none',
        env: { gpu_accelerated: 'enc:v1:lower', Gpu_Accelerated: 'enc:v1:mixed', GPU_ACCELERATED_EXTRA: 'enc:v1:unrelated' },
        keptEnv: { GPU_ACCELERATED_EXTRA: 'enc:v1:unrelated' } },
      { id: 'dri-metadata-only', options: { gpu: { kind: 'dri' } }, support: 'none' },
      { id: 'unused-gpu-memory', gpuMemory: 8192, support: 'none' },
      { id: 'cuda-alternate', gpuImage: alternate, gpuMemory: 6144, support: 'cuda', image: alternate, memory: 6144 },
      { id: 'cuda-main', mode: 'nvidia', support: 'cuda' },
      { id: 'dri-alternate', gpuImage: alternate, options: { gpu: { kind: 'dri' } }, support: 'gpu', image: alternate },
      { id: 'already-disabled', gpuImage: alternate, enabled: false, support: 'cuda', image: alternate },
      { id: 'standard-flags', gpuImage: alternate, options: { gpu: { flags: { software: ['-gpu', 'swiftshader_indirect'], accelerated: ['-gpu', 'host'] } } }, support: 'cuda', image: alternate },
      { id: 'standard-env', gpuImage: alternate, options: { gpu: { env: { accelerated: { GPU_ACCELERATED: 'true' } } } }, support: 'cuda', image: alternate },
      { id: 'standard-software-env', gpuImage: alternate, options: { gpu: { env: { software: { GPU_ACCELERATED: 'false' } } } }, support: 'cuda', image: alternate },
      { id: 'standard-caps-reordered', gpuImage: alternate, options: { gpu: { capabilities: ['display', 'utility', 'compute', 'graphics'] } }, support: 'cuda', image: alternate },
      { id: 'custom-flags', gpuImage: alternate, options: { gpu: { flags: { accelerated: ['-gpu', 'angle_indirect'] } } }, support: 'cuda', image: alternate, disabled: true },
      { id: 'custom-env', gpuImage: alternate, options: { gpu: { env: { accelerated: { OTHER_MODE: 'special' } } } }, support: 'cuda', image: alternate, disabled: true },
      { id: 'custom-video', gpuImage: alternate, options: { gpu: { capabilities: ['compute', 'utility', 'graphics', 'display', 'video'] } }, support: 'cuda', image: alternate, disabled: true },
    ];
    for (const item of cases) {
      await db.query(`INSERT INTO profiles(id,name,android_version,image,cpu,memory_mb,disk_gb,gpu_mode,gpu_image,gpu_memory_mb,docker_options,container_env,enabled)
        VALUES($1,$1,'13',$2,4,4096,16,$3,$4,$5,$6,$7,$8)`,
      [item.id, main, item.mode ?? 'software', item.gpuImage ?? null, item.gpuMemory ?? null,
        { shmSizeMb: 512, ...item.options }, { KEEP_ME: 'enc:v1:opaque', GPU_ACCELERATED: 'enc:v1:old-mode', ...item.env }, item.enabled ?? true]);
    }
    await db.exec(await readFile(new URL('039_profile_gpu_support.sql', directory), 'utf8'));
    const failures: string[] = [];
    for (const item of cases) {
      const row = (await db.query('SELECT * FROM profiles WHERE id=$1', [item.id])).rows[0]!;
      try {
        assert.equal(row.gpu_support, item.support, `${item.id}: support`);
        assert.equal(row.image, item.image ?? main, `${item.id}: main image`);
        assert.equal(row.memory_mb, item.memory ?? 4096, `${item.id}: shared memory`);
        assert.equal(row.enabled, item.disabled ? false : item.enabled ?? true, `${item.id}: enabled`);
        assert.deepEqual(row.docker_options, { shmSizeMb: 512 }, `${item.id}: keep unrelated Docker options`);
        assert.deepEqual(row.container_env, { KEEP_ME: 'enc:v1:opaque', ...item.keptEnv }, `${item.id}: keep unrelated encrypted variables`);
        assert.equal(row.gpu_image, item.gpuImage ?? null, `${item.id}: keep legacy image column for recovery`);
        assert.equal(row.gpu_memory_mb, item.gpuMemory ?? null, `${item.id}: keep legacy memory column for recovery`);
      } catch (error) { failures.push(String(error)); }
    }
    assert.deepEqual(failures, []);
    await assert.rejects(db.query("UPDATE profiles SET gpu_support='nvidia' WHERE id='plain'"), /check constraint/);
  } finally { await db.close(); }
});
