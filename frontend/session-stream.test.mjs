import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const bundle = await build({
  entryPoints: [fileURLToPath(new URL('./src/useSessionStream.ts', import.meta.url))],
  bundle: true, write: false, format: 'cjs', platform: 'browser', logLevel: 'silent',
  external: ['react', './api'],
});

// Run the hook's effects with isolated browser resources; no DOM or real codecs
// are required to deliver close events and queued decoder callbacks.
function mountStream({ videoConfigureError = false, renderError = false } = {}) {
  const effects = [];
  const layoutEffects = [];
  const updates = [];
  const timers = new Map();
  const videos = [];
  const audios = [];
  const sockets = [];
  let nextTimer = 0;
  class Socket {
    static OPEN = 1;
    static CLOSED = 3;
    readyState = Socket.OPEN;
    constructor() { sockets.push(this); }
    send() {}
    close() { this.readyState = 2; }
    finishClose() { this.readyState = Socket.CLOSED; this.onclose?.(); }
    message(message) { this.onmessage?.({ data: JSON.stringify(message) }); }
  }
  class Decoder {
    state = 'unconfigured';
    closeCalls = 0;
    constructor(callbacks) { this.callbacks = callbacks; }
    configure() { this.state = 'configured'; }
    close() { this.closeCalls += 1; this.state = 'closed'; }
  }
  class Video extends Decoder {
    constructor(callbacks) { super(callbacks); videos.push(this); }
    configure() {
      if (videoConfigureError) throw new Error('Unsupported codec');
      super.configure();
    }
  }
  class Audio extends Decoder {
    constructor(callbacks) { super(callbacks); audios.push(this); }
  }
  const react = {
    useRef: value => ({ current: value }),
    useState: value => [value, update => updates.push(update)],
    useEffect: effect => effects.push(effect),
    useLayoutEffect: effect => layoutEffects.push(effect),
  };
  const module = { exports: {} };
  vm.runInNewContext(bundle.outputFiles[0].text, {
    module, Error, atob, navigator: { onLine: true }, performance: { now: () => 0 },
    require: id => {
      if (id === 'react') return react;
      if (id === './api') return { sessionSocketUrl: id => 'ws://localhost/session/' + id };
      throw new Error('Unexpected import: ' + id);
    },
    WebSocket: Socket, VideoDecoder: Video, AudioDecoder: Audio,
    window: {
      VideoDecoder: Video, AudioDecoder: Audio, addEventListener() {}, removeEventListener() {},
      setInterval: () => -1, clearInterval() {},
      setTimeout: callback => { const id = nextTimer++; timers.set(id, callback); return id; },
      clearTimeout: id => timers.delete(id),
    },
  });
  const hook = module.exports.useSessionStream('session-one', true);
  hook.canvasRef.current = {
    width: 10, height: 10,
    getContext: () => ({ drawImage: () => { if (renderError) throw new Error('Canvas unavailable'); } }),
  };
  const cleanups = effects.map(effect => effect());
  return {
    hook, socket: sockets[0], videos, audios, timers, updates,
    flushLayout: () => layoutEffects.forEach(effect => effect()),
    unmount: () => cleanups.forEach(cleanup => cleanup?.()),
  };
}

const videoConfig = { type: 'video-config', data: 'AAAAAWdCAAk=' };
const audioConfig = { type: 'audio-config', codec: 'opus', data: 'AA==' };
function frame() {
  return { displayWidth: 10, displayHeight: 10, closeCalls: 0, close() { this.closeCalls += 1; } };
}

test('unsupported video configuration releases both decoders even when no retry will run', () => {
  const stream = mountStream({ videoConfigureError: true });
  stream.socket.message(audioConfig);
  stream.socket.message(videoConfig);
  stream.socket.finishClose();
  assert.equal(stream.videos[0].closeCalls, 1);
  assert.equal(stream.audios[0].closeCalls, 1);
  assert.equal(stream.timers.size, 0);
  stream.unmount();
  assert.equal(stream.videos[0].closeCalls, 1);
  assert.equal(stream.audios[0].closeCalls, 1);
});

test('disconnect releases decoders and rejects queued output before the retry fires', () => {
  const stream = mountStream();
  stream.socket.message(videoConfig);
  stream.socket.message(audioConfig);
  stream.socket.finishClose();
  assert.equal(stream.videos[0].closeCalls, 1);
  assert.equal(stream.audios[0].closeCalls, 1);
  const pending = frame();
  const updatesBefore = stream.updates.length;
  stream.videos[0].callbacks.output(pending);
  assert.equal(pending.closeCalls, 1);
  assert.equal(stream.updates.length, updatesBefore);
  assert.equal(stream.timers.size, 1);
  stream.unmount();
  assert.equal(stream.timers.size, 0);
});

test('a rendering failure closes the frame and decoder and disconnects for recovery', () => {
  const stream = mountStream({ renderError: true });
  stream.socket.message(videoConfig);
  const pending = frame();
  assert.doesNotThrow(() => stream.videos[0].callbacks.output(pending));
  assert.equal(pending.closeCalls, 1);
  assert.equal(stream.videos[0].closeCalls, 1);
  assert.equal(stream.socket.readyState, 2);
  stream.unmount();
});

test('unmount detaches socket callbacks and closes queued frames without updating state', () => {
  const stream = mountStream();
  stream.socket.message(videoConfig);
  stream.socket.message(audioConfig);
  stream.unmount();
  const updatesBefore = stream.updates.length;
  const pending = frame();
  stream.videos[0].callbacks.output(pending);
  stream.socket.onopen?.();
  stream.socket.onerror?.();
  stream.socket.finishClose();
  assert.equal(pending.closeCalls, 1);
  assert.equal(stream.updates.length, updatesBefore);
  assert.equal(stream.timers.size, 0);
  assert.equal(stream.videos[0].closeCalls, 1);
  assert.equal(stream.audios[0].closeCalls, 1);
});


test('the newest early image frame renders once when the screen mounts', () => {
  const stream = mountStream();
  stream.socket.message({ type: 'frame', data: 'FIRST', mime: 'image/png' });
  stream.socket.message({ type: 'frame', data: 'LATEST', mime: 'image/png' });
  const screen = {};
  stream.hook.imageRef.current = screen;
  stream.flushLayout();
  assert.equal(screen.src, 'data:image/png;base64,LATEST');
  stream.socket.message({ type: 'frame', data: 'CURRENT', mime: 'image/png' });
  stream.flushLayout();
  assert.equal(screen.src, 'data:image/png;base64,CURRENT');
  stream.unmount();
});

test('an early image frame is discarded when its session unmounts', () => {
  const stream = mountStream();
  stream.socket.message({ type: 'frame', data: 'OLD', mime: 'image/png' });
  stream.unmount();
  stream.hook.imageRef.current = {};
  stream.flushLayout();
  assert.equal(stream.hook.imageRef.current.src, undefined);
});
