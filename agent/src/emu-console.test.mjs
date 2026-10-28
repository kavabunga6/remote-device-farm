import assert from 'node:assert/strict';
import test from 'node:test';
import net from 'node:net';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CONSOLE_SCRIPT, EMU_UNAVAILABLE_PREFIX, parseDockerStream, runEmuConsole, validateEmuConsoleArgs } from './emu-console.mjs';
import { validateControlRequest } from './control-ipc.mjs';
import { EnvTools } from './env-tools.mjs';

const SESSION = 'session-12345678';
const good = [['network', 'status'], ['network', 'speed', 'lte'], ['network', 'delay', 'none'], ['geo', 'fix', '37.6173', '55.7558'],
  ['geo', 'fix', '-180', '90', '12.5']];

test('allowed console command shapes are accepted', () => {
  for (const args of good) {
    assert.deepEqual(validateEmuConsoleArgs(args), args);
    assert.equal(validateControlRequest({ op: 'emuConsole', sessionId: SESSION, args }).op, 'emuConsole');
  }
});

test('injection and malformed commands are rejected', () => {
  const badArgs = [[], ['network'], ['network', 'status', 'x'], ['network', 'speed', '; reboot'], ['network', 'speed', 'lte', 'x'],
    ['network', 'speed', 'lte\nkill'], ['kill'], ['quit'], ['redir', 'add', 'tcp:1:2'], ['geo', 'fix', '1'], ['geo', 'fix', '1', '2', '3', '4'],
    ['geo', 'fix', '181', '0'], ['geo', 'fix', '0', '91'], ['geo', 'fix', '0', '0', '20000'], ['geo', 'fix', 'NaN', '0'],
    ['geo', 'fix', 'Infinity', '0'], ['geo', 'fix', '1e3', '0'], ['geo', 'fix', '$(id)', '0'], ['geo', 'fix', '0x10', '0'],
    ['avd', 'stop'], ['network', 'speed', 5], 'network status', null, ['network', 'status\n']];
  for (const args of badArgs) {
    assert.throws(() => validateEmuConsoleArgs(args), undefined, JSON.stringify(args));
    assert.throws(() => validateControlRequest({ op: 'emuConsole', sessionId: SESSION, args }));
  }
  assert.throws(() => validateControlRequest({ op: 'emuConsole', sessionId: SESSION }));
  assert.throws(() => validateControlRequest({ op: 'emuConsole', sessionId: SESSION, args: ['network', 'status'], cmd: 'x' }));
});

test('removed snapshot commands are rejected by both console and control APIs', async () => {
  const docker = { request: async () => assert.fail('Do not execute removed commands') };
  for (const action of ['list', 'save', 'load', 'delete']) {
    const args = ['avd', 'snapshot', action, ...(action === 'list' ? [] : ['clean'])];
    assert.throws(() => validateEmuConsoleArgs(args), /Invalid emulator console command/);
    assert.throws(() => validateControlRequest({ op: 'emuConsole', sessionId: SESSION, args }), /Invalid emulator console command/);
    await assert.rejects(runEmuConsole(docker, 'c', args), /Invalid emulator console command/);
  }
});

const frame = (type, text) => {
  const body = Buffer.from(text);
  const header = Buffer.alloc(8);
  header[0] = type;
  header.writeUInt32BE(body.length, 4);
  return Buffer.concat([header, body]);
};

test('multiplexed docker stream is split and limited', () => {
  const parsed = parseDockerStream(Buffer.concat([frame(1, 'OK\r\n'), frame(2, 'warn'), frame(1, 'more')]));
  assert.deepEqual(parsed, { stdout: 'OK\nmore', stderr: 'warn', truncated: false });
  const cut = parseDockerStream(frame(1, 'x'.repeat(100)), 10);
  assert.equal(cut.stdout.length, 10);
  assert.equal(cut.truncated, true);
  assert.throws(() => parseDockerStream(Buffer.from([9, 0, 0, 0, 0, 0, 0, 1, 65])), /Malformed/);
  assert.throws(() => parseDockerStream(frame(1, 'OK').subarray(0, 9)), /Malformed/);
  assert.throws(() => parseDockerStream(frame(1, 'OK').subarray(0, 7)), /Malformed/);
  assert.equal(parseDockerStream(Buffer.alloc(0)).stdout, '');
});

function fakeDocker(handlers) {
  const execs = [];
  return {
    execs,
    async request(method, path, body) {
      if (path.endsWith('/exec')) { execs.push(body); return { Id: 'abcdef0123456789' + execs.length }; }
      if (path.includes('/exec/') && path.endsWith('/json')) return { Running: false, ExitCode: handlers[execs.length - 1].exitCode };
      throw new Error('unexpected ' + path);
    },
    async requestRaw() {
      const h = handlers[execs.length - 1];
      if (h.throw) throw new Error(h.throw);
      return Buffer.concat([frame(1, h.out ?? ''), frame(2, h.err ?? '')]);
    },
  };
}

test('console execution stays inside the container with fixed loopback ports and a watchdog', async () => {
  const docker = fakeDocker([{ exitCode: 0, out: 'OK\r\n' }]);
  const result = await runEmuConsole(docker, 'c1', ['network', 'speed', 'lte'], { timeoutMs: 20000 });
  assert.deepEqual(result, { stdout: 'OK\n', stderr: '', exitCode: 0, path: 'console' });
  assert.deepEqual(docker.execs[0].Cmd, ['sh', '-c', CONSOLE_SCRIPT]);
  assert.deepEqual(docker.execs[0].Env, ['EMU_CMD=network speed lte', 'EMU_CONSOLE_PORTS=5556 5554', 'EMU_TIMEOUT_SECONDS=18']);
  assert.equal(docker.execs[0].AttachStdout, true);
  assert.equal(docker.execs[0].AttachStdin, false);
  assert.equal(docker.execs[0].Tty, false);
});

test('all console commands use the same bounded default deadline', async () => {
  for (const [args, watchdogSeconds] of [
    [['network', 'speed', 'lte'], 18],
    [['network', 'delay', 'none'], 18],
    [['network', 'status'], 18],
    [['geo', 'fix', '1', '2'], 18],
  ]) {
    const docker = fakeDocker([{ exitCode: 0, out: 'OK\n' }]);
    await runEmuConsole(docker, 'c1', args);
    assert.ok(docker.execs[0].Env.includes('EMU_TIMEOUT_SECONDS=' + watchdogSeconds), args.join(' '));
  }
});

test('console failure is never retried and empty success is rejected', async () => {
  const docker = fakeDocker([{ exitCode: 1, out: 'KO: invalid speed\n' }]);
  const result = await runEmuConsole(docker, 'c', ['network', 'speed', 'lte']);
  assert.equal(result.exitCode, 1);
  assert.match(result.stdout, /invalid speed/);
  assert.equal(docker.execs.length, 1);
  await assert.rejects(runEmuConsole(fakeDocker([{ exitCode: 0 }]), 'c', ['network', 'status']), /did not confirm/);
  await assert.rejects(runEmuConsole(fakeDocker([{ exitCode: 69, err: 'No console listener' }]), 'c', ['network', 'status']),
    error => error.message.startsWith(EMU_UNAVAILABLE_PREFIX));
  await assert.rejects(runEmuConsole(fakeDocker([{ exitCode: 137 }]), 'c', ['network', 'status']), /timed out/);
  await assert.rejects(runEmuConsole(fakeDocker([]), 'c', ['network', 'status'], { timeoutMs: 1 }), /Invalid.*timeout/);
  await assert.rejects(runEmuConsole(fakeDocker([]), 'c', ['network', 'status'], { timeoutMs: 120000 }), /Invalid.*timeout/);
});

test('EnvTools calls the control op first and falls back to adb only when unavailable', async () => {
  const adbCalls = [];
  const adb = { connect: async () => {}, run: async (s, argv) => { adbCalls.push(argv); return { stdout: 'OK\n', stderr: '', exitCode: 0 }; } };
  const controlCalls = [];
  const control = { emuConsole: async (id, args) => { controlCalls.push([id, args]); return { stdout: 'OK\n', stderr: '', exitCode: 0, path: 'adb' }; } };
  await new EnvTools(adb, { control }).apply('h:5555', 'network', { profile: 'edge' }, { sessionId: SESSION });
  assert.deepEqual(controlCalls, [[SESSION, ['network', 'speed', 'edge']], [SESSION, ['network', 'delay', 'edge']]]);
  assert.equal(adbCalls.length, 0);

  const unavailable = { emuConsole: async () => { throw new Error(EMU_UNAVAILABLE_PREFIX + ' nope'); } };
  await new EnvTools(adb, { control: unavailable }).apply('h:5555', 'geo', { lat: 1, lon: 2 }, { sessionId: SESSION });
  assert.deepEqual(adbCalls, [['emu', 'geo', 'fix', '2', '1']]);
  await assert.rejects(new EnvTools(adb, { control: unavailable, emuMode: 'control' }).apply('h:5555', 'geo', { lat: 1, lon: 2 }, { sessionId: SESSION }), /unavailable in this emulator image/);
  const broken = { emuConsole: async () => { throw new Error('Session is not running on this agent'); } };
  await assert.rejects(new EnvTools(adb, { control: broken }).apply('h:5555', 'geo', { lat: 1, lon: 2 }, { sessionId: SESSION }), /not running/);
  assert.equal(adbCalls.length, 1);
  await new EnvTools(adb, { control, emuMode: 'adb' }).apply('h:5555', 'geo', { lat: 1, lon: 2 }, { sessionId: SESSION });
  assert.equal(adbCalls.length, 2);
  assert.throws(() => new EnvTools(adb, { control, emuMode: 'x' }));
});


const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash';
const bashPath = filename => process.platform === 'win32'
  ? filename.replaceAll('\\', '/').replace(/^([A-Za-z]):/, (_, drive) => '/' + drive.toLowerCase()) : filename;

// Run the actual in-container script against real TCP streams. The fixtures use
// ephemeral loopback ports; the transport test above fixes production to 5556/5554.
async function consoleLab(t, first, second = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'rdf-console-'));
  const tokenFile = path.join(directory, '.emulator_console_auth_token');
  await writeFile(tokenFile, 'fixture-console-token\n');
  const sockets = new Set();
  const received = [[], []];
  const servers = [first, second].map((scenario, index) => net.createServer(socket => {
    sockets.add(socket); socket.once('close', () => sockets.delete(socket)); socket.on('error', () => {});
    let pending = '';
    socket.on('data', data => {
      pending += data.toString('utf8');
      let newline;
      while ((newline = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, newline).replace(/\r$/, ''); pending = pending.slice(newline + 1);
        received[index].push(line);
        if (line.startsWith('auth ')) {
          const reply = scenario.authFailure ? 'KO: rejected ' + line + '\r\n' : "Android Console: type 'help' for a list of commands\r\nOK\r\n";
          socket.write(reply);
        } else if (scenario.closeOnCommand) socket.end();
        else if (!scenario.silentCommand) socket.write(scenario.commandReply ?? 'OK\r\n');
      }
    });
    if (scenario.invalidGreeting) { socket.end('HTTP/1.1 200 OK\r\nOK\r\n'); return; }
    const greeting = scenario.auth
      ? "Android Console: Authentication required\r\nAndroid Console: type 'auth <auth_token>' to authenticate\r\nAndroid Console: you can find your <auth_token> in\r\n'" + bashPath(tokenFile) + "'\r\nOK\r\n"
      : "Android Console: type 'help' for a list of commands\r\nOK\r\n";
    // Deliberately split the greeting and CRLF over packets.
    socket.write(greeting.slice(0, 18));
    setImmediate(() => { if (!socket.destroyed) socket.write(greeting.slice(18, -1)); });
    setTimeout(() => { if (!socket.destroyed) socket.write(greeting.slice(-1)); }, 10);
  }));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
    await rm(directory, { recursive: true, force: true });
  });
  for (const server of servers) await new Promise((resolve, reject) => {
    server.once('error', reject); server.listen(0, '127.0.0.1', resolve);
  });
  const ports = servers.map(server => server.address().port).join(' ');
  if (first.refuseConnection) await new Promise(resolve => servers[0].close(resolve));
  const run = (command, budget = 4) => new Promise(resolve => {
    execFile(bash, ['-c', CONSOLE_SCRIPT], {
      env: { ...process.env, EMU_CMD: command, EMU_CONSOLE_PORTS: ports, EMU_TIMEOUT_SECONDS: String(budget), HOME: bashPath(path.join(directory, 'unrelated-home')) },
      timeout: (budget + 3) * 1000, maxBuffer: 256 * 1024,
    }, (error, stdout, stderr) => resolve({ exitCode: error ? error.code : 0, stdout: stdout.replaceAll('\r', ''), stderr }));
  });
  return { run, received };
}

const protocolOptions = { skip: !existsSync(bash), timeout: 12000 };

test('Google internal console authenticates using its announced token before the network command', protocolOptions, async t => {
  const lab = await consoleLab(t, { auth: true });
  const result = await lab.run('network speed lte');
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.stdout, 'OK\n');
  assert.deepEqual(lab.received, [['auth fixture-console-token', 'network speed lte'], []]);
  assert.ok(!result.stdout.includes('fixture-console-token'));
  assert.ok(!result.stderr.includes('fixture-console-token'));
});

test('compatible second console is selected only after rejecting a non-console greeting', protocolOptions, async t => {
  const lab = await consoleLab(t, { invalidGreeting: true });
  const result = await lab.run('geo fix 37.6173 55.7558');
  assert.equal(result.exitCode, 0, result.stderr);
  assert.deepEqual(lab.received, [[], ['geo fix 37.6173 55.7558']]);
});

test('greeting OK never confirms a command whose connection closes before its reply', protocolOptions, async t => {
  const lab = await consoleLab(t, { closeOnCommand: true });
  const result = await lab.run('geo fix 1 2');
  assert.equal(result.exitCode, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /closed before confirming command/);
  assert.deepEqual(lab.received, [['geo fix 1 2'], []]);
});

test('command KO is returned without replaying the operation on another port', protocolOptions, async t => {
  const lab = await consoleLab(t, { commandReply: 'KO: speed is unavailable\r\n' });
  const result = await lab.run('network speed lte');
  assert.equal(result.exitCode, 1);
  assert.equal(result.stdout, 'KO: speed is unavailable\n');
  assert.deepEqual(lab.received, [['network speed lte'], []]);
});

test('authentication rejection prevents commands and cannot disclose a token echoed by the console', protocolOptions, async t => {
  const lab = await consoleLab(t, { auth: true, authFailure: true });
  const result = await lab.run('network status');
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /rejected authentication/);
  assert.equal(result.stdout, '');
  assert.ok(!result.stderr.includes('fixture-console-token'));
  assert.deepEqual(lab.received, [['auth fixture-console-token'], []]);
});

test('silent command is bounded by an in-container timeout, with no false success or replay', protocolOptions, async t => {
  const lab = await consoleLab(t, { silentCommand: true });
  const started = Date.now();
  const result = await lab.run('network status', 1);
  assert.ok([124, 137].includes(result.exitCode), JSON.stringify(result));
  assert.equal(result.stdout, '');
  assert.ok(Date.now() - started < 5000);
  assert.deepEqual(lab.received, [['network status'], []]);
});


test('standard 5554-style console is reached when the Google internal port is closed', protocolOptions, async t => {
  const lab = await consoleLab(t, { refuseConnection: true });
  const result = await lab.run('network status');
  assert.equal(result.exitCode, 0, result.stderr);
  assert.deepEqual(lab.received, [[], ['network status']]);
});


test('packet capture accepts only the confined bare filename', () => {
  assert.deepEqual(validateEmuConsoleArgs(['network', 'capture', 'start', 'rdf-capture.pcap']),
    ['network', 'capture', 'start', 'rdf-capture.pcap']);
  for (const file of ['/rdf-network/capture.pcap', '../rdf-capture.pcap', 'other.pcap', '/etc/passwd']) {
    assert.throws(() => validateEmuConsoleArgs(['network', 'capture', 'start', file]));
  }
});
