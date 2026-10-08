/** Minimal POSIX ustar archive for the Docker build context (a few small regular files). */
export function tarArchive(files) {
  const blocks = [];
  for (const { name, mode, data } of files) {
    if (!/^[A-Za-z0-9._-]{1,99}$/.test(name)) throw new Error('Invalid build context file name');
    const header = Buffer.alloc(512);
    const field = (value, offset, length) => header.write(value, offset, length, 'ascii');
    const octal = (value, length) => value.toString(8).padStart(length - 1, '0') + '\0';
    field(name, 0, 100);
    field(octal(mode, 8), 100, 8);
    field(octal(0, 8), 108, 8);
    field(octal(0, 8), 116, 8);
    field(octal(data.length, 12), 124, 12);
    field(octal(0, 12), 136, 12);
    field('        ', 148, 8);
    field('0', 156, 1);
    field('ustar\0', 257, 6);
    field('00', 263, 2);
    let sum = 0;
    for (const byte of header) sum += byte;
    field(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
    blocks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}
