import assert from 'node:assert/strict';
import test from 'node:test';
import { assertProfileHostArchitecture } from '../src/profile-host.js';

test('declared Android ABI requires a compatible host and allows unknown legacy metadata', () => {
  for (const arch of ['x64','x86_64','amd64']) {
    assert.doesNotThrow(() => assertProfileHostArchitecture({ abi: 'x86' }, { architecture: arch }));
    assert.doesNotThrow(() => assertProfileHostArchitecture({ abi: 'x86_64, arm64-v8a' }, { architecture: arch }));
    assert.throws(() => assertProfileHostArchitecture({ abi: 'arm64-v8a' }, { architecture: arch }), /architecture/);
  }
  assert.doesNotThrow(() => assertProfileHostArchitecture({ abi: 'arm64-v8a' }, { architecture: 'arm64' }));
  assert.throws(() => assertProfileHostArchitecture({ abi: 'x86_64' }, { architecture: 'aarch64' }), /architecture/);
  assert.doesNotThrow(() => assertProfileHostArchitecture({}, { architecture: 'x64' }));
  assert.doesNotThrow(() => assertProfileHostArchitecture({ abi: 'x86_64' }));
});
