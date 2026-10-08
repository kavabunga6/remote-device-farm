import test from 'node:test';
import assert from 'node:assert/strict';
import { logcatArgv, pageLogcat, parseLogcat, validateLogcatParams } from './logcat.mjs';
import { parseDeviceInfo } from './device-info.mjs';
import { AdbClient } from './adb.mjs';

const SAMPLE = [
  '--------- beginning of main',
  '10-02 20:57:22.101  1234  1250 I ActivityManager: Start proc com.android.chrome',
  '10-02 20:57:22.350   987   987 W WifiService: rssi -61',
  '10-02 20:57:23.000  4321  4321 E AndroidRuntime: FATAL EXCEPTION: main',
  '10-02 20:57:23.000  4321  4321 E AndroidRuntime: java.lang.NullPointerException',
  '--------- beginning of crash',
].join('\n');

test('threadtime lines become structured entries and markers are dropped', () => {
  const entries = parseLogcat(SAMPLE);
  assert.equal(entries.length, 4);
  assert.deepEqual(entries[0], {
    ts: '10-02 20:57:22.101', pid: 1234, tid: 1250, level: 'I', tag: 'ActivityManager', message: 'Start proc com.android.chrome',
  });
  assert.equal(entries[2].level, 'E');
  assert.equal(entries[3].message, 'java.lang.NullPointerException');
});

test('lines without a header are appended to the previous entry', () => {
  const entries = parseLogcat('10-02 20:57:23.000  1  1 E Tag: first\n    at com.example.Foo.bar(Foo.java:10)');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].message, 'first\n    at com.example.Foo.bar(Foo.java:10)');
});

test('the cursor skips entries already delivered at the same millisecond', () => {
  const entries = parseLogcat(SAMPLE);
  const first = pageLogcat(entries, { since: null, skip: 0, lines: 10 });
  assert.equal(first.entries.length, 4);
  assert.deepEqual(first.cursor, { since: '10-02 20:57:23.000', skip: 2 });
  const next = parseLogcat(SAMPLE + '\n10-02 20:57:24.000  1  1 D Tag: later');
  const page = pageLogcat(next, { since: first.cursor.since, skip: first.cursor.skip, lines: 10 });
  assert.deepEqual(page.entries.map((entry) => entry.message), ['later']);
  const idle = pageLogcat(entries, { since: first.cursor.since, skip: first.cursor.skip, lines: 10 });
  assert.deepEqual(idle.entries, []);
  assert.deepEqual(idle.cursor, { since: '10-02 20:57:23.000', skip: 2 });
});

test('logcat parameters are validated and mapped to fixed adb arguments', () => {
  assert.deepEqual(logcatArgv(validateLogcatParams({})),
    ['logcat', '-d', '-v', 'threadtime', '-b', 'main,system,crash', '-t', '1000', '*:V']);
  assert.deepEqual(logcatArgv(validateLogcatParams({ since: '10-02 20:57:23.000', skip: 2, minLevel: 'W', buffers: ['crash'] })),
    ['logcat', '-d', '-v', 'threadtime', '-b', 'crash', '-T', '10-02 20:57:23.000', '*:W']);
  assert.throws(() => validateLogcatParams({ lines: 0 }));
  assert.throws(() => validateLogcatParams({ lines: 100000 }));
  assert.throws(() => validateLogcatParams({ minLevel: 'X' }));
  assert.throws(() => validateLogcatParams({ buffers: ['main; reboot'] }));
  assert.throws(() => validateLogcatParams({ since: '$(reboot)' }));
});

test('AdbClient logcat runs one fixed command for the selected serial', async () => {
  const calls = [];
  const client = new AdbClient(async (_command, args) => {
    calls.push(args);
    if (args[0] === 'connect') return { stdout: 'connected to s:5555', stderr: '', exitCode: 0 };
    return { stdout: SAMPLE, stderr: '', exitCode: 0 };
  });
  const result = await client.logcat('s:5555', { lines: 2 });
  assert.equal(result.entries.length, 2);
  assert.deepEqual(calls[1].slice(0, 4), ['-s', 's:5555', 'logcat', '-d']);
});

const INFO = `##props
[ro.product.manufacturer]: [Google]
[ro.product.brand]: [google]
[ro.product.model]: [Android SDK built for x86]
[ro.product.device]: [generic_x86]
[ro.build.version.release]: [11]
[ro.build.version.sdk]: [30]
[ro.build.version.security_patch]: [2020-09-05]
[ro.build.id]: [RSR1.201013.001]
[ro.build.type]: [userdebug]
[ro.debuggable]: [1]
[ro.product.cpu.abilist]: [x86,armeabi-v7a,armeabi]
[ro.opengles.version]: [196609]
[persist.sys.timezone]: [Europe/Moscow]
##wm
Physical size: 720x1280
Physical density: 320
##uptime
1630.52 3000.00
##mem
MemTotal:        4044324 kB
MemAvailable:    2100000 kB
##df
/dev/block/vdc 5992652 1500000 4400000  26% /data
##battery
  AC powered: true
  USB powered: false
  status: 2
  level: 100
##ip
2: eth0    inet 10.0.2.15/24 brd 10.0.2.255 scope global eth0
1: lo    inet 127.0.0.1/8 scope host lo
##id
uid=0(root) gid=0(root)
##kernel
5.4.0-android11
##pkgs
package:com.example.testapp versionCode:42
package:com.abc.tool versionCode:7
##chrome
    versionName=83.0.4103.106
`;

test('device information is parsed into tester-friendly sections', () => {
  const info = parseDeviceInfo(INFO, new Date('2026-10-02T18:00:00Z'));
  assert.equal(info.device.model, 'Android SDK built for x86');
  assert.deepEqual(info.device.abis, ['x86', 'armeabi-v7a', 'armeabi']);
  assert.equal(info.android.release, '11');
  assert.equal(info.android.sdk, 30);
  assert.equal(info.android.rooted, true);
  assert.equal(info.android.debuggable, true);
  assert.deepEqual(info.display.physical, { width: 720, height: 1280 });
  assert.equal(info.display.density, 320);
  assert.equal(info.graphics.openGl, '3.1');
  assert.equal(info.system.uptimeSeconds, 1630.52);
  assert.equal(info.system.timezone, 'Europe/Moscow');
  assert.deepEqual(info.memory, { totalKb: 4044324, availableKb: 2100000 });
  assert.deepEqual(info.storage, { totalKb: 5992652, usedKb: 1500000, availableKb: 4400000 });
  assert.deepEqual(info.battery, { acPowered: true, usbPowered: false, status: 'charging', level: 100 });
  assert.deepEqual(info.network.addresses, [{ interface: 'eth0', address: '10.0.2.15' }]);
  assert.deepEqual(info.apps.map((app) => app.package), ['com.abc.tool', 'com.example.testapp']);
  assert.equal(info.chrome, '83.0.4103.106');
});

test('missing sections produce nulls instead of failing', () => {
  const info = parseDeviceInfo('##props\n[ro.build.version.sdk]: [34]\n');
  assert.equal(info.android.sdk, 34);
  assert.equal(info.storage, null);
  assert.equal(info.battery, null);
  assert.deepEqual(info.apps, []);
});
