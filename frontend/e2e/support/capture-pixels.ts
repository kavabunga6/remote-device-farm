import { execFile, spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { promisify } from 'node:util';

const execute = promisify(execFile);
type PixelSample = { time: number; count: number; green: number; x: number | null; y: number | null };
type Probe = { streams: { width: number; height: number; codec_name: string }[];
  frames: { best_effort_timestamp_time?: string }[]; format: { format_name: string } };

function inspectFrame(pixels: Buffer, width: number, height: number, contentWidth: number, contentHeight: number, time: number): PixelSample {
  let count = 0, green = 0, sumX = 0, sumY = 0;
  for (let i = 0; i < pixels.length; i += 3) {
    const r = pixels[i], g = pixels[i + 1], b = pixels[i + 2];
    const isGreen = g - r > 30 && g - b > 10 && g > 80;
    if (isGreen) green++;
    if (isGreen || r > 160 && g > 160 && b > 160) {
      count++; sumX += (i / 3) % width; sumY += Math.floor(i / 3 / width);
    }
  }
  return { time, count, green,
    x: count ? (sumX / count - (width - contentWidth) / 2) / contentWidth : null,
    y: count ? (sumY / count - (height - contentHeight) / 2) / contentHeight : null };
}

// Read every encoded frame; browser presentation callbacks may skip frames or
// miss their playback deadline when recording tests deliberately throttle CPU.
export async function inspectCapture(file: string, type: 'image/png' | 'video/webm', times: number[] | 'timeline', landscape: boolean) {
  const { stdout } = await execute('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height,codec_name:format=format_name:frame=best_effort_timestamp_time',
    '-show_frames', '-of', 'json', file], { timeout: 30_000, maxBuffer: 1024 * 1024 });
  const metadata = JSON.parse(stdout) as Probe;
  const stream = metadata.streams[0];
  if (!stream || !metadata.frames?.length || !Number.isSafeInteger(stream.width) || !Number.isSafeInteger(stream.height) ||
    stream.width <= 0 || stream.height <= 0 || stream.width * stream.height > 16 * 1024 * 1024) throw new Error('Invalid capture dimensions or missing frames');
  if (type === 'image/png' ? stream.codec_name !== 'png' : !metadata.format.format_name.includes('webm')) throw new Error('Unexpected capture format');
  const { width, height } = stream;
  const contentWidth = type === 'video/webm' ? landscape ? 1280 : 720 : width;
  const contentHeight = type === 'video/webm' ? landscape ? 720 : 1280 : height;
  const timeline: PixelSample[] = [];
  await new Promise<void>((resolve, reject) => {
    const child = spawn('ffmpeg', ['-nostdin', '-v', 'error', '-i', file, '-map', '0:v:0',
      '-fps_mode', 'passthrough', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'],
    { stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000, killSignal: 'SIGKILL' });
    // Reuse one frame buffer instead of retaining the uncompressed recording.
    const frame = Buffer.alloc(width * height * 3);
    let used = 0, stderr = '', failure: unknown;
    child.stderr.on('data', data => { if (stderr.length < 16_384) stderr += String(data).slice(0, 16_384 - stderr.length); });
    child.on('error', reject);
    child.stdout.on('data', (data: Buffer) => {
      try {
        let offset = 0;
        while (offset < data.length) {
          const count = Math.min(frame.length - used, data.length - offset);
          data.copy(frame, used, offset, offset + count); used += count; offset += count;
          if (used === frame.length) {
            const time = Number(metadata.frames[timeline.length]?.best_effort_timestamp_time);
            if (!Number.isFinite(time)) throw new Error('Decoded frame has no timestamp');
            timeline.push(inspectFrame(frame, width, height, contentWidth, contentHeight, time)); used = 0;
          }
        }
      } catch (error) { failure = error; child.kill('SIGKILL'); }
    });
    child.on('close', (code, signal) => {
      if (failure) reject(failure);
      else if (code !== 0 || used || timeline.length !== metadata.frames.length) reject(new Error('Capture decode failed: ' + (stderr || signal || code)));
      else resolve();
    });
  });
  const samples = times === 'timeline' ? timeline : times.map(time => {
    const sample = [...timeline].reverse().find(frame => frame.time <= time);
    if (!sample) throw new Error('No decoded frame at requested time');
    return sample;
  });
  return { mime: type, bytes: (await stat(file)).size, width, height, samples };
}
