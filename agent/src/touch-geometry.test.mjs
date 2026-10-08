import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTouchGeometry, readTouchGeometry, TouchGeometryCache, parseTouchGeometryChange } from './touch-geometry.mjs';

test('uses the main Android viewport and preserves letterboxing in rotated coordinates', () => {
  const text = `SurfaceOrientation: 0
    Viewport EXTERNAL: displayId=1, orientation=2, physicalFrame=[0, 0, 800, 600], deviceSize=[800, 600]
    Viewport INTERNAL: displayId=0, orientation=1, uniqueId='local:0', logicalFrame=[0, 0, 1280, 720], physicalFrame=[0, 140, 1920, 940], deviceSize=[1920, 1080]`;
  assert.deepEqual(parseTouchGeometry(text), { rotation: 1, width: 1080, height: 1920,
    physicalFrame: { left: 0, top: 140, right: 1920, bottom: 940 }, logicalWidth: 1280, logicalHeight: 720 });
});

test('reads legacy orientation, including 180 degrees with unchanged video dimensions', () => {
  assert.deepEqual(parseTouchGeometry('SurfaceOrientation: 2\n'), { rotation: 2 });
});

test('rejects missing, inactive, secondary, out-of-range and incomplete viewports', () => {
  for (const text of ['', 'SurfaceOrientation: 5',
    'Viewport: displayId=1, orientation=0, physicalFrame=[0,0,800,600], deviceSize=[800,600]',
    'Viewport: displayId=0, orientation=0, isActive=false, physicalFrame=[0,0,800,600], deviceSize=[800,600]',
    'Viewport: displayId=0, orientation=0, physicalFrame=[0,0,900,600], deviceSize=[800,600]',
    'Viewport: displayId=0, orientation=0, deviceSize=[800,600]']) {
    assert.throws(() => parseTouchGeometry(text));
  }
});

test('device errors and cancellation never substitute guessed orientation', async () => {
  await assert.rejects(readTouchGeometry({run: async () => ({exitCode: 1, stdout: 'SurfaceOrientation: 0'})}, 'serial'));
  const abort = new AbortController(); abort.abort(new Error('Stopped'));
  await assert.rejects(readTouchGeometry({run: async () => ({exitCode: 0, stdout: 'SurfaceOrientation: 0'})}, 'serial', abort.signal), /Stopped/);
});


test('geometry cache discards a snapshot invalidated during the read and shares refreshes', async () => {
  const pending = [];
  const cache = new TouchGeometryCache({read: () => new Promise(resolve => pending.push(resolve))});
  const first = cache.get(); const same = cache.get();
  assert.equal(first, same);
  cache.invalidate();
  pending.shift()({rotation: 0});
  await Promise.resolve();
  assert.equal(pending.length, 1);
  pending.shift()({rotation: 2});
  assert.deepEqual(await first, {rotation: 2});
  assert.deepEqual(await cache.get(), {rotation: 2});
  assert.equal(pending.length, 0);
  cache.close();
  await assert.rejects(cache.get(), /closed/);
});

test('geometry observer failure never returns its older cached coordinates', async () => {
  let fail = false;
  const cache = new TouchGeometryCache({read: async () => {if (fail) throw new Error('device gone'); return {rotation: 1};}});
  assert.deepEqual(await cache.get(), {rotation: 1});
  fail = true; cache.invalidate();
  await assert.rejects(cache.get(), /device gone/);
  assert.equal(cache.geometry, null);
  cache.close();
});

test('recognizes pinned scrcpy actual-display transitions, including 180 degrees and unknown display', () => {
  assert.deepEqual(parseTouchGeometryChange('DisplayMonitor: 1080x1920 [rotation=0] -> 1080x1920 [rotation=2]'),
    { rotation: 2, logicalWidth: 1080, logicalHeight: 1920 });
  assert.deepEqual(parseTouchGeometryChange('DisplayMonitor: 1080x1920 [rotation=0] -> (unknown)'), { rotation: null });
  assert.equal(parseTouchGeometryChange('DisplayMonitor: 1080x1920 [rotation=2] (unchanged)'), null);
  assert.equal(parseTouchGeometryChange('DisplayMonitor: onDisplayChanged(0)'), null);
});


test('display notification cannot certify an InputReader viewport still on the previous rotation', async () => {
  let reads = 0;
  const cache = new TouchGeometryCache({read: async () => ({rotation: ++reads < 3 ? 0 : 2})});
  assert.deepEqual(await cache.get(), {rotation: 0});
  cache.invalidate({rotation: 2});
  assert.deepEqual(await cache.get(), {rotation: 2});
  assert.equal(reads, 3);
  cache.close();
});


test('size-only display change waits for the new logical viewport before accepting letterbox mapping', async () => {
  let reads = 0;
  const cache = new TouchGeometryCache({read: async () => parseTouchGeometry(++reads < 3 ?
    'Viewport INTERNAL: displayId=0, orientation=0, logicalFrame=[0,0,1080,1920], physicalFrame=[0,0,1080,1920], deviceSize=[1080,1920]' :
    'Viewport INTERNAL: displayId=0, orientation=0, logicalFrame=[0,0,800,1280], physicalFrame=[0,96,1080,1824], deviceSize=[1080,1920]')});
  await cache.get();
  cache.invalidate({rotation: 0, logicalWidth: 800, logicalHeight: 1280});
  const actual = await cache.get();
  assert.equal(reads, 3);
  assert.equal(actual.logicalWidth, 800);
  assert.deepEqual(actual.physicalFrame, {left: 0, top: 96, right: 1080, bottom: 1824});
  cache.close();
});
