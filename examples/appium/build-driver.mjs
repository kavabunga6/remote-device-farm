// Compile only the pinned driver runtime with dependencies from this lockfile.
// Git prepare would install a separate, floating upstream development toolchain.
import {createRequire} from 'node:module';
import {readFile, writeFile, rm} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
const require = createRequire(import.meta.url);
const driver = path.dirname(require.resolve('appium-uiautomator2-driver/package.json'));
const config = path.join(driver, 'tsconfig.rdf.json');
const manifest = JSON.parse(await readFile(path.join(driver, 'package.json')));
if (manifest.version !== '8.7.0') throw new Error('Unexpected UiAutomator2 source version');
await rm(path.join(driver, 'build'), {recursive: true, force: true});
try {
  await writeFile(config, JSON.stringify({
    extends: require.resolve('@appium/tsconfig/tsconfig.json'),
    compilerOptions: {esModuleInterop: true, outDir: 'build', strict: true, checkJs: true,
      types: ['node'], module: 'NodeNext', moduleResolution: 'NodeNext', rootDir: '.',
      incremental: false, composite: false},
    include: ['lib'],
  }));
  const result = spawnSync(process.execPath, [require.resolve('typescript/bin/tsc'), '--project', config], {stdio: 'inherit'});
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error('UiAutomator2 runtime compilation failed');
} finally { await rm(config, {force: true}); }
const {AndroidUiautomator2Driver} = await import('appium-uiautomator2-driver');
if (typeof AndroidUiautomator2Driver !== 'function') throw new Error('UiAutomator2 runtime did not load');
