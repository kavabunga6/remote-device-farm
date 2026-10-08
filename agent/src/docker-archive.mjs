/** Extract exactly one regular file from a Docker archive without buffering its contents. */
export async function* archiveFile(source, expectedName, maxBytes = 32 * 1024 ** 3) {
  let pending = Buffer.alloc(0), remaining = 0, padding = 0, found = false, active = false, metadata = false, ended = false;
  for await (const chunk of source) {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    while (pending.length) {
      if (remaining) {
        const size = Math.min(remaining, pending.length);
        if (active) yield pending.subarray(0, size);
        pending = pending.subarray(size); remaining -= size;
        if (remaining) break;
      }
      if (padding) { const size = Math.min(padding, pending.length); pending = pending.subarray(size); padding -= size; if (padding) break; }
      if (pending.length < 512) break;
      const header = pending.subarray(0, 512); pending = pending.subarray(512);
      if (header.every(byte => byte === 0)) { ended = true; continue; }
      if (ended) throw new Error('build_archive_trailing_data');
      const field = (start, length) => header.subarray(start, start + length).toString('ascii').replace(/\0.*$/, '').trim();
      const sizeField = field(124, 12), checksum = field(148, 8);
      const sum = [...header].reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
      if (!/^[0-7]+$/.test(sizeField) || !/^[0-7]+$/.test(checksum) || parseInt(checksum, 8) !== sum) throw new Error('build_archive_invalid_header');
      const size = parseInt(sizeField, 8), type = field(156, 1);
      metadata = type === 'x' || type === 'g';
      active = !metadata && (type === '' || type === '0') && field(0, 100) === expectedName && !field(345, 155);
      if ((!metadata && (!active || found)) || (metadata && size > 65536) || size > maxBytes || !Number.isSafeInteger(size)) throw new Error('build_archive_invalid_file');
      if (active) found = true;
      remaining = size; padding = (512 - size % 512) % 512;
    }
  }
  if (!found || remaining || padding || pending.some(byte => byte !== 0) || !ended) throw new Error('build_archive_incomplete');
}
