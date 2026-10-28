import { diagnostic } from './diagnostics.mjs';
const DIGEST = /^sha256:[0-9a-f]{64}$/;

/** Only consume the completed push result for this tag, never layer IDs or local RepoDigests. */
export function emulatorPushDigest(event, tag) {
  if (typeof event.aux?.Digest === 'string') {
    if (!DIGEST.test(event.aux.Digest)) throw new Error(diagnostic('emulator-push-digest.7e3a5b8202'));
    if (event.aux.Tag != null && event.aux.Tag !== tag) return null;
    return event.aux.Digest;
  }
  // The containerd push backend emits its final digest in status instead of aux.
  // https://github.com/moby/moby/issues/48331
  const result = typeof event.status === 'string'
    ? /^(\S+): digest: (sha256:[0-9a-f]{64}) size: [0-9]+$/.exec(event.status)
    : null;
  return result?.[1] === tag ? result[2] : null;
}
