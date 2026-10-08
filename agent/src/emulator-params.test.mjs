import test from 'node:test';
import assert from 'node:assert/strict';
import { validateEmulatorParams } from './emulator-params.mjs';

test('emulator options accept explicit safe switches and bounded values', () => {
  for (const value of ['', '-no-metrics', '-no-snapshot -no-boot-anim -no-metrics', '-timezone Europe/Moscow -change-language ru -change-country RU',
    '-netdelay 0:60000 -netspeed 1:1000000', '-netspeed 1000:100', '-netdelay lte -netspeed full',
    '-camera-front none -camera-back emulated -screen multi-touch']) {
    assert.equal(validateEmulatorParams(value), value);
  }
  assert.equal(validateEmulatorParams('  -no-snapshot   -verbose  '), '-no-snapshot -verbose');
});

test('emulator options cannot pass host, filesystem, network endpoints or QEMU settings', () => {
  for (const value of ['--privileged', '-v /:/host', '-qemu -net user', '-sdcard /etc/passwd',
    '-data /data/file', '-partition-size 131072', '-gpu host', '-memory 99999',
    '-http-proxy 127.0.0.1:8080', '-dns-server 127.0.0.1', '-ports 5554,5555',
    '-prop qemu.name=test', '-camera-front webcam0', '-camera-back imagefile:/etc/passwd',
    '-no-snapshot;id', '-no-snapshot\nid', '-no-snapshot\tid', '$(id)', '`id`', '-verbose > /tmp/log',
    'constructor anything', '__proto__ anything']) {
    assert.throws(() => validateEmulatorParams(value), undefined, value);
  }
});

test('emulator options reject duplicates, malformed values and excessive length', () => {
  for (const value of ['-no-metrics -no-metrics', '-no-metrics yes', '-no-snapshot -no-snapshot', '-noaudio -no-audio', '-nocache -no-cache',
    '-change-language russia', '-change-country RUS', '-timezone ../Europe/Moscow', '-timezone', '-change-language -verbose',
    '-netdelay 60001', '-netdelay 100:50', '-netspeed 0', '-netspeed 1000001',
    '-netspeed 0:100', '-screen other', '-verbose '.repeat(100)]) {
    assert.throws(() => validateEmulatorParams(value), undefined, value);
  }
  assert.throws(() => validateEmulatorParams(null));
});
