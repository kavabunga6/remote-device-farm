import assert from 'node:assert/strict';
import test from 'node:test';
import { EnvTools, buildEnvOp, parseEnvState, quoteDevice, ENV_READ_SCRIPT } from './env-tools.mjs';

const argvs = (op, params) => buildEnvOp(op, params).steps.map((s) => s.argv);

test('network profiles and presets become fixed console argv', () => {
  assert.deepEqual(argvs('network', { profile: '3g-slow' }), [['emu', 'network', 'speed', 'umts'], ['emu', 'network', 'delay', 'umts']]);
  assert.deepEqual(argvs('network', { profile: 'full' }), [['emu', 'network', 'speed', 'full'], ['emu', 'network', 'delay', 'none']]);
  assert.deepEqual(argvs('network', { speed: 'lte' }), [['emu', 'network', 'speed', 'lte'], ['emu', 'network', 'delay', 'none']]);
  assert.deepEqual(argvs('network', { speed: 'edge', delay: 'gprs' }), [['emu', 'network', 'speed', 'edge'], ['emu', 'network', 'delay', 'gprs']]);
  for (const bad of [{ profile: 'fast' }, { speed: '; reboot' }, { speed: 'lte', delay: 'huge' }, { profile: 'full', speed: 'lte' }, {}, { profile: '__proto__' }]) {
    assert.throws(() => buildEnvOp('network', bad), bad.profile === 'full' ? /either/ : /Invalid/);
  }
});

test('geolocation is range checked and sent as lon lat', () => {
  assert.deepEqual(argvs('geo', { lat: 55.7558, lon: 37.6173 }), [['emu', 'geo', 'fix', '37.6173', '55.7558']]);
  assert.deepEqual(argvs('geo', { lat: '-33.8688', lon: '151.2093', alt: 12 }), [['emu', 'geo', 'fix', '151.2093', '-33.8688', '12']]);
  for (const bad of [{ lat: 91, lon: 0 }, { lat: 0, lon: 181 }, { lat: NaN, lon: 0 }, { lat: '1; reboot', lon: 0 }, { lat: 0 }, { lat: 0, lon: 0, alt: 99999 }, { lat: 0, lon: 0, extra: 1 }]) {
    assert.throws(() => buildEnvOp('geo', bad));
  }
});

test('appearance settings build exact shell argv', () => {
  assert.deepEqual(argvs('dark_mode', { mode: 'yes' }), [['shell', 'cmd', 'uimode', 'night', 'yes']]);
  assert.deepEqual(argvs('font_scale', { scale: 1.3 }), [['shell', 'settings', '--user', 'current', 'put', 'system', 'font_scale', '1.3']]);
  assert.deepEqual(argvs('font_scale', { scale: 0.85 }), [['shell', 'settings', '--user', 'current', 'put', 'system', 'font_scale', '0.85']]);
  assert.deepEqual(argvs('display_size', { width: 1080, height: 1920 }), [['shell', 'wm', 'size', '1080x1920']]);
  assert.deepEqual(argvs('display_size', { reset: true }), [['shell', 'wm', 'size', 'reset']]);
  assert.deepEqual(argvs('display_density', { dpi: 320 }), [['shell', 'wm', 'density', '320']]);
  assert.deepEqual(argvs('display_density', { reset: true }), [['shell', 'wm', 'density', 'reset']]);
  assert.deepEqual(argvs('animations', { enabled: false }), [
    ['shell', 'settings', 'put', 'global', 'window_animation_scale', '0'],
    ['shell', 'settings', 'put', 'global', 'transition_animation_scale', '0'],
    ['shell', 'settings', 'put', 'global', 'animator_duration_scale', '0']]);
  assert.deepEqual(argvs('show_touches', { enabled: true }), [['shell', 'settings', '--user', 'current', 'put', 'system', 'show_touches', '1']]);
  assert.deepEqual(argvs('pointer_location', { enabled: false }), [['shell', 'settings', '--user', 'current', 'put', 'system', 'pointer_location', '0']]);
  for (const [op, bad] of [['dark_mode', { mode: 'yes; reboot' }], ['dark_mode', { mode: 'maybe' }], ['font_scale', { scale: 0.5 }], ['font_scale', { scale: 2.5 }],
    ['font_scale', { scale: '1.2;id' }], ['display_size', { width: 100, height: 100 }], ['display_size', { width: 1080.5, height: 1920 }], ['display_size', { reset: true, width: 400 }],
    ['display_density', { dpi: 5000 }], ['display_density', { dpi: '$(id)' }], ['animations', { enabled: 'yes' }], ['show_touches', {}], ['pointer_location', { enabled: 1 }]]) {
    assert.throws(() => buildEnvOp(op, bad), undefined, op + ' ' + JSON.stringify(bad));
  }
});

test('battery and time zone', () => {
  assert.deepEqual(argvs('battery', { level: 15 }), [['shell', 'dumpsys', 'battery', 'set', 'level', '15']]);
  assert.deepEqual(argvs('battery', { level: 80, charging: 'usb' }), [
    ['shell', 'dumpsys', 'battery', 'set', 'level', '80'], ['shell', 'dumpsys', 'battery', 'set', 'ac', '0'], ['shell', 'dumpsys', 'battery', 'set', 'usb', '1']]);
  assert.deepEqual(argvs('battery', { charging: 'none' }), [['shell', 'dumpsys', 'battery', 'set', 'ac', '0'], ['shell', 'dumpsys', 'battery', 'set', 'usb', '0']]);
  assert.deepEqual(argvs('battery', { reset: true }), [['shell', 'dumpsys', 'battery', 'reset']]);
  for (const bad of [{}, { level: 101 }, { level: -1 }, { level: 1.5 }, { charging: 'wireless' }, { reset: true, level: 5 }, { level: '5; reboot' }]) {
    assert.throws(() => buildEnvOp('battery', bad));
  }
  assert.deepEqual(argvs('timezone', { zone: 'Europe/Moscow' }), [['shell', 'cmd', 'alarm', 'set-timezone', 'Europe/Moscow']]);
  for (const zone of ['Mars/Olympus', 'Europe/Moscow; reboot', '../etc', '$(id)', 'Europe/Moscow\n', '', 5]) {
    assert.throws(() => buildEnvOp('timezone', { zone }), /time zone/);
  }
});

test('deep links are validated and quoted for the device shell', () => {
  assert.deepEqual(argvs('deeplink', { uri: 'myapp://item/42' }), [['shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', 'myapp://item/42']]);
  assert.deepEqual(argvs('deeplink', { uri: 'https://example.com/a?x=1&y=2#top' }),
    [['shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', "'https://example.com/a?x=1&y=2#top'"]]);
  const injections = ['https://x.com/; reboot', 'https://x.com/`id`', 'https://x.com/$(id)', 'https://x.com/a b', 'https://x.com/\nreboot',
    "https://x.com/'; id; '", 'https://x.com/"a"', 'https://x.com/a|b', 'https://x.com/a>b', 'https://x.com/a\\b', 'https://x.com/a{b}', 'https://x.com/(a)',
    'javascript:alert(1)', 'file:///etc/passwd', 'content://sms/inbox', 'intent://x#Intent;end', 'x', '://nohost', 'a:b', 'ftp', 'HTTP://x.com', 'https:nohost',
    'https://x.com/' + 'a'.repeat(2000), '', 5, null, 'ht tp://x.com', 'my_app://x'];
  for (const uri of injections) assert.throws(() => buildEnvOp('deeplink', { uri }), undefined, String(uri).slice(0, 40));
  assert.doesNotThrow(() => buildEnvOp('deeplink', { uri: 'https://x.com/' + 'a'.repeat(1900) }));
  assert.equal(quoteDevice("a'b"), "'a'\\''b'");
  assert.equal(quoteDevice('plain-1.2'), 'plain-1.2');
});

test('app helpers validate package and permission names', () => {
  assert.deepEqual(argvs('app_clear', { package: 'com.example.app' }), [['shell', 'pm', 'clear', 'com.example.app']]);
  assert.deepEqual(argvs('app_stop', { package: 'com.example.app' }), [['shell', 'am', 'force-stop', 'com.example.app']]);
  assert.deepEqual(argvs('app_grant', { package: 'com.example.app', permission: 'android.permission.CAMERA' }),
    [['shell', 'pm', 'grant', 'com.example.app', 'android.permission.CAMERA']]);
  assert.deepEqual(argvs('app_revoke', { package: 'com.example.app', permission: 'android.permission.CAMERA' }),
    [['shell', 'pm', 'revoke', 'com.example.app', 'android.permission.CAMERA']]);
  for (const bad of ['com.example.app; reboot', 'com', 'com.example.app\n', '$(id).x', '`id`.x', '-r.x', 'com..x', '1com.x', 'a.b c', 'com.' + 'a'.repeat(300), '', null]) {
    assert.throws(() => buildEnvOp('app_clear', { package: bad }), /Invalid package/, String(bad).slice(0, 30));
    assert.throws(() => buildEnvOp('app_grant', { package: 'com.example.app', permission: bad }), /Invalid permission/);
  }
  assert.throws(() => buildEnvOp('app_clear', { package: 'com.example.app', extra: 1 }), /Unknown parameter/);
});

test('removed snapshot operations are rejected before connecting to a device', async () => {
  const adb = { connect: async () => assert.fail('Do not connect'), run: async () => assert.fail('Do not execute') };
  for (const op of ['snapshot_save', 'snapshot_load', 'snapshot_delete', 'snapshot_list']) {
    assert.throws(() => buildEnvOp(op, { name: 'clean' }), /Unknown environment operation/);
    await assert.rejects(new EnvTools(adb).apply('s', op, { name: 'clean' }), /Unknown environment operation/);
  }
});

test('unknown operations and bad params containers are rejected', () => {
  assert.throws(() => buildEnvOp('reboot', {}), /Unknown environment operation/);
  assert.throws(() => buildEnvOp('shell', { cmd: 'id' }), /Unknown/);
  assert.throws(() => buildEnvOp('dark_mode', ['yes']), /object/);
  assert.throws(() => buildEnvOp('dark_mode', 'yes'), /object/);
});

test('device state parser', () => {
  const state = parseEnvState('night=Night mode: yes\nfont=1.3\nwa=0.0\nta=0.0\nda=0.0\ntouches=1\npointer=null\ntz=Europe/Moscow\n' +
    'Physical size: 1080x1920\nOverride size: 720x1280\nPhysical density: 420\nBattery service state:\nAC powered: false\nUSB powered: true\n  level: 42\n');
  assert.deepEqual(state, { proxy: null, darkMode: 'yes', fontScale: 1.3, animations: false, showTouches: true, pointerLocation: null, timezone: 'Europe/Moscow',
    size: { physical: '1080x1920', override: '720x1280' }, density: { physical: 420, override: null }, battery: { level: 42, charging: 'usb' } });
});

function fakeAdb(handler) {
  const calls = [];
  return { calls, connect: async () => {}, run: async (serial, argv) => { calls.push(argv); return handler(argv); } };
}
const ok = (stdout = '') => ({ stdout, stderr: '', exitCode: 0 });

test('apply runs each step and reports console and shell failures', async () => {
  const adb = fakeAdb(() => ok('OK\n'));
  assert.deepEqual(await new EnvTools(adb).apply('h:5555', 'network', { profile: 'edge' }), { op: 'network', applied: true });
  assert.deepEqual(adb.calls, [['emu', 'network', 'speed', 'edge'], ['emu', 'network', 'delay', 'edge']]);
  await assert.rejects(new EnvTools(fakeAdb(() => ok('KO: bad speed\n'))).apply('s', 'network', { profile: 'edge' }), /bad speed/);
  await assert.rejects(new EnvTools(fakeAdb(() => ({ stdout: '', stderr: 'error: not an emulator', exitCode: 1 }))).apply('s', 'geo', { lat: 1, lon: 2 }), /not an emulator/);
  await assert.rejects(new EnvTools(fakeAdb(() => ok('Error: Activity not started, unable to resolve Intent\n'))).apply('s', 'deeplink', { uri: 'https://x.com/' }), /Activity not started/);
  await assert.rejects(new EnvTools(fakeAdb(() => ok('java.lang.SecurityException: not granted\n'))).apply('s', 'app_grant', { package: 'a.b', permission: 'x.y' }), /SecurityException/);
  await assert.rejects(new EnvTools(fakeAdb(() => ok())).apply('s', 'geo', { lat: 100, lon: 0 }), /lat/);
});

test('read requests only shell state and does not require the emulator console', async () => {
  const device = 'night=Night mode: no\nfont=1.0\nwa=1.0\nta=1.0\nda=1.0\ntz=UTC\nPhysical size: 1080x1920\nPhysical density: 420\nAC powered: true\nUSB powered: false\nlevel: 100\n';
  const adb = fakeAdb(() => ok(device));
  const control = { emuConsole: async () => assert.fail('State reading must not use the console') };
  const state = await new EnvTools(adb, { control }).read('s', { sessionId: 'session-12345678' });
  assert.deepEqual(adb.calls, [['shell', ENV_READ_SCRIPT]]);
  assert.deepEqual(state, parseEnvState(device));
  assert.equal(state.darkMode, 'no');
  assert.equal(state.animations, true);
});


test('system appearance settings read and write the foreground Android user', () => {
  for (const key of ['font_scale', 'show_touches', 'pointer_location']) {
    assert.ok(ENV_READ_SCRIPT.includes('settings --user current get system ' + key));
  }
  assert.deepEqual(buildEnvOp('show_touches', { enabled: true }).verify[0].step.argv,
    ['shell', 'settings', '--user', 'current', 'get', 'system', 'show_touches']);
});

test('appearance updates confirm stored values, including all animation scales', async () => {
  for (const [op, params, value, expectedReads] of [
    ['show_touches', { enabled: true }, '1', 1],
    ['show_touches', { enabled: false }, '0', 1],
    ['pointer_location', { enabled: true }, '1', 1],
    ['font_scale', { scale: 1.3 }, '1.30', 1],
    ['animations', { enabled: false }, '0.0', 3],
    ['animations', { enabled: true }, '1.0', 3],
  ]) {
    const adb = fakeAdb(argv => argv.includes('get') ? ok(value + '\n') : ok());
    assert.deepEqual(await new EnvTools(adb).apply('s', op, params), { op, applied: true });
    assert.equal(adb.calls.filter(argv => argv.includes('get')).length, expectedReads, op);
    assert.ok(adb.calls.every(argv => argv[0] === 'shell'), 'Appearance verification uses only shell commands');
  }
});

test('appearance update rejects a zero-exit Android error printed to stderr', async () => {
  for (const message of [
    'Exception occurred while executing put: java.lang.SecurityException: denied',
    'java.lang.SecurityException: Permission denial: not allowed',
    'Permission denial: writing settings requires permission',
    'Error: failed to update setting',
  ]) {
    const adb = fakeAdb(() => ({ stdout: '', stderr: message + '\n', exitCode: 0 }));
    await assert.rejects(new EnvTools(adb).apply('s', 'show_touches', { enabled: true }), error => error.message === message);
    assert.equal(adb.calls.length, 1, 'Do not run later commands after an Android error');
  }
});

test('appearance update rejects unchanged, unknown and unreadable settings', async () => {
  for (const actual of ['0', 'null', '', 'not-a-number']) {
    const adb = fakeAdb(argv => argv.includes('get') ? ok(actual) : ok());
    await assert.rejects(new EnvTools(adb).apply('s', 'show_touches', { enabled: true }), /Android.*show_touches/);
  }
  const unreadable = fakeAdb(argv => argv.includes('get')
    ? { stdout: '', stderr: 'Device disconnected', exitCode: 1 } : ok());
  await assert.rejects(new EnvTools(unreadable).apply('s', 'animations', { enabled: false }), /Device disconnected/);
});

test('animations are not reported disabled if one scale remains enabled', async () => {
  const adb = fakeAdb(argv => argv.includes('get')
    ? ok(argv.at(-1) === 'animator_duration_scale' ? '1.0' : '0.0') : ok());
  await assert.rejects(new EnvTools(adb).apply('s', 'animations', { enabled: false }), /Android.*animator_duration_scale/);
  assert.equal(adb.calls.filter(argv => argv.includes('get')).length, 3);
});


test('console failures preserve stdout diagnostics and reject unconfirmed replies', async () => {
  for (const [result, message] of [
    [{ stdout: 'error: could not connect to TCP port 5554: Connection refused\n', stderr: '', exitCode: 1 }, /could not connect to TCP port 5554/],
    [{ stdout: '', stderr: 'console authentication failed', exitCode: 1 }, /console authentication failed/],
    [{ stdout: 'KO: invalid coordinates\r\n', stderr: '', exitCode: 0 }, /invalid coordinates/],
    [{ stdout: '', stderr: '', exitCode: 1 }, /код 1/],
    [{ stdout: '', stderr: '', exitCode: 0 }, /не подтвердила/],
  ]) {
    const adb = fakeAdb(() => result);
    await assert.rejects(new EnvTools(adb).apply('s', 'geo', { lat: 55.7558, lon: 37.6173 }), message);
    assert.equal(adb.calls.length, 1);
  }
});


test('proxy accepts a bounded host and port and reset removes the device proxy', async () => {
  const plan = buildEnvOp('proxy', { host: 'Proxy.example', port: 8080 });
  assert.deepEqual(plan.steps.map(s => s.argv), [['shell', 'settings', 'put', 'global', 'http_proxy', 'proxy.example:8080']]);
  const adb = fakeAdb(argv => ok(argv.includes('get') ? 'proxy.example:8080' : ''));
  await new EnvTools(adb).apply('s', 'proxy', { host: 'Proxy.example', port: 8080 });
  const reset = fakeAdb(argv => ok(argv.includes('get') ? ':0' : ''));
  await new EnvTools(reset).apply('s', 'proxy', { reset: true });
  assert.deepEqual(reset.calls[0], ['shell', 'settings', 'put', 'global', 'http_proxy', ':0']);
  for (const params of [{ host: 'http://proxy', port: 8080 }, { host: 'proxy;id', port: 8080 }, { host: 'user@proxy', port: 8080 },
    { host: 'proxy\n', port: 8080 }, { host: '-host', port: 1 }, { host: '::1', port: 8080 }, { host: 'a'.repeat(64), port: 8080 },
    { host: 'proxy', port: 0 }, { host: 'proxy', port: 65536 }, { host: 'proxy', port: 1.5 }, { reset: true, host: 'proxy' }, { reset: false }]) {
    assert.throws(() => buildEnvOp('proxy', params));
  }
  const refused = fakeAdb(argv => ok(argv.includes('get') ? 'null' : ''));
  await assert.rejects(new EnvTools(refused).apply('s', 'proxy', { host: 'proxy', port: 8080 }), /Android.*http_proxy/);
});

test('environment read distinguishes configured, disabled and unreadable proxy', () => {
  assert.deepEqual(parseEnvState('proxy=proxy.example:3128').proxy, { enabled: true, host: 'proxy.example', port: 3128 });
  for (const raw of ['null', ':0', ':-1', '']) assert.equal(parseEnvState('proxy='+raw).proxy.enabled, false);
  for (const raw of ['host:99999', 'host:0', 'invalid']) assert.equal(parseEnvState('proxy='+raw).proxy, null);
  assert.equal(parseEnvState('').proxy, null);
});
