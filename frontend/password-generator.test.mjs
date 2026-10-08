import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const bundle = await build({ entryPoints: [fileURLToPath(new URL('./src/password-generator.ts', import.meta.url))], bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent' });
const { generatePassword } = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].contents).toString('base64'));

test('generated passwords have 20 characters, every character category and fresh random values', () => {
  const passwords = Array.from({ length: 100 }, generatePassword);
  assert.equal(new Set(passwords).size, 100);
  for (const password of passwords) {
    assert.equal(password.length, 20);
    for (const pattern of [/[A-Z]/, /[a-z]/, /[2-9]/, /[!@#$%^&*?]/]) assert.match(password, pattern);
    assert.doesNotMatch(password, /[IOilo01\s]/);
  }
});

test('rejects a sample missing character categories and never falls back when secure randomness fails', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  let samples = 0;
  try {
    Object.defineProperty(globalThis, 'crypto', { configurable: true, value: { getRandomValues(bytes) {
      samples++; bytes.fill(0);
      if (samples > 1) bytes.set([0, 24, 47, 55]);
      return bytes;
    } } });
    assert.equal(generatePassword().length, 20); assert.equal(samples, 2);
    Object.defineProperty(globalThis, 'crypto', { configurable: true, value: { getRandomValues() { throw new Error('secure randomness unavailable'); } } });
    assert.throws(generatePassword, /secure randomness unavailable/);
  } finally { Object.defineProperty(globalThis, 'crypto', original); }
});
