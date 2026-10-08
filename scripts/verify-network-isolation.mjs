// Calibrate page-scoped CDP network emulation against local WS and RTC echo.
// Run: node scripts/verify-network-isolation.mjs
// Uses a disposable Chromium process and loopback HTTP/WS listeners only.
// Does not contact the farm or change OS networking, firewall, routes, or services.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '../frontend/node_modules/playwright-core/index.mjs';

const require = createRequire(new URL('../agent/package.json', import.meta.url));
const { WebSocketServer } = require('ws');
const { RTCPeerConnection } = require('werift');
const outputPath = fileURLToPath(new URL('../.tmp-ui/network-cdp-calibration.json', import.meta.url));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const peers = [];
const result = {
  createdAt: new Date().toISOString(),
  scope: 'Local echo only; disposable browser; no farm or OS network changes.',
  stages: [],
  limitations: [
    'Browser bandwidth emulation is not an IP-level WAN or TCP retransmission model.',
    'CDP latency and packet loss affect RTC and WebSocket differently; excluded from performance comparisons.',
    'Echo timings exclude Android, video encoding, decoding, and display latency.',
  ],
};
let browser;
let cdp;
let failure;

async function bounded(promise, milliseconds, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} exceeded ${milliseconds} ms`)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const server = createServer((_request, response) => {
  response.setHeader('content-type', 'text/html');
  response.end('<!doctype html><title>Isolated network calibration</title>');
});
const wsServer = new WebSocketServer({ server });
wsServer.on('connection', socket => {
  socket.on('message', data => {
    if (socket.readyState === 1) socket.send(data.toString());
  });
  socket.on('error', () => {});
});

async function conditions(values = {}) {
  // Set a baseline rule BEFORE creating RTC sockets. Adding CDP only after the
  // connection exists can silently leave those sockets outside the interceptor.
  // In the verified Chromium, offline must also be supplied at the top level.
  await bounded(cdp.send('Network.emulateNetworkConditionsByRule', {
    offline: Boolean(values.offline),
    matchedNetworkConditions: [{
      urlPattern: '',
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1,
      packetLoss: 0,
      packetQueueLength: 0,
      packetReordering: false,
      ...values,
    }],
  }), 5000, 'Apply page network conditions');
  await wait(200);
}

async function setupEcho(page) {
  await page.goto(`http://127.0.0.1:${server.address().port}`, { timeout: 10000 });
  const offer = await bounded(page.evaluate(async () => {
    const pc = window.pc = new RTCPeerConnection({ iceServers: [] });
    const dc = window.dc = pc.createDataChannel('echo', { ordered: true });
    const ws = window.ws = new WebSocket(location.origin.replace('http', 'ws'));
    const responses = new Map();
    let serial = 0;

    const receive = event => {
      const message = JSON.parse(event.data);
      const callback = responses.get(message.id);
      if (callback) {
        responses.delete(message.id);
        callback();
      }
    };
    ws.addEventListener('message', receive);
    dc.addEventListener('message', receive);

    window.probe = async (kind, { count = 5, payload = 0, timeout = 1600 } = {}) => {
      const socket = kind === 'ws' ? ws : dc;
      const times = [];
      let timedOut = 0;
      const started = performance.now();
      for (let index = 0; index < count; index++) {
        const id = `${kind}-${++serial}`;
        const start = performance.now();
        await new Promise(resolve => {
          const timer = setTimeout(() => {
            responses.delete(id);
            timedOut++;
            resolve();
          }, timeout);
          responses.set(id, () => {
            clearTimeout(timer);
            times.push(performance.now() - start);
            resolve();
          });
          if (socket.readyState === 'open' || socket.readyState === 1) {
            socket.send(JSON.stringify({ id, padding: 'x'.repeat(payload) }));
          } else {
            clearTimeout(timer);
            responses.delete(id);
            timedOut++;
            resolve();
          }
        });
      }
      times.sort((a, b) => a - b);
      return {
        count,
        received: times.length,
        timedOut,
        p50: times[Math.floor(times.length / 2)] ?? null,
        max: times.at(-1) ?? null,
        elapsedMs: performance.now() - started,
        payloadPerMessage: payload,
      };
    };

    await pc.setLocalDescription(await pc.createOffer());
    if (pc.iceGatheringState !== 'complete') {
      await new Promise(resolve => pc.addEventListener('icegatheringstatechange', () => {
        if (pc.iceGatheringState === 'complete') resolve();
      }));
    }
    return pc.localDescription.toJSON();
  }), 15000, 'Browser RTC offer');

  const peer = new RTCPeerConnection({
    iceServers: [],
    iceAdditionalHostAddresses: ['127.0.0.1'],
    iceUseIpv6: false,
    iceUseTcp: false,
    maxMessageSize: 65536,
  });
  peers.push(peer);
  peer.onDataChannel.subscribe(channel => {
    channel.onMessage.subscribe(data => channel.send(data));
  });
  await bounded(peer.setRemoteDescription(offer), 15000, 'Echo RTC remote description');
  await bounded((async () => peer.setLocalDescription(await peer.createAnswer()))(),
    15000, 'Echo RTC answer');
  await bounded(page.evaluate(answer => window.pc.setRemoteDescription(answer), peer.localDescription),
    15000, 'Browser RTC answer');
  await page.waitForFunction(() => window.dc.readyState === 'open' && window.ws.readyState === 1,
    null, { timeout: 15000 });
}

function assertAllReceived(probe, label) {
  assert.equal(probe.received, probe.count, `${label}: missing echo response`);
  assert.equal(probe.timedOut, 0, `${label}: echo timed out`);
}

function validate() {
  const byName = Object.fromEntries(result.stages.map(stage => [stage.name, stage]));
  const baseline = byName.baseline;
  for (const kind of ['ws', 'rtc']) {
    assertAllReceived(baseline.test[kind], `baseline ${kind}`);
    const controlLimit = Math.max(100, baseline.control[kind].max * 20);
    for (const stage of result.stages) {
      assertAllReceived(stage.control[kind], `${stage.name}: control ${kind}`);
      assert.ok(stage.control[kind].max < controlLimit,
        `${stage.name}: control ${kind} was slow; isolation is not established`);
    }

    const capped = byName['1 Mbps each direction'].test[kind];
    assertAllReceived(capped, `bandwidth ${kind}`);
    assert.ok(capped.elapsedMs > 1000,
      `${kind}: 8 x 16 KiB echo was not meaningfully throttled`);
    assert.ok(capped.p50 > baseline.test[kind].p50 * 3,
      `${kind}: bandwidth slowdown was not distinguishable from baseline`);

    const offline = byName.offline.test[kind];
    assert.equal(offline.received, 0, `${kind}: offline did not stop echo`);
    assert.equal(offline.timedOut, offline.count, `${kind}: offline probes did not all expire`);
    assertAllReceived(byName['restored after offline'].test[kind], `restored ${kind}`);
    assertAllReceived(byName['restored after packet loss'].test[kind], `restored after loss ${kind}`);
  }

  // Report asymmetry as a calibration limitation, never as a transport winner.
  const delayed = byName['latency 200 ms'].test;
  const lossy = byName['100 percent packet loss'].test;
  result.asymmetry = {
    excludedFromPerformanceComparison: true,
    latency200Ms: { websocketRttP50Ms: delayed.ws.p50, webrtcRttP50Ms: delayed.rtc.p50 },
    packetLoss100Percent: { websocketReceived: lossy.ws.received, webrtcReceived: lossy.rtc.received },
  };
}

try {
  await bounded(new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  }), 5000, 'Loopback listener');
  browser = await chromium.launch({ headless: true, timeout: 15000 });
  result.browser = browser.version();
  const context = await browser.newContext();
  const controlContext = await browser.newContext();
  const test = await context.newPage();
  const control = await controlContext.newPage();
  cdp = await context.newCDPSession(test);
  await bounded(cdp.send('Network.enable'), 5000, 'Enable page CDP');
  await conditions();
  await setupEcho(test);
  await setupEcho(control);

  async function stage(name, options = {}) {
    const values = await bounded(Promise.all([
      test.evaluate(value => window.probe('ws', value), options),
      test.evaluate(value => window.probe('rtc', value), options),
      control.evaluate(() => window.probe('ws', { count: 3 })),
      control.evaluate(() => window.probe('rtc', { count: 3 })),
    ]), (options.count ?? 5) * (options.timeout ?? 1600) + 5000, `Stage ${name}`);
    const entry = { name, test: { ws: values[0], rtc: values[1] }, control: { ws: values[2], rtc: values[3] } };
    result.stages.push(entry);
    console.log(`${name}: test WS ${entry.test.ws.received}/${entry.test.ws.count}, `
      + `RTC ${entry.test.rtc.received}/${entry.test.rtc.count}; `
      + `control WS ${entry.control.ws.received}/3, RTC ${entry.control.rtc.received}/3`);
  }

  await stage('baseline');
  await conditions({ latency: 200 });
  await stage('latency 200 ms');
  await conditions({ downloadThroughput: 125000, uploadThroughput: 125000 });
  await stage('1 Mbps each direction', { count: 8, payload: 16384, timeout: 5000 });
  await conditions({ packetLoss: 100 });
  await stage('100 percent packet loss', { count: 2, timeout: 1000 });
  await conditions();
  await stage('restored after packet loss', { count: 3, timeout: 5000 });
  await conditions({ offline: true });
  await stage('offline', { count: 2, timeout: 1000 });
  await conditions();
  await stage('restored after offline', { count: 3, timeout: 5000 });
  validate();
  result.ok = true;
} catch (error) {
  failure = error;
  result.ok = false;
  result.error = error.message;
} finally {
  const cleanupErrors = [];
  async function cleanup(label, action) {
    try {
      await bounded(action(), 10000, label);
    } catch (error) {
      cleanupErrors.push(`${label}: ${error.message}`);
    }
  }
  if (cdp) await cleanup('Clear page conditions', () => cdp.send('Network.emulateNetworkConditionsByRule', {
    offline: false, matchedNetworkConditions: [],
  }));
  if (browser) await cleanup('Close disposable browser', () => browser.close());
  await Promise.all(peers.map((peer, index) => cleanup(`Close RTC echo ${index}`, () => peer.close())));
  for (const socket of wsServer.clients) socket.terminate();
  await cleanup('Close WS echo', () => new Promise(resolve => wsServer.close(resolve)));
  if (server.listening) {
    server.closeAllConnections();
    await cleanup('Close HTTP echo', () => new Promise(resolve => server.close(resolve)));
  }
  result.cleanupErrors = cleanupErrors;
  if (cleanupErrors.length) result.ok = false;
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, JSON.stringify(result, null, 2) + '\n');
}

console.log(JSON.stringify({
  ok: result.ok,
  browser: result.browser,
  isolatedControlVerified: result.ok === true,
  note: 'Bandwidth/offline calibration only; latency/loss are asymmetric and not an A/B comparison.',
  outputPath,
}, null, 2));
if (!result.ok) {
  console.error(failure?.message ?? result.cleanupErrors.join('\n'));
  process.exitCode = 1;
}
