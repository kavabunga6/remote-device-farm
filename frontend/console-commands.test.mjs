import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { validateAdbArgv } from '../agent/src/adb.mjs';

const entry = fileURLToPath(new URL('./src/console-commands.ts', import.meta.url));
const bundle = await build({ entryPoints: [entry], bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent' });
const m = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].contents).toString('base64'));
const { getConsoleCommands, parseConsoleCommand, isConsoleTemplate, completionForCommand, searchConsoleCatalog, consoleSuggestions, parseDynamicNames, dynamicConsoleHints } = m;
const CONSOLE_COMMANDS = getConsoleCommands();

test('catalog entries are unique and complete', () => {
  assert.equal(CONSOLE_COMMANDS.length, 81);
  assert.equal(new Set(CONSOLE_COMMANDS.map(h => h.command)).size, 81);
  for (const h of CONSOLE_COMMANDS) {
    for (const field of ['command', 'label', 'description', 'category', 'syntax', 'arguments', 'example']) {
      assert.ok(h[field]?.trim(), h.command + ': missing ' + field);
    }
  }
});

test('representative bare Android commands use the agent allowlist', () => {
  for (const [input, expected] of [
    ['devices', ['devices']],
    ['getprop ro.build.version.release', ['shell', 'getprop ro.build.version.release']],
    ['pm list packages -3', ['shell', 'pm list packages -3']],
    ['dumpsys battery', ['shell', 'dumpsys battery']],
    ['cmd package help', ['shell', 'cmd package help']],
  ]) {
    const argv = parseConsoleCommand(input);
    assert.deepEqual(argv, expected, input);
    assert.deepEqual(validateAdbArgv(argv), argv, input);
  }
});

test('all runnable catalog commands and examples pass the agent validation', () => {
  let checked = 0;
  for (const h of CONSOLE_COMMANDS) {
    if (h.access !== 'console') continue;
    for (const input of [h.example, ...(isConsoleTemplate(h.command) ? [] : [h.command])]) {
      const argv = parseConsoleCommand(input);
      assert.deepEqual(validateAdbArgv(argv), argv, input);
      checked++;
    }
  }
  assert.ok(checked > 100, 'Only ' + checked + ' commands checked');
});

test('templates and host-only or binary ADB verbs cannot execute', () => {
  for (const h of CONSOLE_COMMANDS.filter(h => h.access === 'console' && isConsoleTemplate(h.command))) {
    assert.throws(() => parseConsoleCommand(h.command), undefined, h.command);
  }
  for (const input of [
    'install <apk>', 'adb connect 127.0.0.1:5555', 'connect 127.0.0.1:5555',
    'push local.apk /sdcard/local.apk', 'pull /sdcard/local.apk local.apk',
    'start-server', 'kill-server', 'forward tcp:1 tcp:2', 'root', 'exec-out screencap -p',
  ]) assert.throws(() => parseConsoleCommand(input), undefined, input);
  for (const argv of [['connect', '127.0.0.1:5555'], ['push', 'local.apk', '/sdcard/local.apk']]) {
    assert.throws(() => validateAdbArgv(argv));
  }
});

test('RU and EN search, categories, and suggestion limits', () => {
  const has = (results, command) => results.some(h => h.command === command);
  assert.ok(has(searchConsoleCatalog('версия'), 'getprop ro.build.version.release'));
  assert.ok(has(searchConsoleCatalog('battery'), 'dumpsys battery'));
  assert.ok(has(searchConsoleCatalog('packages'), 'pm list packages -3'));
  assert.ok(has(searchConsoleCatalog('', 'network'), 'ip addr'));
  assert.ok(has(consoleSuggestions('cmd package'), 'cmd package help'));
  assert.ok(consoleSuggestions('cmd package').length <= 8);
});

test('completion only returns insert text for console entries', () => {
  const hint = CONSOLE_COMMANDS.find(h => h.command === 'dumpsys battery');
  assert.ok(hint);
  assert.equal(completionForCommand(hint), 'dumpsys battery');
  assert.deepEqual(parseConsoleCommand(completionForCommand(hint)), ['shell', 'dumpsys battery']);
  for (const h of CONSOLE_COMMANDS.filter(h => h.access !== 'console')) {
    assert.equal(completionForCommand(h), null, h.command);
  }
});

test('dynamic names are sanitized, deduplicated, and capped', () => {
  assert.deepEqual(parseDynamicNames('Currently running services:\n  activity\n  package\n malicious;rm\n', 'dumpsys'), ['activity', 'package']);
  assert.deepEqual(parseDynamicNames('activity\npackage\nother service\nactivity\n', 'cmd'), ['activity', 'package']);
  assert.deepEqual(parseDynamicNames('package:com.example.app\npackage:com.android.settings\n', 'packages'), ['com.example.app', 'com.android.settings']);
  const names = parseDynamicNames(Array.from({ length: 300 }, (_, i) => 'service' + i).join('\n'), 'cmd');
  assert.equal(names.length, 256);
  assert.equal(new Set(names).size, 256);
  assert.ok(names.every(name => /^[A-Za-z0-9_.:/-]{1,80}$/.test(name)));
});

test('dynamic suggestions use only the device context and remain agent-valid', () => {
  const services = { cmd: ['package'], dumpsys: ['battery'], packages: ['com.example.app'] };
  const dumpsysHints = dynamicConsoleHints('dumpsys bat', services);
  assert.ok(dumpsysHints.some(h => h.dynamic && h.command === 'dumpsys battery'));
  const cmdHints = dynamicConsoleHints('cmd pack', services);
  assert.ok(cmdHints.some(h => h.dynamic && isConsoleTemplate(h.command)));
  const packageHints = dynamicConsoleHints('pm path com', services);
  assert.ok(packageHints.some(h => h.dynamic && h.command === 'pm path com.example.app'));
  assert.deepEqual(dynamicConsoleHints('battery', services), []);
  for (const h of [...dumpsysHints, ...packageHints]) {
    const argv = parseConsoleCommand(completionForCommand(h));
    assert.deepEqual(validateAdbArgv(argv), argv);
  }
});
test('fixed discovery argv remain within the agent allowlist', () => {
  for (const argv of [
    ['shell', 'cmd', '-l'],
    ['shell', 'dumpsys', '-l'],
    ['shell', 'pm', 'list', 'packages', '-3'],
  ]) assert.deepEqual(validateAdbArgv(argv), argv);
});
