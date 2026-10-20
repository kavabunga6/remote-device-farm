import { access, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { agentMessage } from './messages.mjs';
import { inspectApkSet } from './generated/apk-set-guard.mjs';
export { inspectApkSet };
const invalid = () => { throw new Error(agentMessage('apps.invalidSet')); };
export async function installApkSet(adb, serial, transfer, execute, { jar = process.env.RDF_BUNDLETOOL_JAR } = {}) {
  const bundle = transfer.name.toLowerCase().endsWith('.apks');
  const entries = await inspectApkSet(transfer.local, bundle).catch(() => invalid());
  const output = path.join(transfer.directory, 'selected');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(output, { mode: 0o700 });
  const run = async (command, args, options = {}) => {
    const result = await execute(command, args, { timeoutMs: 90_000, maxOutputBytes: 64 * 1024, ...options });
    if (result.exitCode !== 0) throw new Error(agentMessage('apps.incompatibleSet'));
    return result;
  };
  let selected;
  if (bundle) {
    if (!jar || !path.isAbsolute(jar)) throw new Error(agentMessage('apps.bundletoolMissing'));
    await access(jar).catch(() => { throw new Error(agentMessage('apps.bundletoolMissing')); });
    const spec = path.join(transfer.directory, 'device.json');
    // Read the actual device, including ABI, SDK, density and locales.
    const props = await adb.run(serial, ['shell', 'getprop'], { timeoutMs: 10_000, maxOutputBytes: 128 * 1024 });
    const property = name => new RegExp('^\\[' + name.replaceAll('.', '\\.') + '\\]: \\[([^\\r\\n]*)\\]$', 'm').exec(props.stdout)?.[1];
    const sdkVersion = Number(property('ro.build.version.sdk'));
    const supportedAbis = (property('ro.product.cpu.abilist') || property('ro.product.cpu.abi') || '').split(',').filter(Boolean);
    const densityResult = await adb.run(serial, ['shell', 'wm', 'density'], { timeoutMs: 5000, maxOutputBytes: 4096 });
    const densities = [...String(densityResult.stdout).matchAll(/(?:Physical|Override) density: (\d+)/g)];
    const screenDensity = Number(densities.at(-1)?.[1]);
    const locale = await adb.run(serial, ['shell', 'settings', 'get', 'system', 'system_locales'], { timeoutMs: 5000, maxOutputBytes: 4096 });
    const supportedLocales = (String(locale.stdout).trim() === 'null' ? property('persist.sys.locale') || [property('persist.sys.language'), property('persist.sys.country')].filter(Boolean).join('-') : String(locale.stdout).trim()).split(',').filter(item => /^[a-z]{2,3}(?:[-_][A-Za-z0-9]{2,8})*$/.test(item)).map(item => item.replaceAll('_', '-'));
    if (props.exitCode || densityResult.exitCode || !Number.isInteger(sdkVersion) || sdkVersion < 1 || sdkVersion > 1000 || !supportedAbis.length || !screenDensity) throw new Error(agentMessage('apps.deviceSpecFailed'));
    await writeFile(spec, JSON.stringify({ sdkVersion, supportedAbis, screenDensity, supportedLocales: supportedLocales.length ? supportedLocales : ['en'] }), { mode: 0o600 });
    await run('java', ['-Xmx384m', '-jar', jar, 'extract-apks', '--apks=' + transfer.local, '--device-spec=' + spec, '--output-dir=' + output]);
    selected = await readdir(output);
    if (!selected.length || selected.length > 100 || selected.some(name => !/^[A-Za-z0-9_.-]+\.apk$/.test(name))) invalid();
  } else {
    selected = [];
    for (const [index, name] of entries.entries()) {
      const target = String(index).padStart(3, '0') + '.apk';
      const data = await run('unzip', ['-p', transfer.local, name], { maxOutputBytes: 256 * 1024 * 1024, encoding: null });
      await writeFile(path.join(output, target), data.stdout, { mode: 0o600 }); selected.push(target);
    }
  }
  const result = await adb.run(serial, [selected.length === 1 ? 'install' : 'install-multiple', '-r', ...selected.map(name => path.join(output, name))], { timeoutMs: 300_000, maxOutputBytes: 64 * 1024 });
  if (result.exitCode !== 0) throw new Error(agentMessage('apps.incompatibleSet'));
  return { installed: true, selectedApks: selected.length, output: result.stdout };
}
