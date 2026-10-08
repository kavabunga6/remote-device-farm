import test from 'node:test';
import assert from 'node:assert/strict';
import { AdbClient, validateAdbArgv } from './adb.mjs';

test('REST ADB commands cannot choose another serial or host file path', () => {
  assert.deepEqual(validateAdbArgv(['shell', 'getprop', 'ro.build.version.release']), ['shell', 'getprop', 'ro.build.version.release']);
  assert.throws(() => validateAdbArgv(['-s', 'other-device', 'shell', 'id']));
  assert.throws(() => validateAdbArgv(['push', '/etc/passwd', '/sdcard/passwd']));
  assert.throws(() => validateAdbArgv(['forward', 'tcp:5037', 'tcp:5037']));
});

test('ADB console permits scoped diagnostics but rejects host-level verbs and extra flags', () => {
  assert.deepEqual(validateAdbArgv(['devices']), ['devices']);
  assert.deepEqual(validateAdbArgv(['version']), ['version']);
  assert.deepEqual(validateAdbArgv(['logcat', '-d', '-t', '200']), ['logcat', '-d', '-t', '200']);
  assert.throws(() => validateAdbArgv(['devices', '-l']));
  assert.throws(() => validateAdbArgv(['version', '-s', 'other']));
  assert.throws(() => validateAdbArgv(['get-state', '-s', 'other']));
  for (const verb of ['connect', 'install', 'pull', 'push', 'forward', 'tcpip', 'kill-server']) {
    assert.throws(() => validateAdbArgv([verb]));
  }
});

test('devices and version return only the selected session and strip agent paths', async () => {
  const calls = [];
  const client = new AdbClient(async (_command, args) => {
    calls.push(args);
    if (args[0] === 'connect') return { stdout: 'connected to rdf-current:5555', stderr: '', exitCode: 0 };
    if (args[0] === 'devices') return {
      stdout: 'List of devices attached\nother:5555\tdevice\nrdf-current:5555\tdevice\n',
      stderr: '', exitCode: 0,
    };
    if (args[0] === 'version') return {
      stdout: 'Android Debug Bridge version 1.0.41\nVersion 36.0.2-14143358\nInstalled as /usr/bin/adb\nRunning on Linux\n',
      stderr: '', exitCode: 0,
    };
    throw new Error('Unexpected command');
  });
  const devices = await client.command('rdf-current:5555', ['devices']);
  assert.equal(devices.stdout, 'List of devices attached\nrdf-current:5555\tdevice\n');
  assert.equal(devices.stdout.includes('other:5555'), false);
  const version = await client.command('rdf-current:5555', ['version']);
  assert.equal(version.stdout, 'Android Debug Bridge version 1.0.41\nVersion 36.0.2-14143358\n');
  assert.equal(version.stdout.includes('/usr/bin'), false);
  assert.deepEqual(calls, [['connect', 'rdf-current:5555'], ['devices'], ['version']]);
});

test('reboot takes no arguments, so a phone cannot be sent to the bootloader or recovery', () => {
  assert.deepEqual(validateAdbArgv(['reboot']), ['reboot']);
  for (const mode of ['bootloader', 'recovery', 'sideload', 'fastboot']) assert.throws(() => validateAdbArgv(['reboot', mode]));
});

test('USB serials are never passed to adb connect, which only applies to network endpoints', async () => {
  const calls = [];
  const adb = new AdbClient(async (cmd, args) => { calls.push(args); return { exitCode: 1, stdout: 'failed to connect', stderr: '' }; });
  await adb.connect('R58M123ABC');
  assert.deepEqual(calls, []);
  await assert.rejects(Promise.race([adb.connect('rdf-abc:5555'), new Promise((_, reject) => setTimeout(() => reject(new Error('stalled')), 200))]), /stalled|not ready/);
  assert.deepEqual(calls[0], ['connect', 'rdf-abc:5555']);
});
