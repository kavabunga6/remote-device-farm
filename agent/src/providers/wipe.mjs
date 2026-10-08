// Device sanitizing strategies. Contract: `wipe(id)` does the reset, `verify(id)` independently checks the
// result; a strategy is successful only when both pass. Any throw means "NOT clean" and the caller quarantines.

import { randomBytes } from 'node:crypto';

const CANARY_KEY = 'rdf_wipe_canary';
const CANARY_FILES = ['/data/local/tmp/.rdf-canary', '/sdcard/.rdf-canary'];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function sh(adb, serial, argv, timeoutMs = 30000) {
  const result = await adb.run(serial, argv, { timeoutMs });
  if (result.exitCode !== 0) throw new Error(`adb ${argv.slice(0, 3).join(' ')} failed: ${(result.stderr || result.stdout || '').trim().slice(0, 200)}`);
  return String(result.stdout);
}

const thirdParty = async (adb, serial) => (await sh(adb, serial, ['shell', 'pm', 'list', 'packages', '-3']))
  .split(/\r?\n/).map((l) => l.replace(/^package:/, '').trim()).filter(Boolean);

// Independent verification after a full reset; this is not a wipe strategy.
export async function assertEmptyUserArea(adb, serial) {
  const apps = await thirdParty(adb, serial);
  if (apps.length) throw new Error(`Wipe verification failed: ${apps.length} user app(s) remain`);
  const files = (await sh(adb, serial, ['shell', 'ls -A /sdcard'])).split(/\r?\n/).map(x => x.trim()).filter(x => x && x !== 'Android');
  if (files.length) throw new Error(`Wipe verification failed: ${files.length} item(s) remain in shared storage`);
}

// Full reset delegated to an admin-supplied script (golden-image flash over fastboot, Android Enterprise
// zero-touch, Knox, recovery with a pre-baked adb key, ...). A bare factory reset is NOT enough: it drops adb
// authorization and leaves the phone in the setup wizard, which would need hands-on work for every rental.
// So the contract is "wipe AND re-provision": the script gets the serial as argv[1] and must exit 0 only when
// the phone is back with adb authorized for this agent and setup skipped. We do not trust the exit code alone:
// verification demands a new boot_id (it really rebooted), completed setup, and an empty user area.
export class CommandAndroidWipe {
  constructor(adb, execute, { command, timeoutMs = 20 * 60_000, readyMs = 5 * 60_000, pollMs = 3000 }) {
    assertAbsoluteCommand(command, 'AGENT_USB_WIPE_CMD');
    Object.assign(this, { adb, execute, command, timeoutMs, readyMs, pollMs, name: 'command', boot: new Map() });
  }

  // Canaries detect a reset that did not remove basic user state. They are necessary checks,
  // not proof of cryptographic erasure: an explicitly trusted full reset/reprovision script
  // must perform the real wipe, not just delete these settings and files.
  async arm(serial) {
    const nonce = randomBytes(16).toString('hex');
    await sh(this.adb, serial, ['shell', 'settings', 'put', 'global', CANARY_KEY, nonce]);
    await sh(this.adb, serial, ['shell', `echo ${nonce} > ${CANARY_FILES[0]} && echo ${nonce} > ${CANARY_FILES[1]}`]);
    if ((await sh(this.adb, serial, ['shell', 'settings', 'get', 'global', CANARY_KEY])).trim() !== nonce) throw new Error('Could not plant the wipe canary');
    return nonce;
  }

  async wipe(serial, ctx = {}) {
    if (!ctx.canary) ctx.canary = await this.arm(serial); // enrollment / manual sanitize / unplugged during a session
    this.boot.set(serial, (await sh(this.adb, serial, ['shell', 'cat', '/proc/sys/kernel/random/boot_id'])).trim());
    const r = await this.execute(this.command, [serial], { timeoutMs: this.timeoutMs });
    if (r.exitCode !== 0) throw new Error(`Wipe script failed (exit ${r.exitCode}): ${String(r.stderr).trim().slice(0, 200)}`);
  }

  cleanup(serial) { this.boot.delete(serial); }

  async verify(serial, ctx = {}) {
    if (!ctx.canary) throw new Error('No wipe canary was recorded for this device');
    const before = this.boot.get(serial);
    if (!before) throw new Error('Wipe was not started');
    const deadline = Date.now() + this.readyMs;
    let boot = null;
    while (Date.now() < deadline) {
      const result = await this.adb.run(serial, ['shell', 'cat', '/proc/sys/kernel/random/boot_id'], { timeoutMs: 5000 }).catch(() => null);
      if (result?.exitCode === 0) { boot = String(result.stdout).trim(); break; }
      await sleep(this.pollMs);
    }
    if (!boot) throw new Error('Device is not ready (adb unavailable or unauthorized) after the wipe script');
    if (boot === before) throw new Error('Wipe verification failed: device did not reboot');
    const setup = (await sh(this.adb, serial, ['shell', 'settings', 'get', 'secure', 'user_setup_complete'])).trim();
    if (setup !== '1') throw new Error('Device is still in the setup wizard after the wipe script');
    this.boot.delete(serial);
    const left = (await sh(this.adb, serial, ['shell', 'settings', 'get', 'global', CANARY_KEY])).trim();
    if (left !== 'null' && left !== '') throw new Error('Wipe verification failed: the data partition was not erased (canary setting survived)');
    for (const file of CANARY_FILES) {
      const r = await this.adb.run(serial, ['shell', `[ -e ${file} ] && echo present || echo absent`], { timeoutMs: 10000 });
      if (r.exitCode !== 0 || String(r.stdout).trim() !== 'absent') throw new Error('Wipe verification failed: the data partition was not erased (canary file survived)');
    }
    await assertEmptyUserArea(this.adb, serial);
  }
}

function assertAbsoluteCommand(command, name) {
  if (typeof command !== 'string' || !command.startsWith('/') || /[\0\r\n]/.test(command)) throw new Error(`${name} must be an absolute path`);
}

// Runs wipe then verify; resolves {ok:true} or {ok:false, reason}. Never throws, so callers can always continue
// tearing the session down. `ctx` is shared by both steps (e.g. the canary).
export async function sanitize(wiper, id, ctx = {}) {
  try { await wiper.wipe(id, ctx); await wiper.verify(id, ctx); return { ok: true }; }
  catch (error) { return { ok: false, reason: String(error.message || 'wipe failed').replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 300) }; }
  finally { wiper.cleanup?.(id); }
}
