import { diagnostic } from './diagnostics.mjs';
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Atomic, private build ledger. Registry credentials deliberately never reach disk. */
export class ImageJobStore {
  constructor(directory) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.directory = directory;
    this.path = join(directory, 'jobs.json');
  }

  read() {
    let text;
    try { text = readFileSync(this.path, 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    const data = JSON.parse(text);
    if (data?.version !== 1 || !Array.isArray(data.jobs) || data.jobs.some(job =>
      !job || typeof job.id !== 'string' || typeof job.package !== 'string' || typeof job.image !== 'string' ||
      !['queued', 'building', 'validating', 'pushing', 'cancelling', 'cancelled', 'done', 'failed'].includes(job.state) || !Array.isArray(job.log) || !Array.isArray(job.profiles))) {
      throw new Error(diagnostic('emulator-image-job-store.d729871e50'));
    }
    return data.jobs;
  }

  write(jobs) {
    const temporary = this.path + '.tmp';
    // Persist only the public build record and its acknowledgement, never push tokens or SDK entries.
    const records = jobs.map(({ auth, entry, ...job }) => job);
    let fd;
    try {
      fd = openSync(temporary, 'w', 0o600);
      writeFileSync(fd, JSON.stringify({ version: 1, jobs: records }));
      fsyncSync(fd);
      closeSync(fd); fd = undefined;
      renameSync(temporary, this.path);
      if (process.platform !== 'win32') {
        const directory = openSync(this.directory, 'r');
        try { fsyncSync(directory); } finally { closeSync(directory); }
      }
    } finally {
      if (fd !== undefined) closeSync(fd);
      try { unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
}
