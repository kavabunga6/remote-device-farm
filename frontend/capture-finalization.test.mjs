import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { transform } from 'esbuild';
const source = await transform(await readFile(new URL('./src/capture-finalization.ts', import.meta.url), 'utf8'), { loader: 'ts', format: 'esm' });
const { scheduleCaptureStop } = await import('data:text/javascript;base64,' + Buffer.from(source.code).toString('base64'));

function fixture() {
  let now = 0, nextId = 0, finishes = 0;
  const frames = new Map(), timers = new Map();
  const clock = {
    requestAnimationFrame(callback) { const id = nextId++; frames.set(id, callback); return id; },
    cancelAnimationFrame(id) { frames.delete(id); },
    setTimeout(callback, delay) { const id = nextId++; timers.set(id, { callback, at: now + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
  };
  return {
    clock, finish: () => finishes++, count: () => finishes,
    pending: () => frames.size + timers.size,
    frame() { const pending = [...frames.values()]; frames.clear(); for (const callback of pending) callback(now); },
    advance(ms) {
      now += ms;
      for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.callback(); }
    },
  };
}

test('finalization waits for a painted capture before allowing the encoder to flush', () => {
  const f = fixture(); scheduleCaptureStop(f.finish, 100, f.clock);
  f.advance(200); assert.equal(f.count(), 0);
  f.frame(); f.advance(40); assert.equal(f.count(), 0);
  f.frame(); f.advance(99); assert.equal(f.count(), 0);
  f.advance(1); assert.equal(f.count(), 1); assert.equal(f.pending(), 0);
  f.advance(1000); assert.equal(f.count(), 1);
});

test('a suspended renderer still finalizes within a bounded deadline and cancels its frame callback', () => {
  const f = fixture(); scheduleCaptureStop(f.finish, 100, f.clock);
  f.advance(999); assert.equal(f.count(), 0);
  f.advance(1); assert.equal(f.count(), 1); assert.equal(f.pending(), 0);
  f.frame(); assert.equal(f.count(), 1); assert.equal(f.pending(), 0);
});

test('cancellation at any paint stage removes timers and cannot stop another recording', () => {
  for (const paints of [0, 1, 2]) {
    const f = fixture(); const cancel = scheduleCaptureStop(f.finish, 100, f.clock);
    for (let i = 0; i < paints; i++) f.frame();
    cancel(); cancel(); assert.equal(f.pending(), 0);
    f.advance(2000); f.frame(); assert.equal(f.count(), 0); assert.equal(f.pending(), 0);
  }
});

test('a late paint cannot extend the finalization deadline', () => {
  const f = fixture(); scheduleCaptureStop(f.finish, 100, f.clock);
  f.advance(950); f.frame(); f.frame(); f.advance(50);
  assert.equal(f.count(), 1); assert.equal(f.pending(), 0);
  f.advance(100); assert.equal(f.count(), 1);
});
