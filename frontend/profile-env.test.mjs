import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
const bundle = await build({ entryPoints: [fileURLToPath(new URL('./src/profile-env.ts', import.meta.url))], bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent' });
const { containerEnvToText, parseContainerEnvText, ENV_VALUE_MASK } = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].contents).toString('base64'));

test('stored variable values are masked in the editor and a masked line keeps the stored value', () => {
  const text = containerEnvToText({ TOKEN: null, MODE: null });
  assert.equal(text, `TOKEN=${ENV_VALUE_MASK}\nMODE=${ENV_VALUE_MASK}`);
  assert.deepEqual(parseContainerEnvText(text).env, { TOKEN: null, MODE: null });
  assert.deepEqual(parseContainerEnvText(`TOKEN=${ENV_VALUE_MASK}\nNEW=value`).env, { TOKEN: null, NEW: 'value' });
});

test('reserved and malformed lines are rejected before anything is sent', () => {
  for (const bad of ['PATH=/x', 'ADBKEY_PUB=1', 'LD_PRELOAD=/x', 'NOEQUALS', '1A=x', 'A=1\nA=2']) assert.ok(parseContainerEnvText(bad).error, bad);
});
