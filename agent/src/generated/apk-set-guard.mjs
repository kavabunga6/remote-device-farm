import { createReadStream } from 'node:fs';
import { createInflateRaw } from 'node:zlib';
import { open } from 'node:fs/promises';
const crcTable = Uint32Array.from({ length: 256 }, (_, value) => { for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ value >>> 1 : value >>> 1; return value >>> 0; });
const invalid = () => { throw new Error('apk_set_invalid'); };

// Validate before a ZIP reader or bundletool can expand an untrusted archive.
export async function inspectApkSet(file, bundle = true) {
  const fd = await open(file, 'r');
  try {
    const { size } = await fd.stat(), tailSize = Math.min(size, 65557), tail = Buffer.alloc(tailSize);
    await fd.read(tail, 0, tailSize, size - tailSize);
    let end = -1;
    for (let i = tail.length - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50 && i + 22 + tail.readUInt16LE(i + 20) === tail.length) { end = i; break; }
    if (end < 0 || tail.readUInt32LE(end + 4) !== 0) invalid();
    const count = tail.readUInt16LE(end + 10), length = tail.readUInt32LE(end + 12), offset = tail.readUInt32LE(end + 16);
    if (!count || count > 2048 || tail.readUInt16LE(end + 8) !== count || length > 2 * 1024 * 1024 || offset + length !== size - tailSize + end) invalid();
    const directory = Buffer.alloc(length); await fd.read(directory, 0, length, offset);
    let pos = 0, expanded = 0;
    const names = new Set(), apks = [], streams = [];
    for (let n = 0; n < count; n++) {
      if (pos + 46 > length || directory.readUInt32LE(pos) !== 0x02014b50) invalid();
      const nameSize = directory.readUInt16LE(pos + 28), extra = directory.readUInt16LE(pos + 30), comment = directory.readUInt16LE(pos + 32);
      const bytes = directory.readUInt32LE(pos + 24), compressed = directory.readUInt32LE(pos + 20), local = directory.readUInt32LE(pos + 42);
      const name = directory.toString('utf8', pos + 46, pos + 46 + nameSize);
      if (pos + 46 + nameSize + extra + comment > length || !/^[A-Za-z0-9_./-]{1,220}$/.test(name) || name.startsWith('/') ||
          name.split('/').some(part => part === '..' || part === '.') || names.has(name) ||
          directory.readUInt16LE(pos + 8) & 1 || ![0, 8].includes(directory.readUInt16LE(pos + 10)) ||
          (directory.readUInt32LE(pos + 38) >>> 16 & 0xf000) === 0xa000 || local + 30 + compressed > offset ||
          bytes > 256 * 1024 * 1024 || (expanded += bytes) > 1024 * 1024 * 1024) invalid();
      const header = Buffer.alloc(30); await fd.read(header, 0, 30, local);
      if (header.readUInt32LE(0) !== 0x04034b50 || local + 30 + header.readUInt16LE(26) + header.readUInt16LE(28) + compressed > offset) invalid();
      const localName = Buffer.alloc(header.readUInt16LE(26)); await fd.read(localName, 0, localName.length, local + 30);
      if (localName.toString('utf8') !== name || header.readUInt16LE(8) !== directory.readUInt16LE(pos + 10) || header.readUInt16LE(6) !== directory.readUInt16LE(pos + 8)) invalid();
      const start = local + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
      streams.push({ start, compressed, bytes, method: header.readUInt16LE(8), crc: directory.readUInt32LE(pos + 16) });
      names.add(name);
      if (name.endsWith('.apk')) apks.push(name);
      pos += 46 + nameSize + extra + comment;
    }
    if (pos !== length || !apks.length || apks.length > 1000 || (bundle && !names.has('toc.pb')) ||
        (!bundle && (apks.length > 100 || names.size !== apks.length || apks.some(name => name.includes('/'))))) invalid();
    // A declared ZIP size is not a decompression limit. Verify every stream's actual size and CRC.
    for (const entry of streams) {
      let bytes = 0, crc = 0xffffffff;
      if (entry.compressed) {
        const input = createReadStream(file, { start: entry.start, end: entry.start + entry.compressed - 1 });
        const decoded = entry.method === 8 ? input.pipe(createInflateRaw()) : input;
        if (decoded !== input) input.once('error', error => decoded.destroy(error));
        try {
          for await (const chunk of decoded) {
            if ((bytes += chunk.length) > entry.bytes) invalid();
            for (const byte of chunk) crc = crcTable[(crc ^ byte) & 255] ^ crc >>> 8;
          }
        } finally { decoded.destroy(); input.destroy(); }
      }
      if (bytes !== entry.bytes || ((crc ^ 0xffffffff) >>> 0) !== entry.crc) invalid();
    }
    return apks;
  } finally { await fd.close(); }
}
