import test from 'node:test';
import assert from 'node:assert/strict';
import { EmulatorImages } from './emulator-images.mjs';
import { emulatorPushDigest } from './emulator-push-digest.mjs';

const tag = '36-aosp_atd-x86_64';
const digest = 'sha256:be47f3770e2b2ee24a57c41542ad621d3d5d611c5c2f4b9adc20ac51738205c4';
const finalStatus = tag + ': digest: ' + digest + ' size: 1858';
const images = (events, error) => new EmulatorImages({ docker: {
  async request(method, path, _body, options) {
    assert.equal(method, 'POST');
    assert.equal(path, '/images/farm.example%2Frdf-emulator/push?tag=' + tag);
    for (const event of events) options.onJsonEvent(event);
    if (error) throw error;
  },
} });

test('classic and containerd final push events identify the same digest', async () => {
  for (const event of [{ aux: { Tag: tag, Digest: digest, Size: 1858 } }, { status: finalStatus }]) {
    assert.equal(emulatorPushDigest(event, tag), digest);
    assert.equal(await images([{ status: 'Pushed', id: 'layer' }, event]).push('farm.example/rdf-emulator:' + tag), digest);
  }
});

test('layer IDs, another tag, partial output and malformed results are not a successful push', async () => {
  for (const event of [
    { id: digest, status: 'Pushed' }, { aux: { Tag: 'other', Digest: digest } },
    { status: 'other: digest: ' + digest + ' size: 1858' },
    { status: tag + ': digest: ' + digest }, { status: 'error: ' + finalStatus },
  ]) {
    assert.equal(emulatorPushDigest(event, tag), null);
    await assert.rejects(images([event]).push('farm.example/rdf-emulator:' + tag), /did not report an image digest/);
  }
  assert.throws(() => emulatorPushDigest({ aux: { Digest: 'sha256:invalid' } }, tag), /invalid image digest/);
});

test('a later push error or conflicting final digest cannot be reported as success', async () => {
  await assert.rejects(images([{ status: finalStatus }], new Error('upload interrupted'))
    .push('farm.example/rdf-emulator:' + tag), /upload interrupted/);
  await assert.rejects(images([{ status: finalStatus }, { aux: { Tag: tag, Digest: 'sha256:' + 'a'.repeat(64) } }])
    .push('farm.example/rdf-emulator:' + tag), /conflicting image digests/);
});
