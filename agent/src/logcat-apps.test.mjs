import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePackageName, parseLogcatApps, parseAppPids, parseUidLogcat, appUidTokens } from './logcat-apps.mjs';
import { AdbClient } from './adb.mjs';
import { logcatArgv, validateLogcatParams } from './logcat.mjs';

test('only valid package identifiers and numeric UIDs are accepted', () => {
  for (const value of ['com.app;reboot', 'com.app$(id)', '-x', 'com.app\n', '', null, 'com..app']) assert.throws(() => validatePackageName(value));
  assert.equal(validatePackageName('com.example_app.test1'), 'com.example_app.test1');
  assert.deepEqual(parseLogcatApps('package:com.example.app uid:10123\npackage:com.example.app uid:10123\npackage:com.bad;id uid:123\npackage:com.bad.uid uid:999999999999999'), [{ packageName: 'com.example.app', uid: 10123 }]);
  assert.throws(() => validateLogcatParams({ packageName: 'com.app;id' }));
  assert.throws(() => logcatArgv({ ...validateLogcatParams(), uid: '10123;id' }));
});

test('processes follow UID including custom process names and ignore other packages', () => {
  assert.deepEqual(parseAppPids('PID UID NAME\n14 10123 com.example.app\n15 10123 com.example.app:worker\n16 10124 com.example.application\n17 10123 custom.worker', appUidTokens(10123)), [14, 15, 17]);
});

test('package UID filter retains crash history and follows changed PIDs on each poll', async () => {
  const calls = []; let pids = 'PID UID NAME\n14 10123 com.example.app\n15 10123 com.example.app:worker';
  const client = new AdbClient(async (_command, args) => {
    calls.push(args);
    const ok = stdout => ({ stdout, stderr: '', exitCode: 0 });
    if (args[0] === 'connect') return ok('connected');
    if (args.includes('pm')) return ok('package:com.example.app uid:10123\npackage:com.example.shared uid:10123');
    if (args.includes('ps')) return ok(pids);
    return ok('10-02 20:57:23.000 10123 14 14 E AndroidRuntime: crash before restart\n10-02 20:57:23.100 10124 99 99 E OtherApp: excluded');
  });
  const first = await client.logcat('emulator:5555', { packageName: 'com.example.app' });
  assert.deepEqual(first.app.pids, [14, 15]);
  assert.deepEqual(first.app.sharedPackages, ['com.example.shared']);
  pids = 'PID UID NAME\n201 10123 custom.worker';
  const next = await client.logcat('emulator:5555', { packageName: 'com.example.app' });
  assert.deepEqual(next.app.pids, [201]);
  assert.equal(next.entries.length, 1);
  assert.equal(next.entries[0].pid, 14, 'crash history is not discarded after process restart');
  pids = 'PID UID NAME';
  assert.deepEqual((await client.logcat('emulator:5555', { packageName: 'com.example.app' })).app.pids, []);
  for (const args of calls.filter(args => args.includes('logcat'))) {
    assert.ok(args.includes('uid'));
    assert.ok(!args.some(arg => arg.startsWith('--uid')));
    assert.ok(!args.some(arg => arg.startsWith('--pid')));
    assert.deepEqual(args.slice(0,2), ['-s', 'emulator:5555']);
  }
  assert.deepEqual(calls.find(args => args.includes('pm')), ['-s','emulator:5555','shell','pm','list','packages','-U','--user','current']);
});

test('an uninstalled package fails without reading the whole device log', async () => {
  const calls = [];
  const client = new AdbClient(async (_cmd, args) => { calls.push(args); return { stdout: args[0] === 'connect' ? 'connected' : '', stderr: '', exitCode: 0 }; });
  await assert.rejects(client.logcat('s:5555', { packageName: 'com.example.missing' }), /не установлено/);
  assert.ok(!calls.some(args => args.includes('logcat')));
});

test('Android UID output accepts numeric and short Android names, rejects missing UID', () => {
  const rows = parseUidLogcat('10-02 20:57:23.000 u0_a1 12 13 E App: crash\n10-02 20:57:23.001 10123 99 99 I Other: hello');
  assert.equal(rows[0].uid, 'u0_a1');
  assert.deepEqual([...appUidTokens(10001)], ['10001', 'u0_a1']);
  assert.deepEqual([...appUidTokens(1001, 'radio')], ['1001', 'radio']);
  assert.throws(() => parseUidLogcat('10-02 20:57:23.000 12 13 E App: no uid'), /не передал UID/);
});
