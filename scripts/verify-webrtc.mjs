// Real Chromium <-> agent DTLS/SRTP/SCTP check, with browser-encoded H.264.
// Run from the repository: node scripts/verify-webrtc.mjs
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { chromium } from '../frontend/node_modules/playwright-core/index.mjs';
import { WebRtcManager } from '../agent/src/webrtc.mjs';
import { annexBNals } from '../agent/src/rtc-media.mjs';
import { InputGate } from '../agent/src/input-gate.mjs';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const sessionId = randomUUID(), peerId = randomUUID();
let applied = 0, released = 0;
const gate = new InputGate({ releaseInput: async () => { released++; } });
const streams = { streams: new Map(), requestKeyframe: async () => {} };
const rtc = new WebRtcManager({ streams,
  config: { enabled: true, iceServers: [], icePortRange: [51000, 51100], addresses: ['127.0.0.1'] },
  openInput: (s, p) => gate.open(s, p), releaseInput: (s, p) => gate.release(s, p),
  input: (s, p, meta, params) => gate.dispatch(s, meta, params, async () => { applied++; return { ok: true }; }),
});
const server = createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><title>RTC verification</title>'); });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
let renewal;
try {
  browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined, headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const capabilities = await page.evaluate(async () => ({
    h264Decode: (await VideoDecoder.isConfigSupported({ codec: 'avc1.42E01E', codedWidth: 320, codedHeight: 240 })).supported,
    h264Encode: (await VideoEncoder.isConfigSupported({ codec: 'avc1.42E01E', width: 320, height: 240, bitrate: 300000, framerate: 30 })).supported,
    h264Rtp: RTCRtpReceiver.getCapabilities('video')?.codecs.some(codec => codec.mimeType.toLowerCase() === 'video/h264'),
    recording: MediaRecorder.isTypeSupported('video/webm;codecs=vp8'),
  }));
  assert.deepEqual(capabilities, { h264Decode: true, h264Encode: true, h264Rtp: true, recording: true },
    'Required media codecs are missing. Install full Chrome and use PLAYWRIGHT_CHANNEL=chrome.');
  const encoded = await page.evaluate(async () => {
    const chunks = [];
    const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 240;
    const ctx = canvas.getContext('2d');
    const encoder = new VideoEncoder({ output: chunk => { const data = new Uint8Array(chunk.byteLength); chunk.copyTo(data); chunks.push({ data: [...data], timestamp: chunk.timestamp, keyframe: chunk.type === 'key' }); }, error: error => { throw error; } });
    encoder.configure({ codec: 'avc1.42E01E', width: 320, height: 240, bitrate: 300000, framerate: 30, latencyMode: 'realtime', avc: { format: 'annexb' } });
    for (let i = 0; i < 45; i++) {
      ctx.fillStyle = `rgb(${(i * 7) % 255},40,100)`; ctx.fillRect(0, 0, 320, 240);
      ctx.fillStyle = 'white'; ctx.fillRect(i * 5, 60, 25, 25);
      const frame = new VideoFrame(canvas, { timestamp: i * 33333 }); encoder.encode(frame, { keyFrame: i % 15 === 0 }); frame.close();
    }
    await encoder.flush(); encoder.close(); return chunks;
  });
  const first = Buffer.from(encoded[0].data);
  const config = Buffer.concat(annexBNals(first).filter(n => [7, 8].includes(n[0] & 31)).map(n => Buffer.concat([Buffer.from([0, 0, 0, 1]), n])));
  rtc.publish({ type: 'video-config', sessionId, codec: 'h264', width: 320, height: 240, data: config.toString('base64') });
  const offer = await page.evaluate(async () => {
    window.received = []; window.inputSeq = 0;
    window.pc = new RTCPeerConnection({ iceServers: [] });
    const video = document.createElement('video'); video.autoplay = true; video.muted = true; video.playsInline = true; document.body.append(video); window.video = video;
    pc.ontrack = event => { if (event.track.kind === 'video') { video.srcObject = new MediaStream([event.track]); void video.play(); } };
    pc.addTransceiver('video', { direction: 'recvonly' }); pc.addTransceiver('audio', { direction: 'recvonly' });
    window.dc = pc.createDataChannel('control', { ordered: true });
    dc.onmessage = event => { const message = JSON.parse(event.data); window.received.push(message); if (message.type === 'ready') { window.ready = message; window.readyAt = performance.now(); } };
    await pc.setLocalDescription(await pc.createOffer());
    if (pc.iceGatheringState !== 'complete') await new Promise(resolve => pc.addEventListener('icegatheringstatechange', () => { if (pc.iceGatheringState === 'complete') resolve(); }));
    return pc.localDescription.toJSON();
  });
  renewal = setInterval(() => rtc.renew(sessionId, peerId), 1000);
  const answer = await rtc.offer(sessionId, 'test-device', { peerId, description: offer, canControl: true });
  await page.evaluate(answer => pc.setRemoteDescription(answer), answer.description);
  await page.waitForFunction(() => window.ready && dc.readyState === 'open', null, { timeout: 15000 });
  for (const chunk of encoded) {
    rtc.publish({ type: 'video-frame', sessionId, codec: 'h264', ...chunk, data: Buffer.from(chunk.data).toString('base64') });
    await wait(33);
  }
  await page.waitForFunction(() => video.videoWidth === 320 && video.getVideoPlaybackQuality().totalVideoFrames > 5, null, { timeout: 8000 });
  const sample = await page.evaluate(async () => {
    const rtts = [];
    for (let i = 0; i < 20; i++) {
      const id = String(i), start = performance.now();
      dc.send(JSON.stringify({ type: 'ping', id }));
      await new Promise(resolve => { const timer = setInterval(() => { if (received.some(m => m.type === 'pong' && m.id === id)) { clearInterval(timer); resolve(); } }, 1); });
      rtts.push(performance.now() - start);
    }
    dc.send(JSON.stringify({ type: 'input', kind: 'touch', action: 'down', pointerId: 0, x: 30, y: 40, epoch: ready.inputEpoch, seq: 1, deadline: ready.serverTime + (performance.now() - readyAt) + 1000 }));
    await new Promise(resolve => { const timer = setInterval(() => { if (received.some(m => m.type === 'input-ack' && m.seq === 1)) { clearInterval(timer); resolve(); } }, 1); });
    // Duplicate and expired actions must not reach Android.
    dc.send(JSON.stringify({ type: 'input', kind: 'key', keyCode: 3, epoch: ready.inputEpoch, seq: 1, deadline: ready.serverTime + 10000 }));
    dc.send(JSON.stringify({ type: 'input', kind: 'key', keyCode: 3, epoch: ready.inputEpoch, seq: 2, deadline: 1 }));
    rtts.sort((a,b) => a-b);
    const stats = [...(await pc.getStats()).values()];
    const media = stats.find(s => s.type === 'inbound-rtp' && s.kind === 'video');
    return { decodedFrames: media?.framesDecoded, packetsReceived: media?.packetsReceived, framesPresented: video.getVideoPlaybackQuality().totalVideoFrames,
      dataChannelRttMs: { p50: rtts[9], p95: rtts[18], p99: rtts[19] } };
  });
  await wait(100); assert.equal(applied, 1);
  await rtc.close(sessionId, peerId); assert.equal(released, 1); assert.equal(rtc.peers.size, 0);
  console.log(JSON.stringify({ ok: true, ...sample, appliedInputs: applied, disconnectReleases: released, note: 'Localhost transport measurement; excludes Android execution and screen latency.' }, null, 2));
} finally {
  clearInterval(renewal); await rtc.closeAll(); await browser?.close(); await new Promise(resolve => server.close(resolve));
}
