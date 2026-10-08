import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('homelab split keeps the existing ADB key source read-only and gives Docker socket only to control', async () => {
  const compose = (await readFile(new URL('../../deploy/homelab/compose.yaml', import.meta.url), 'utf8')).replaceAll('\r\n', '\n');
  const importer = compose.split('  agent-key-import:\n')[1]?.split('  agent-control:\n')[0];
  const control = compose.split('  agent-control:\n')[1]?.split('  agent:\n')[0];
  const io = compose.split('  agent:\n')[1]?.split('\nnetworks:\n')[0];
  assert.ok(importer && control && io);
  assert.match(importer, /source: \/opt\/device-farm\/data\/agent-android\/adbkey\n/);
  assert.match(importer, /source: \/opt\/device-farm\/data\/agent-android\/adbkey\.pub\n/);
  assert.equal((importer.match(/create_host_path: false/g) || []).length, 2);
  assert.match(importer, /entrypoint: \["node", "src\/import-legacy-key\.mjs"\]/);
  assert.doesNotMatch(importer, /docker\.sock/);
  assert.match(control, /\/var\/run\/docker\.sock:\/var\/run\/docker\.sock/);
  assert.match(control, /agent_image_builds:\/var\/lib\/rdf-image-builds/);
  assert.match(control, /AGENT_IMAGE_BUILD_STATE_DIR: \/var\/lib\/rdf-image-builds/);
  assert.match(io, /user: "10001:10001"/);
  assert.match(io, /agent_adb_keys:\/home\/agent\/\.android/);
  assert.match(io, /agent_control_ipc:\/run\/agent-control:ro/);
  assert.doesNotMatch(io, /docker\.sock|\/dev\/kvm|\/root\/\.android/);
});

test('repository and downloadable agent compose persist the build ledger only in the control container', async () => {
  for (const path of ['../../compose.agent.yaml', '../compose.bundle.yaml']) {
    const compose = (await readFile(new URL(path, import.meta.url), 'utf8')).replaceAll('\r\n', '\n');
    const control = compose.split('  agent-control:\n')[1]?.split('  agent:\n')[0];
    const io = compose.split('  agent:\n')[1]?.split('\nvolumes:\n')[0];
    assert.match(control, /agent_image_builds:\/var\/lib\/rdf-image-builds/);
    assert.match(control, /AGENT_IMAGE_BUILD_STATE_DIR: \/var\/lib\/rdf-image-builds/);
    assert.doesNotMatch(io, /agent_image_builds|docker\.sock/);
  }
});
