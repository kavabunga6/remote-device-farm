import { randomUUID } from 'node:crypto';
import { execInContainer } from './emu-console.mjs';

const CHUNK_BYTES = 24 * 1024;
const failed = () => { throw new Error('container_file_write_failed'); };

// Docker's archive endpoint can write beneath a running tmpfs mount. Execute
// inside the container so camera images and inspector scripts reach that mount.
// Callers verify session ownership before using these fixed runtime directories.
export async function writeContainerFiles(docker, containerId, directory, files, { timeoutMs = 15_000 } = {}) {
  if (!['/rdf-network', '/android-home'].includes(directory) || !Array.isArray(files) ||
      !files.length || files.length > 4 || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 45_000 ||
      files.some(f => !f || typeof f.name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/.test(f.name) ||
        !Buffer.isBuffer(f.data) || f.data.length > 256 * 1024 || ![0o600, 0o644].includes(f.mode)) ||
      files.reduce((n, f) => n + f.data.length, 0) > 512 * 1024) failed();
  const deadline = Date.now() + timeoutMs;
  const run = async (script, env, cleanup = false) => {
    const remaining = cleanup ? 3000 : deadline - Date.now();
    if (remaining < 1) failed();
    const result = await execInContainer(docker, containerId, ['sh', '-c', script], env, remaining, 4096);
    if (result.exitCode || result.truncated) failed();
  };
  for (const file of files) {
    const temporary = directory + '/.rdf-write-' + randomUUID();
    const env = ['RDF_WRITE_FILE=' + temporary];
    let published = false;
    try {
      await run('set -euC; umask 077; : > "$RDF_WRITE_FILE"', env);
      for (let offset = 0; offset < file.data.length; offset += CHUNK_BYTES) {
        // Each environment entry stays below Linux's per-argument limit.
        // Never replay an append after an ambiguous Docker response.
        await run('set -eu; printf \'%s\' "$RDF_WRITE_DATA" | base64 -d >> "$RDF_WRITE_FILE"',
          [...env, 'RDF_WRITE_DATA=' + file.data.subarray(offset, offset + CHUNK_BYTES).toString('base64')]);
      }
      await run('set -eu; chmod "$RDF_WRITE_MODE" "$RDF_WRITE_FILE"; mv -f -- "$RDF_WRITE_FILE" "$RDF_WRITE_TARGET"',
        [...env, 'RDF_WRITE_MODE=' + file.mode.toString(8), 'RDF_WRITE_TARGET=' + directory + '/' + file.name]);
      published = true;
    } finally {
      if (!published) await run('rm -f -- "$RDF_WRITE_FILE"', env, true).catch(() => {});
    }
  }
}
