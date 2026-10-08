#!/usr/bin/env node
// A small in-memory Android phone behind an `adb` command, for testing scripts that drive adb.
// State lives in the JSON file named by FAKE_ADB_STATE; every invocation loads, mutates and saves it.
import { readFileSync, writeFileSync } from 'node:fs';

const file = process.env.FAKE_ADB_STATE;
const s = JSON.parse(readFileSync(file, 'utf8'));
const save = () => writeFileSync(file, JSON.stringify(s));
const out = (text = '') => { process.stdout.write(text.endsWith('\n') || text === '' ? text : text + '\n'); };
const fail = (text, code = 1) => { process.stderr.write(text + '\n'); save(); process.exit(code); };

let args = process.argv.slice(2);
if (args[0] === '-s') args = args.slice(2);
(s.log ??= []).push(args.join(' '));

function shell(cmd) {
  let m;
  if ((m = /^getprop (\S+)$/.exec(cmd))) {
    const v = { 'sys.boot_completed': s.bootCompleted === false ? '' : '1', 'ro.build.fingerprint': s.fingerprint, 'gsm.sim.state': s.simState }[m[1]] ?? s.props?.[m[1]] ?? '';
    return out(v);
  }
  if ((m = /^settings list (global|secure|system)$/.exec(cmd))) return out(Object.entries(s.settings[m[1]]).map(([k, v]) => `${k}=${v}`).join('\n'));
  if ((m = /^settings put (global|secure|system) (\S+) '?(.*?)'?$/.exec(cmd))) { s.settings[m[1]][m[2]] = m[3].replace(/'\\''/g, "'"); return; }
  if ((m = /^settings get (global|secure|system) (\S+)$/.exec(cmd))) return out(s.settings[m[1]][m[2]] ?? 'null');
  if ((m = /^settings delete (global|secure|system) (\S+)$/.exec(cmd))) { delete s.settings[m[1]][m[2]]; return; }
  if (cmd === 'pm list packages') return out(Object.keys(s.packages).filter((p) => !s.packages[p].removed).map((p) => 'package:' + p).join('\n'));
  if (cmd === 'pm list packages -d') return out(Object.keys(s.packages).filter((p) => s.packages[p].disabled && !s.packages[p].removed).map((p) => 'package:' + p).join('\n'));
  if (cmd === 'pm list packages -3') return out(Object.keys(s.packages).filter((p) => s.packages[p].user && !s.packages[p].removed).map((p) => 'package:' + p).join('\n'));
  if ((m = /^pm uninstall (\S+)$/.exec(cmd))) {
    if (!s.packages[m[1]]?.user) return fail('Failure [DELETE_FAILED_INTERNAL_ERROR]');
    delete s.packages[m[1]]; return out('Success');
  }
  if ((m = /^pm install-existing --user 0 (\S+)$/.exec(cmd))) { if (s.packages[m[1]]) s.packages[m[1]].removed = false; return out('Package installed'); }
  if ((m = /^pm enable (\S+)$/.exec(cmd))) { s.packages[m[1]].disabled = false; return out('enabled'); }
  if ((m = /^pm disable-user --user 0 (\S+)$/.exec(cmd))) { s.packages[m[1]].disabled = true; return out('disabled'); }
  if ((m = /^pm clear (\S+)$/.exec(cmd))) { if (s.packages[m[1]]) s.packages[m[1]].dirtyData = false; (s.cleared ??= []).push(m[1]); return out('Success'); }
  if (cmd === 'pm reset-permissions' || cmd === 'appops reset --user 0') return;
  if (cmd === 'pm list users') return out('Users:\n' + s.users.map((u) => `\tUserInfo{${u}:${u === 0 ? 'Owner' : 'Guest'}:c13} running`).join('\n'));
  if ((m = /^pm remove-user (\d+)$/.exec(cmd))) { s.users = s.users.filter((u) => u !== Number(m[1])); return out('Success: removed user'); }
  if (cmd === 'cmd wifi list-networks') return out('Network Id      SSID                         Security type\n' + s.wifi.map((w) => `${String(w.id).padEnd(15)} ${w.ssid.padEnd(28)} wpa2`).join('\n'));
  if ((m = /^cmd wifi forget-network (\d+)$/.exec(cmd))) { s.wifi = s.wifi.filter((w) => w.id !== Number(m[1])); return out('forget-network successful'); }
  if (cmd === 'dumpsys account') return out(`ACCOUNT MANAGER (dumpsys account)\n  User UserInfo{0:Owner:c13}:\n  Accounts: ${s.accounts}`);
  if (cmd === 'locksettings get-disabled') return out(s.lockDisabled ? 'true' : 'false');
  if (cmd === 'ls -A /sdcard') return out(s.sdcard.join('\n'));
  if (cmd === 'ls -A /data/local/tmp') return out(s.tmp.join('\n'));
  if (cmd === 'find /sdcard -mindepth 1 -maxdepth 1 ! -name Android -exec rm -rf {} +') { s.sdcard = s.sdcard.filter((n) => n === 'Android'); return; }
  if (cmd.startsWith('rm -rf /sdcard/Android/data/*')) return;
  if (cmd === 'find /data/local/tmp -mindepth 1 -maxdepth 1 -exec rm -rf {} +') { s.tmp = []; return; }
  if (cmd === 'input keyevent 3' || cmd === 'logcat -b all -c') return;
  // used by the agent-side verification of the command wipe strategy
  if (cmd === 'cat /proc/sys/kernel/random/boot_id') return out('boot-' + s.boot);
  if ((m = /^echo (\S+) > (\S+) && echo \S+ > (\S+)$/.exec(cmd))) {
    for (const p of [m[2], m[3]]) (p.startsWith('/sdcard/') ? s.sdcard : s.tmp).push(p.split('/').pop());
    return;
  }
  if ((m = /^\[ -e (\S+) \] && echo present \|\| echo absent$/.exec(cmd))) return out((m[1].startsWith('/sdcard/') ? s.sdcard : s.tmp).includes(m[1].split('/').pop()) ? 'present' : 'absent');
  return fail(`fake adb: unsupported shell command: ${cmd}`, 127);
}

const [verb, ...rest] = args;
if (verb === 'wait-for-device' || verb === 'get-state' || verb === 'start-server') { /* attached */ }
else if (verb === 'forward' || verb === 'reverse') { /* nothing to remove */ }
else if (verb === 'reboot') {
  s.boot += 1;
  if (s.settings.global.boot_count !== undefined) s.settings.global.boot_count = String(Number(s.settings.global.boot_count) + 1);
  if (s.afterReboot) for (const [k, v] of Object.entries(s.afterReboot)) s.settings.global[k] = v; // volatile values
}
else if (verb === 'shell') shell(rest.join(' '));
else fail(`fake adb: unsupported command: ${args.join(' ')}`, 127);
save();
