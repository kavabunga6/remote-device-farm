import { inflateSync } from 'node:zlib';
import { execInContainer, runEmuConsole } from './emu-console.mjs';
import { agentMessage } from './messages.mjs';
const MAX_IMAGE = 256 * 1024;
const signature = Buffer.from('89504e470d0a1a0a', 'hex');
const invalid = () => { throw new Error(agentMessage('agent.camera.invalid')); };
function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  }
  return (value ^ 0xffffffff) >>> 0;
}
// Only RGB/RGBA 8-bit non-interlaced PNGs. Bound decompression and strip metadata.
export function cameraPng(base64) {
  if (typeof base64 !== 'string' || base64.length > Math.ceil(MAX_IMAGE / 3) * 4 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) invalid();
  const bytes = Buffer.from(base64, 'base64');
  if (bytes.length > MAX_IMAGE || bytes.toString('base64') !== base64 || !bytes.subarray(0, 8).equals(signature)) invalid();
  const retained = [], data = [];
  let width = 0, height = 0, channels = 0, ended = false;
  for (let offset = 8; offset < bytes.length;) {
    if (offset + 12 > bytes.length || ended) invalid();
    const size = bytes.readUInt32BE(offset), type = bytes.toString('ascii', offset + 4, offset + 8);
    if (size > bytes.length - offset - 12) invalid();
    const chunk = bytes.subarray(offset, offset + size + 12), payload = chunk.subarray(8, -4);
    if (crc32(chunk.subarray(4, -4)) !== chunk.readUInt32BE(chunk.length - 4)) invalid();
    if (!width && type !== 'IHDR') invalid();
    if (type === 'IHDR') {
      if (width || size !== 13) invalid();
      width = payload.readUInt32BE(0); height = payload.readUInt32BE(4);
      channels = payload[9] === 6 ? 4 : payload[9] === 2 ? 3 : 0;
      if (!width || !height || width > 1024 || height > 1024 || !channels ||
          payload[8] !== 8 || payload[10] || payload[11] || payload[12]) invalid();
      retained.push(chunk);
    } else if (type === 'IDAT') { data.push(payload); retained.push(chunk); }
    else if (type === 'IEND') { if (size || !data.length) invalid(); ended = true; retained.push(chunk); }
    else if (!/^[a-z]/.test(type)) invalid();
    offset += size + 12;
  }
  if (!ended) invalid();
  const row = width * channels + 1, expected = row * height;
  let pixels;
  try { pixels = inflateSync(Buffer.concat(data), { maxOutputLength: expected }); } catch { invalid(); }
  if (pixels.length !== expected) invalid();
  for (let i = 0; i < pixels.length; i += row) if (pixels[i] > 4) invalid();
  return Buffer.concat([signature, ...retained]);
}
export function imageArchive(bytes) {
  const header = Buffer.alloc(512);
  const field = (value, start, length) => header.write(value, start, length, 'ascii');
  field('rdf-camera.png', 0, 100); field('0000644\0', 100, 8);
  field('0000000\0', 108, 8); field('0000000\0', 116, 8);
  field(bytes.length.toString(8).padStart(11, '0') + '\0', 124, 12);
  field('00000000000\0', 136, 12); header.fill(32, 148, 156); header[156] = 48;
  field('ustar\0', 257, 6); field('00', 263, 2);
  field([...header].reduce((a, b) => a + b, 0).toString(8).padStart(6, '0') + '\0 ', 148, 8);
  return Buffer.concat([header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512 + 1024)]);
}
const CHECK = 'test -r /android-home/avd/rdf.avd/config.ini && grep -q "^hw.camera.back=virtualscene$" /android-home/avd/rdf.avd/config.ini || exit 69; if test -f /android-home/rdf-camera-applied; then printf set; elif test -f /android-home/rdf-camera.png; then printf pending; fi';
export async function applyCameraImage(docker, containerId, sessionId, agentId, params) {
  if (!params || !['status', 'set', 'reset', 'show'].includes(params.op) ||
      Object.keys(params).some(k => !['op', 'imageBase64'].includes(k)) ||
      (params.op !== 'set' && params.imageBase64 !== undefined)) invalid();
  const image = params.op === 'set' ? cameraPng(params.imageBase64) : null;
  const detail = await docker.inspect(containerId), labels = detail.Config?.Labels || {};
  if (labels['remote-device-farm.managed'] !== 'true' || labels['remote-device-farm.agent'] !== agentId ||
      labels['remote-device-farm.session'] !== sessionId || detail.State?.Running !== true) invalid();
  const checked = await execInContainer(docker, containerId, ['sh', '-c', CHECK], [], 10_000);
  if (checked.exitCode !== 0) {
    if (params.op === 'status') return { available: false, imageSet: false };
    throw new Error(agentMessage('agent.camera.unavailable'));
  }
  if (params.op === 'status') return { available: true, imageSet: checked.stdout === 'set' ? true : checked.stdout === 'pending' ? null : false };
  if (image) {
    const cleared = await execInContainer(docker, containerId, ['rm', '-f', '/android-home/rdf-camera-applied'], [], 5000);
    if (cleared.exitCode !== 0) throw new Error(agentMessage('agent.camera.failed'));
    await docker.request('PUT', '/containers/' + encodeURIComponent(containerId) + '/archive?path=%2Fandroid-home&noOverwriteDirNonDir=true',
      undefined, { rawBody: imageArchive(image), contentType: 'application/x-tar', timeoutMs: 15_000 });
  }
  const args = params.op === 'show' ? ['automation', 'play', '/opt/android/emulator/resources/macros/Walk_to_image_room'] :
    ['virtualscene-image', 'wall', ...(params.op === 'set' ? ['/android-home/rdf-camera.png'] : [])];
  const result = await runEmuConsole(docker, containerId, args);
  if (result.exitCode !== 0) throw new Error(agentMessage('agent.camera.failed'));
  if (params.op === 'set') {
    const confirmed = await execInContainer(docker, containerId, ['touch', '/android-home/rdf-camera-applied'], [], 5000);
    if (confirmed.exitCode !== 0) throw new Error(agentMessage('agent.camera.failed'));
  }
  if (params.op === 'reset') {
    const removed = await execInContainer(docker, containerId, ['rm', '-f', '/android-home/rdf-camera.png', '/android-home/rdf-camera-applied'], [], 5000);
    if (removed.exitCode !== 0) throw new Error(agentMessage('agent.camera.failed'));
  }
  return { available: true, imageSet: params.op === 'reset' ? false : params.op === 'set' || checked.stdout === 'set' };
}
